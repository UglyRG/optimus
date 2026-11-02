"""Purchase preparation tests. Integration tests use an explicitly configured disposable database."""
import base64
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image
import psycopg
from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row
import pytest
from reportlab.pdfgen import canvas

from optimus_api.mydata import domain
from optimus_api.mydata.repository import MydataRepository, inspect_file
from optimus_api.mydata.routes import build_router


def facts(**changes):
    return {"reviewMonth": "2025-01", "supplier": "Supplier Ελληνικά", "issueDate": "2025-01-17",
            "description": "Office purchases", "net": "100,00", "vat": "24", "total": "124",
            "mark": "99999999999999999999", **changes}


def png():
    output = io.BytesIO()
    Image.new("RGB", (20, 20), "white").save(output, "PNG")
    return output.getvalue()


def test_decimal_dates_and_identifiers():
    result = domain.invoice(facts())
    assert result["net"] == "100.00" and result["mark"] == "99999999999999999999"
    assert domain.review_issues(result) == []
    for invalid in ("1.234,56", "NaN", "1e3", 12.34, "10.999"):
        with pytest.raises(HTTPException):
            domain.money(invalid)
    for changes in ({"mark": 123}, {"issueDate": "2025-02-31"}, {"reviewMonth": "2025-13"}, {"lines": "bad"}):
        with pytest.raises(HTTPException):
            domain.invoice(facts(**changes))
    assert "does not equal" in domain.review_issues(domain.invoice(facts(total="125")))[0]
    assert domain.vat_number("123456783") == "123456783"
    with pytest.raises(HTTPException):
        domain.vat_number("123456789")


def test_file_signatures_and_page_limits():
    assert inspect_file(png(), "receipt.png") == ("image/png", 1)
    for data, name in ((png(), "receipt.jpg"), (b"<script>alert(1)</script>", "receipt.png"), (b"%PDF-broken", "invoice.pdf")):
        with pytest.raises(HTTPException):
            inspect_file(data, name)
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    for _ in range(31):
        pdf.drawString(30, 30, "Test")
        pdf.showPage()
    pdf.save()
    with pytest.raises(HTTPException, match="30 pages"):
        inspect_file(output.getvalue(), "long.pdf")


@pytest.fixture
def repo(tmp_path):
    url = os.environ.get("MYDATA_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Set MYDATA_TEST_DATABASE_URL to an isolated test database")
    schema = "mydata_test_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as connection:
        connection.execute(f'CREATE SCHEMA "{schema}"')
    pool = ConnectionPool(url, kwargs={"autocommit": True, "row_factory": dict_row,
                                      "options": f"-c search_path={schema}"})
    service = MydataRepository(SimpleNamespace(pool=pool), SimpleNamespace(data_dir=tmp_path))
    service.ensure_schema()
    service.ensure_schema()
    try:
        yield service
    finally:
        pool.close()
        with psycopg.connect(url, autocommit=True) as connection:
            connection.execute(f'DROP SCHEMA "{schema}" CASCADE')


def test_three_companies_and_revision_preconditions(repo):
    first = repo.save_company({"name": "First"}, "Owner")
    repo.save_company({"name": "Second", "vatNumber": "123456783"}, "Owner")
    with pytest.raises(HTTPException):
        repo.save_company({"name": "Duplicate VAT", "vatNumber": "123456783"}, "Owner")
    repo.save_company({"name": "Third"}, "Owner")
    with pytest.raises(HTTPException):
        repo.save_company({"name": "Fourth"}, "Owner")
    repo.save_company({**first, "name": "New name"}, "Owner")
    with pytest.raises(HTTPException) as exc:
        repo.save_company(first, "Owner")
    assert exc.value.status_code == 409


def test_drafts_review_edit_and_company_isolation(repo):
    one, two = [repo.save_company({"name": name}, "Owner")["id"] for name in ("One", "Two")]
    row = repo.save_invoice(one, facts(markReviewed=True), "Owner")
    assert row["reviewed"] and row["net"] == "100.00"
    changed = repo.save_invoice(one, {**row, "description": "Changed"}, "Owner")
    assert not changed["reviewed"]
    with pytest.raises(HTTPException) as exc:
        repo.save_invoice(one, row, "Owner")
    assert exc.value.status_code == 409
    with pytest.raises(HTTPException):
        repo.save_invoice(two, changed, "Owner")
    assert repo.invoices(two, "2025-01", "2025-12")["invoices"] == []
    assert repo.invoices(one, "2025-01", "2025-12", status="reviewed")["total"] == 0
    assert repo.invoices(one, "2025-01", "2025-12", status="needs_review")["total"] == 1
    assert len(repo.history(one, row["id"])) == 2
    assert repo.history(two, row["id"]) == []
    with pytest.raises(HTTPException):
        repo.save_invoice(one, facts(total="125", markReviewed=True), "Owner")


def test_upload_dedup_private_preview_and_missing_key(repo):
    one, two = [repo.save_company({"name": name}, "Owner")["id"] for name in ("One", "Two")]
    result = repo.upload(one, "2025-01", "../../receipt.png", png(), "Owner")
    row = result["invoice"]
    assert row["filename"] == "receipt.png"
    assert row["issueDate"] == ""  # no invented dates
    assert repo.upload(one, "2025-02", "same.png", png(), "Owner")["duplicate"]
    assert not repo.upload(two, "2025-01", "same.png", png(), "Owner")["duplicate"]
    assert repo.document(one, row["documentId"])[0] == png()
    with pytest.raises(HTTPException) as exc:
        repo.document(two, row["documentId"])
    assert exc.value.status_code == 404
    for path in repo.directory.iterdir():
        assert path.stat().st_mode & 0o777 == 0o600
        assert not path.read_bytes().startswith(b"\x89PNG")
    assert repo.key_path.stat().st_mode & 0o777 == 0o600
    repo.key_path.unlink()
    with pytest.raises(HTTPException) as exc:
        repo.document(one, row["documentId"])
    assert exc.value.status_code == 503
    with pytest.raises(HTTPException):
        repo.save_company({"name": "New"}, "Owner")
    assert not repo.key_path.exists()


def test_concurrent_review_only_one_revision_wins(repo):
    company = repo.save_company({"name": "One"}, "Owner")["id"]
    row = repo.save_invoice(company, facts(), "Owner")
    def update():
        try:
            repo.save_invoice(company, {**row, "markReviewed": True}, "Owner")
            return "saved"
        except HTTPException as exc:
            return exc.status_code
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(lambda _: update(), range(2)))
    assert sorted(str(value) for value in results) == ["409", "saved"]


def test_backup_roundtrip_with_originals_and_invalidated_reviews(repo):
    company = repo.save_company({"name": "One"}, "Owner")["id"]
    row = repo.upload(company, "2025-01", "receipt.png", png(), "Owner")["invoice"]
    row = repo.save_invoice(company, {**row, **facts(), "markReviewed": True}, "Owner")
    envelope = repo.backup()
    assert "Supplier" not in json.dumps(envelope)
    snapshot = repo.validate_backup(envelope)
    repo.restore(snapshot, "Restorer")
    restored = repo.invoices(company, "2025-01", "2025-01")["invoices"][0]
    assert restored["revision"] != row["revision"] and not restored["reviewed"]
    assert restored["mark"] == "99999999999999999999"
    assert repo.document(company, restored["documentId"])[0] == png()
    assert len(repo.history(company, row["id"])) == 2
    with pytest.raises(HTTPException):
        repo.save_invoice(company, row, "Owner")
    damaged = {**envelope, "ciphertext": base64.b64encode(b"wrong" * 10).decode()}
    with pytest.raises(HTTPException):
        repo.validate_backup(damaged)
    assert repo.invoices(company, "2025-01", "2025-01")["total"] == 1
    original_key = repo.key_path.read_bytes()
    repo.key_path.write_bytes(b"x" * 32)
    with pytest.raises(HTTPException):
        repo.validate_backup(envelope)
    repo.key_path.write_bytes(original_key)


def test_api_auth_csrf_and_no_submission_endpoints(repo):
    app = FastAPI()
    def require_session():
        raise HTTPException(401, "Authentication required")
    app.include_router(build_router(repo, require_session, SimpleNamespace(frontend_origin="http://localhost:5173")))
    with TestClient(app) as client:
        assert client.get("/api/tools/mydata-invoices/companies").status_code == 401
        app.dependency_overrides[require_session] = lambda: {"name": "Owner"}
        path = "/api/tools/mydata-invoices/companies"
        assert client.post(path, json={"name": "Bad"}, headers={"Origin": "https://evil.example"}).status_code == 403
        result = client.post(path, json={"name": "One"}, headers={"Origin": "http://localhost:5173"})
        assert result.status_code == 200
        company = result.json()["company"]["id"]
        upload = client.post(f"{path}/{company}/documents", data={"reviewMonth": "2025-01"}, files={"file": ("receipt.png", png(), "image/png")})
        assert upload.status_code == 200
        doc_id = upload.json()["invoice"]["documentId"]
        preview = client.get(f"{path}/{company}/documents/{doc_id}/content")
        assert preview.content == png() and preview.headers["cache-control"] == "no-store"
        assert client.get(f"{path}/{company}/documents/{doc_id}/metadata").json()["pages"] == 1
        assert client.get(f"{path}/{company}/documents/{doc_id}/preview?page=1").content == png()
        assert client.get(f"{path}/{company}/documents/{doc_id}/preview?page=2").status_code == 404
        assert client.post(f"{path}/{company}/invoices/x/submit", json={}).status_code == 404
        assert all("submit" not in route.path for route in app.routes)


def test_restore_failure_rolls_back_records_and_cleans_new_files(repo, monkeypatch):
    company = repo.save_company({"name": "One"}, "Owner")["id"]
    row = repo.upload(company, "2025-01", "receipt.png", png(), "Owner")["invoice"]
    snapshot = repo.validate_backup(repo.backup())
    before = {path.name for path in repo.directory.iterdir()}
    def fail_audit(*args):
        raise RuntimeError("Simulated transaction failure")
    monkeypatch.setattr(repo, "audit", fail_audit)
    with pytest.raises(RuntimeError, match="transaction failure"):
        repo.restore(snapshot, "Restorer")
    assert {path.name for path in repo.directory.iterdir()} == before
    restored = repo.invoices(company, "2025-01", "2025-01")["invoices"][0]
    assert restored["revision"] == row["revision"]
    assert repo.document(company, row["documentId"])[0] == png()


def test_extraction_jobs_apply_revisions_cancellation_and_restore(repo):
    from optimus_api.mydata.extraction_jobs import ExtractionJobs
    from test_mydata_extraction import sample_pdf
    jobs = ExtractionJobs(repo, SimpleNamespace())
    company = repo.save_company({"name": "My company"}, "Owner")["id"]
    invoice = repo.upload(company, "2026-10", "invoice.pdf", sample_pdf(), "Owner")["invoice"]
    queued = jobs.queue(company, invoice["id"], {"revision": invoice["revision"]}, "Owner")
    assert jobs.queue(company, invoice["id"], {"revision": invoice["revision"]}, "Owner")["id"] == queued["id"]
    row = jobs.claim()
    jobs.process(row)
    result = jobs.get(company, invoice["id"])
    assert result["state"] == "completed", result
    assert result["result"]["fields"]["total"]["value"] == "124.00"
    # Worker results never overwrite drafts.
    assert repo.invoices(company, "2026-10", "2026-10")["invoices"][0]["supplier"] == ""
    applied = jobs.apply(company, invoice["id"], queued["id"], {"revision": invoice["revision"], "fields": ["supplier", "net", "vat", "total", "mark"]}, "Owner")
    assert applied["supplier"] == "ACME SUPPLIES" and applied["reviewed"] is False
    assert applied["mark"] == "99999999999999999999" and applied["issueDate"] == ""
    with pytest.raises(HTTPException) as exc:
        jobs.apply(company, invoice["id"], queued["id"], {"revision": applied["revision"], "fields": ["issueDate"]}, "Owner")
    assert exc.value.status_code == 409
    saved = repo.save_invoice(company, applied, "Owner")
    assert saved["extractionId"] == queued["id"]
    queued2 = jobs.queue(company, invoice["id"], {"revision": saved["revision"]}, "Owner")
    snapshot = repo.validate_backup(repo.backup())
    repo.restore(snapshot, "Restorer")
    assert jobs.get(company, invoice["id"], queued2["id"])["state"] == "cancelled"
    assert jobs.claim() is None
    # Archived completed extraction evidence stays available, but cannot apply to restored revisions.
    assert jobs.get(company, invoice["id"], queued["id"])["result"]["pages"]
    with pytest.raises(HTTPException):
        jobs.apply(company, invoice["id"], queued["id"], {"revision": saved["revision"], "fields": ["supplier"]}, "Owner")


def test_extraction_job_scope_and_stale_edits(repo):
    from optimus_api.mydata.extraction_jobs import ExtractionJobs
    from test_mydata_extraction import sample_pdf
    jobs = ExtractionJobs(repo, SimpleNamespace())
    one, two = [repo.save_company({"name": name}, "Owner")["id"] for name in ("One", "Two")]
    row = repo.upload(one, "2026-10", "invoice.pdf", sample_pdf(), "Owner")["invoice"]
    with pytest.raises(HTTPException):
        jobs.queue(one, row["id"], {"revision": row["revision"], "provider": "anthropic", "consent": True}, "Owner")
    queued = jobs.queue(one, row["id"], {"revision": row["revision"]}, "Owner")
    with pytest.raises(HTTPException) as exc:
        jobs.get(two, row["id"], queued["id"])
    assert exc.value.status_code == 404
    jobs.cancel(one, row["id"], queued["id"], "Owner")
    assert jobs.claim() is None
    assert jobs.get(one, row["id"])["state"] == "cancelled"
    queued = jobs.queue(one, row["id"], {"revision": row["revision"]}, "Owner")
    claimed = jobs.claim()
    changed = repo.save_invoice(one, {**row, "supplier": "My manual correction"}, "Owner")
    jobs.process(claimed)
    with pytest.raises(HTTPException) as exc:
        jobs.apply(one, row["id"], queued["id"], {"revision": changed["revision"], "fields": ["supplier"]}, "Owner")
    assert exc.value.status_code == 409
    assert repo.invoices(one, "2026-10", "2026-10")["invoices"][0]["supplier"] == "My manual correction"


def test_legacy_backup_without_extraction_table(repo):
    company = repo.save_company({"name": "Legacy company"}, "Owner")["id"]
    envelope = repo.backup()
    payload = json.loads(repo.decrypt(base64.b64decode(envelope["ciphertext"]), "mydata:backup:v1"))
    del payload["mydata_extractions"]
    envelope["ciphertext"] = base64.b64encode(repo.encrypt(json.dumps(payload).encode(), "mydata:backup:v1")).decode()
    snapshot = repo.validate_backup(envelope)
    assert snapshot["mydata_extractions"] == []
    repo.restore(snapshot, "Restorer")
    assert repo.companies()[0]["id"] == company


def test_old_extractor_results_require_reextraction(repo):
    from optimus_api.mydata.extraction_jobs import ExtractionJobs
    from test_mydata_extraction import sample_pdf
    jobs = ExtractionJobs(repo, SimpleNamespace())
    company = repo.save_company({"name": "My company"}, "Owner")["id"]
    invoice = repo.upload(company, "2026-10", "invoice.pdf", sample_pdf(), "Owner")["invoice"]
    queued = jobs.queue(company, invoice["id"], {"revision": invoice["revision"]}, "Owner")
    jobs.process(jobs.claim())
    with repo.store.pool.connection() as connection:
        connection.execute("UPDATE mydata_extractions SET facts=jsonb_set(facts,'{result,version}',%s::jsonb) WHERE id=%s",
                           (json.dumps("local-invoice-v1"), queued["id"]))
    with pytest.raises(HTTPException) as exc:
        jobs.apply(company, invoice["id"], queued["id"], {"revision": invoice["revision"], "fields": ["supplier"]}, "Owner")
    assert exc.value.status_code == 409
    assert "Extract again" in exc.value.detail
    assert repo.invoices(company, "2026-10", "2026-10")["invoices"][0]["revision"] == invoice["revision"]


def test_qr_job_consent_selected_fields_and_encrypted_backup_restore(repo, monkeypatch):
    from optimus_api.mydata.extraction_jobs import ExtractionJobs
    from optimus_api.mydata import qr_lookup
    from test_mydata_qr import sample_qr_pdf, xml, QR_URL
    from unittest.mock import Mock
    fetcher = Mock(return_value=xml())
    monkeypatch.setattr(qr_lookup, "fetch_xml", fetcher)
    jobs = ExtractionJobs(repo, SimpleNamespace())
    company = repo.save_company({"name": "Example Customer", "vatNumber": "987654324"}, "Owner")["id"]
    invoice = repo.upload(company, "2026-10", "invoice.pdf", sample_qr_pdf(), "Owner")["invoice"]
    jobs.queue(company, invoice["id"], {"revision": invoice["revision"]}, "Owner")
    jobs.process(jobs.claim())
    assert jobs.get(company, invoice["id"])["result"]["qr"]["status"] == "lookup_disabled"
    fetcher.assert_not_called()
    queued = jobs.queue(company, invoice["id"], {"revision": invoice["revision"], "lookupQr": True}, "Owner")
    assert queued["qrLookupConsent"] is True
    jobs.process(jobs.claim())
    result = jobs.get(company, invoice["id"], queued["id"])
    assert result["result"]["qr"]["status"] == "retrieved"
    assert result["result"]["qr"]["aadeVerified"] is False
    fields = list(result["result"]["qr"]["data"]["fields"])
    applied = jobs.apply(company, invoice["id"], queued["id"], {"revision": invoice["revision"], "fields": fields}, "Owner")
    assert applied["lines"][0]["vat"] == "9.60"
    assert applied["mark"] == "99999999999999999999" and not applied["reviewed"]
    audit = [event for event in repo.history(company, invoice["id"]) if event["action"] == "qr_lookup_completed"]
    assert len(audit) == 1 and QR_URL not in json.dumps(audit)
    pending = jobs.queue(company, invoice["id"], {"revision": applied["revision"], "lookupQr": True}, "Owner")
    envelope = repo.backup()
    assert "EXAMPLE SUPPLIER" not in json.dumps(envelope)
    repo.restore(repo.validate_backup(envelope), "Restorer")
    assert jobs.get(company, invoice["id"], pending["id"])["state"] == "cancelled"
    assert jobs.get(company, invoice["id"], queued["id"])["result"]["qr"]["data"]["rawXml"].startswith("<?xml")
    assert jobs.claim() is None
    fetcher.assert_called_once_with(QR_URL + "/mydata")
