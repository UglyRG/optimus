"""Transactional purchase drafts, private originals, and encrypted portable snapshots."""
import base64
import hashlib
import io
import json
import os
import warnings
from pathlib import Path
from uuid import uuid4

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from PIL import Image
from pypdf import PdfReader

from ..utils import now_iso
from . import domain

MAX_FILE = 25 * 1024 * 1024
LOCK_ID = 731448223
TABLES = ("mydata_companies", "mydata_documents", "mydata_invoices", "mydata_audit_events", "mydata_extractions")


def inspect_file(data, filename):
    suffix = Path(filename).suffix.lower()
    try:
        if suffix == ".pdf" and data.startswith(b"%PDF-"):
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                domain.fail("Password-protected PDFs are not supported; upload an unlocked copy")
            count = len(reader.pages)
            if not 1 <= count <= 30:
                domain.fail("PDFs must contain between 1 and 30 pages")
            return "application/pdf", count
        image_type = "PNG" if suffix == ".png" else "JPEG" if suffix in {".jpg", ".jpeg"} else None
        if image_type:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    if image.format != image_type or image.width * image.height > 30_000_000:
                        domain.fail("Image type does not match its extension or exceeds 30 megapixels")
                    image.verify()
            return "image/png" if image_type == "PNG" else "image/jpeg", 1
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(400, "The document is corrupt or cannot be read") from exc
    domain.fail("Choose a PDF, JPEG or PNG with a matching file extension")


class MydataRepository:
    def __init__(self, store, settings):
        self.store = store
        self.directory = settings.data_dir / "mydata"
        self.key_path = settings.data_dir / ".mydata.key"

    def ensure_schema(self):
        path = Path(__file__).resolve().parents[2] / "sql" / "002_mydata.sql"
        with self.store.pool.connection() as connection, connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_ID,))
            connection.execute(path.read_text())

    def key(self, create=False):
        try:
            value = self.key_path.read_bytes()
        except FileNotFoundError:
            if not create:
                raise HTTPException(503, "myDATA storage is locked. Restore data/.mydata.key from secure storage.")
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            value = AESGCM.generate_key(bit_length=256)
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return self.key()
            with os.fdopen(fd, "wb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
        if len(value) != 32:
            raise HTTPException(503, "Invalid myDATA encryption key")
        return value

    def encrypt(self, content, context):
        nonce = os.urandom(12)
        return nonce + AESGCM(self.key()).encrypt(nonce, content, context.encode())

    def decrypt(self, content, context):
        try:
            return AESGCM(self.key()).decrypt(content[:12], content[12:], context.encode())
        except (InvalidTag, ValueError) as exc:
            raise HTTPException(400, "Cannot unlock myDATA data: wrong key or damaged content") from exc

    def store_file(self, doc_id, content):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        encrypted = self.encrypt(content, "mydata:document:" + doc_id)
        storage_id = str(uuid4())
        path = self.directory / storage_id
        try:
            with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as handle:
                handle.write(encrypted)
                handle.flush()
                os.fsync(handle.fileno())
        except Exception:
            path.unlink(missing_ok=True)
            raise
        return storage_id

    def read_file(self, row):
        storage_id = domain.identifier(row["facts"]["storageId"])
        try:
            value = self.decrypt((self.directory / storage_id).read_bytes(), "mydata:document:" + row["id"])
        except FileNotFoundError as exc:
            raise HTTPException(503, "The original document is missing; restore it from a myDATA backup") from exc
        if hashlib.sha256(value).hexdigest() != row["sha256"]:
            raise HTTPException(400, "Original document checksum mismatch")
        return value

    @staticmethod
    def lock(connection):
        connection.execute("SELECT pg_advisory_xact_lock(%s)", (LOCK_ID,))

    @staticmethod
    def require_company(connection, company_id):
        row = connection.execute("SELECT * FROM mydata_companies WHERE id = %s", (company_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Company not found")
        return row

    @staticmethod
    def present(row):
        result = {**row["facts"], "id": row["id"], "revision": row["revision"]}
        if "extraction_state" in row:
            result["extractionState"] = row["extraction_state"]
        return result

    @staticmethod
    def audit(connection, company_id, entity_id, action, actor, snapshot):
        connection.execute("INSERT INTO mydata_audit_events VALUES (%s, %s, %s, %s::jsonb)",
                           (str(uuid4()), company_id, entity_id,
                            json.dumps({"action": action, "actor": actor, "at": now_iso(), "snapshot": snapshot})))

    def audit_lookup(self, job, result):
        with self.store.pool.connection() as connection, connection.transaction():
            self.lock(connection)
            # A restore/cancel can remove the job while a provider request is in flight.
            current = connection.execute("SELECT id FROM mydata_extractions WHERE id=%s AND state='running'", (job["id"],)).fetchone()
            if current:
                self.audit(connection, job["company_id"], job["invoice_id"], "qr_lookup_completed", job["facts"]["requestedBy"],
                           {"extractionId": job["id"], "status": result["status"], "source": "provider", "aadeVerified": False,
                            "responseHash": result["data"]["responseHash"]})

    def companies(self):
        with self.store.pool.connection() as connection:
            rows = connection.execute("SELECT * FROM mydata_companies ORDER BY facts->>'name', id").fetchall()
        return [self.present(row) for row in rows]

    def save_company(self, payload, actor):
        facts = domain.company(payload)
        record_id = domain.identifier(payload["id"]) if payload.get("id") else str(uuid4())
        with self.store.pool.connection() as connection, connection.transaction():
            self.lock(connection)
            rows = connection.execute("SELECT * FROM mydata_companies").fetchall()
            previous = next((row for row in rows if row["id"] == record_id), None)
            if payload.get("id") and (not previous or previous["revision"] != payload.get("revision")):
                raise HTTPException(409, "Company changed elsewhere. Reload before saving.")
            if not previous and len(rows) >= 3:
                domain.fail("This workspace supports three companies. Edit an existing company instead.")
            if facts["vatNumber"] and any(row["id"] != record_id and row["facts"]["vatNumber"] == facts["vatNumber"] for row in rows):
                domain.fail("A company with this ΑΦΜ already exists")
            self.key(create=not rows)
            revision = str(uuid4())
            connection.execute("INSERT INTO mydata_companies VALUES (%s, %s::jsonb, %s) "
                               "ON CONFLICT(id) DO UPDATE SET facts=excluded.facts, revision=excluded.revision",
                               (record_id, json.dumps(facts), revision))
            self.audit(connection, record_id, record_id, "company_saved", actor, {**facts, "revision": revision})
        return {**facts, "id": record_id, "revision": revision}

    def invoices(self, company_id, start, end, offset=0, status="all"):
        if status not in {"all", "needs_review", "reviewed"}:
            domain.fail("Invalid review filter")
        clause = {"all": "", "needs_review": " AND facts->>'reviewed' IS DISTINCT FROM 'true'",
                  "reviewed": " AND facts->>'reviewed'='true'"}[status]
        domain.identifier(company_id)
        start, end = domain.month(start), domain.month(end)
        if start > end:
            domain.fail("The start period must precede the end period")
        with self.store.pool.connection() as connection:
            self.require_company(connection, company_id)
            params = (company_id, start, end)
            total = connection.execute("SELECT count(*) AS count FROM mydata_invoices WHERE company_id=%s "
                                       "AND review_month BETWEEN %s AND %s" + clause, params).fetchone()["count"]
            rows = connection.execute("SELECT *, (SELECT e.state FROM mydata_extractions e WHERE e.invoice_id=mydata_invoices.id "
                                      "ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS extraction_state "
                                      "FROM mydata_invoices WHERE company_id=%s AND review_month BETWEEN %s AND %s "
                                      + clause + " ORDER BY review_month DESC, id LIMIT 100 OFFSET %s", (*params, offset)).fetchall()
            counts = connection.execute("SELECT company_id, count(*) AS total, "
                                        "count(*) FILTER (WHERE facts->>'reviewed'='true') AS reviewed "
                                        "FROM mydata_invoices WHERE review_month BETWEEN %s AND %s GROUP BY company_id",
                                        (start, end)).fetchall()
        return {"invoices": [self.present(row) for row in rows], "total": total,
                "progress": {row["company_id"]: {"total": row["total"], "reviewed": row["reviewed"]} for row in counts}}

    def save_invoice(self, company_id, payload, actor):
        company_id = domain.identifier(company_id)
        facts = domain.invoice(payload)
        record_id = domain.identifier(payload["id"]) if payload.get("id") else str(uuid4())
        with self.store.pool.connection() as connection, connection.transaction():
            self.lock(connection)
            self.require_company(connection, company_id)
            previous = connection.execute("SELECT * FROM mydata_invoices WHERE id=%s AND company_id=%s",
                                          (record_id, company_id)).fetchone()
            if payload.get("id") and (not previous or previous["revision"] != payload.get("revision")):
                raise HTTPException(409, "Purchase changed elsewhere or was restored. Reload before saving.")
            reviewed = payload.get("markReviewed") is True
            issues = domain.review_issues(facts)
            if reviewed and issues:
                domain.fail("Resolve these before marking reviewed: " + "; ".join(issues))
            facts.update(reviewed=reviewed, reviewedAt=now_iso() if reviewed else None,
                         reviewedBy=actor if reviewed else None, issues=issues, updatedAt=now_iso(),
                         createdAt=previous["facts"]["createdAt"] if previous else now_iso(),
                         documentId=previous["document_id"] if previous else None,
                         filename=previous["facts"].get("filename", "") if previous else "",
                         extractionId=previous["facts"].get("extractionId") if previous else None,
                         extractionAppliedFields=previous["facts"].get("extractionAppliedFields", []) if previous else [])
            revision = str(uuid4())
            connection.execute("INSERT INTO mydata_invoices VALUES (%s,%s,%s,%s,%s::jsonb,%s) "
                               "ON CONFLICT(id) DO UPDATE SET review_month=excluded.review_month, "
                               "facts=excluded.facts, revision=excluded.revision",
                               (record_id, company_id, facts["documentId"], facts["reviewMonth"], json.dumps(facts), revision))
            self.audit(connection, company_id, record_id, "purchase_reviewed" if reviewed else "draft_saved", actor,
                       {**facts, "revision": revision})
        return {**facts, "id": record_id, "revision": revision}

    def upload(self, company_id, review_month, filename, data, actor):
        company_id, review_month = domain.identifier(company_id), domain.month(review_month)
        filename = Path(filename.replace("\\", "/")).name[:200]
        if not data or len(data) > MAX_FILE:
            domain.fail("Documents must be nonempty and no larger than 25 MB")
        mime, pages = inspect_file(data, filename)
        digest, doc_id, storage_id = hashlib.sha256(data).hexdigest(), str(uuid4()), None
        try:
            with self.store.pool.connection() as connection, connection.transaction():
                self.lock(connection)
                self.require_company(connection, company_id)
                existing = connection.execute("SELECT i.* FROM mydata_documents d JOIN mydata_invoices i ON i.document_id=d.id "
                                              "WHERE d.company_id=%s AND d.sha256=%s", (company_id, digest)).fetchone()
                if existing:
                    return {"invoice": self.present(existing), "duplicate": True}
                storage_id = self.store_file(doc_id, data)
                connection.execute("INSERT INTO mydata_documents VALUES (%s,%s,%s,%s::jsonb)",
                                   (doc_id, company_id, digest, json.dumps({"filename": filename, "mime": mime,
                                    "pages": pages, "bytes": len(data), "storageId": storage_id})))
                facts = domain.invoice({"reviewMonth": review_month, "description": "", "currency": "EUR"})
                facts.update(documentId=doc_id, filename=filename, reviewed=False, reviewedAt=None, reviewedBy=None,
                             createdAt=now_iso(), updatedAt=now_iso(), issues=domain.review_issues(facts))
                record_id, revision = str(uuid4()), str(uuid4())
                connection.execute("INSERT INTO mydata_invoices VALUES (%s,%s,%s,%s,%s::jsonb,%s)",
                                   (record_id, company_id, doc_id, review_month, json.dumps(facts), revision))
                self.audit(connection, company_id, record_id, "document_uploaded", actor, {**facts, "revision": revision})
            return {"invoice": {**facts, "id": record_id, "revision": revision}, "duplicate": False}
        except Exception:
            if storage_id:
                (self.directory / storage_id).unlink(missing_ok=True)
            raise

    def document(self, company_id, doc_id):
        domain.identifier(company_id)
        domain.identifier(doc_id)
        with self.store.pool.connection() as connection:
            row = connection.execute("SELECT * FROM mydata_documents WHERE company_id=%s AND id=%s",
                                     (company_id, doc_id)).fetchone()
        if not row:
            raise HTTPException(404, "Document not found")
        return self.read_file(row), row["facts"]

    def history(self, company_id, invoice_id):
        domain.identifier(company_id)
        domain.identifier(invoice_id)
        with self.store.pool.connection() as connection:
            return [row["facts"] for row in connection.execute(
                "SELECT facts FROM mydata_audit_events WHERE company_id=%s AND entity_id=%s "
                "ORDER BY facts->>'at' DESC", (company_id, invoice_id)).fetchall()]

    def backup(self):
        with self.store.pool.connection() as connection, connection.transaction():
            self.lock(connection)
            snapshot = {table: connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall() for table in TABLES}
            if not snapshot["mydata_companies"]:
                return None
            for row in snapshot["mydata_documents"]:
                row["content"] = base64.b64encode(self.read_file(row)).decode()
            for row in snapshot["mydata_extractions"]:
                row["created_at"] = row["created_at"].isoformat()
                row["lease_until"] = None
            snapshot.update(version=1, purpose="preparation-only", productionWrites=False)
            encrypted = self.encrypt(json.dumps(snapshot).encode(), "mydata:backup:v1")
        return {"version": 1, "algorithm": "AES-256-GCM", "ciphertext": base64.b64encode(encrypted).decode()}

    def validate_backup(self, envelope):
        if not isinstance(envelope, dict) or envelope.get("version") != 1 or envelope.get("algorithm") != "AES-256-GCM":
            domain.fail("Unsupported myDATA backup")
        try:
            snapshot = json.loads(self.decrypt(base64.b64decode(envelope["ciphertext"], validate=True), "mydata:backup:v1"))
            if snapshot["version"] != 1 or snapshot["purpose"] != "preparation-only":
                domain.fail("Unsupported myDATA snapshot")
            snapshot.setdefault("mydata_extractions", [])  # Version-1 archives before extraction support.
            ids = {}
            for table in TABLES:
                rows = snapshot[table]
                if not isinstance(rows, list):
                    domain.fail("Invalid myDATA snapshot table")
                ids[table] = {domain.identifier(row["id"]) for row in rows}
                if len(ids[table]) != len(rows):
                    domain.fail("Duplicate records in myDATA snapshot")
            if len(ids["mydata_companies"]) > 3:
                domain.fail("A maximum of three companies is supported")
            for row in snapshot["mydata_companies"]:
                domain.company(row["facts"])
                domain.identifier(row["revision"])
            docs = {row["id"]: row for row in snapshot["mydata_documents"]}
            for table in TABLES[1:]:
                for row in snapshot[table]:
                    if row["company_id"] not in ids["mydata_companies"]:
                        domain.fail("Invalid company reference in myDATA snapshot")
            for row in docs.values():
                value = base64.b64decode(row["content"], validate=True)
                if not value or len(value) > MAX_FILE or hashlib.sha256(value).hexdigest() != row["sha256"]:
                    domain.fail("Original document checksum mismatch")
                mime, pages = inspect_file(value, row["facts"]["filename"])
                if mime != row["facts"]["mime"] or pages != row["facts"]["pages"]:
                    domain.fail("Original document metadata mismatch")
            for row in snapshot["mydata_extractions"]:
                if row["invoice_id"] not in ids["mydata_invoices"] or row["state"] not in {"queued", "running", "completed", "failed", "cancelled"}:
                    domain.fail("Invalid extraction reference in myDATA snapshot")
                invoice_row = next(item for item in snapshot["mydata_invoices"] if item["id"] == row["invoice_id"])
                if invoice_row["company_id"] != row["company_id"]:
                    domain.fail("Invalid extraction company scope")
            for row in snapshot["mydata_invoices"]:
                domain.invoice(row["facts"])
                domain.month(row["review_month"])
                domain.identifier(row["revision"])
                doc = docs.get(row["document_id"])
                if row["document_id"] and (not doc or doc["company_id"] != row["company_id"]):
                    domain.fail("Invalid document reference in myDATA snapshot")
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(400, "Invalid or damaged myDATA snapshot") from exc
        return snapshot

    def restore(self, snapshot, actor):
        created = []
        try:
            with self.store.pool.connection() as connection, connection.transaction():
                self.lock(connection)
                for row in snapshot["mydata_documents"]:
                    storage_id = self.store_file(row["id"], base64.b64decode(row.pop("content"), validate=True))
                    created.append(storage_id)
                    row["facts"]["storageId"] = storage_id
                for table in reversed(TABLES):
                    connection.execute(f"DELETE FROM {table}")
                for row in snapshot["mydata_companies"]:
                    connection.execute("INSERT INTO mydata_companies VALUES (%s,%s::jsonb,%s)",
                                       (row["id"], json.dumps(row["facts"]), str(uuid4())))
                for row in snapshot["mydata_documents"]:
                    connection.execute("INSERT INTO mydata_documents VALUES (%s,%s,%s,%s::jsonb)",
                                       (row["id"], row["company_id"], row["sha256"], json.dumps(row["facts"])))
                for row in snapshot["mydata_invoices"]:
                    facts = row["facts"]
                    facts.update(reviewed=False, reviewedAt=None, reviewedBy=None, issues=domain.review_issues(facts))
                    connection.execute("INSERT INTO mydata_invoices VALUES (%s,%s,%s,%s,%s::jsonb,%s)",
                                       (row["id"], row["company_id"], row["document_id"], row["review_month"],
                                        json.dumps(facts), str(uuid4())))
                for row in snapshot["mydata_audit_events"]:
                    connection.execute("INSERT INTO mydata_audit_events VALUES (%s,%s,%s,%s::jsonb)",
                                       (row["id"], row["company_id"], row["entity_id"], json.dumps(row["facts"])))
                for row in snapshot["mydata_extractions"]:
                    state = row["state"] if row["state"] not in {"queued", "running"} else "cancelled"
                    connection.execute("INSERT INTO mydata_extractions(id,company_id,invoice_id,facts,state,created_at) VALUES (%s,%s,%s,%s::jsonb,%s,coalesce(%s::timestamptz,now()))",
                                       (row["id"], row["company_id"], row["invoice_id"], json.dumps(row["facts"]), state, row.get("created_at")))
                for row in snapshot["mydata_companies"]:
                    self.audit(connection, row["id"], row["id"], "backup_restored_review_required", actor, {})
        except Exception:
            for storage_id in created:
                (self.directory / storage_id).unlink(missing_ok=True)
            raise
