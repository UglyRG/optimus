"""Company/environment scoped remote evidence and conservative purchase matching."""
import base64
from decimal import Decimal
import json
from uuid import uuid4

from fastapi import HTTPException

from ..utils import now_iso
from . import domain
from .aade_xml import editable_facts


def differences(local, remote):
    values = {'supplierVat': remote['issuerVat'], 'number': remote['number'], 'series': remote['series'],
              'issueDate': remote['issueDate'], 'currency': remote['currency'], 'mark': remote['mark'],
              'net': remote['summary']['totalNetValue'], 'vat': remote['summary']['totalVatAmount'], 'total': remote['summary']['totalGrossValue']}
    conflicts = []
    for key, value in values.items():
        current = local.get(key, '')
        if current == '' or value == '':
            continue
        equal = Decimal(current) == Decimal(value) if key in {'net', 'vat', 'total'} else current == value
        if not equal:
            conflicts.append({'field': key, 'local': current, 'remote': value})
    return conflicts


def candidates(invoices, record, environment, linked_ids):
    found = []
    for row in invoices:
        facts = row['facts']
        if row['id'] in linked_ids:
            continue
        # Imported test drafts never become production matches (or vice versa).
        if facts.get('sourceEnvironment') and facts['sourceEnvironment'] != environment:
            continue
        exact_mark = facts.get('mark') == record['mark']
        business = (facts.get('supplierVat') == record['issuerVat'] and facts.get('issueDate') == record['issueDate']
                    and facts.get('number') == record['number'])
        if exact_mark or business:
            found.append({'invoiceId': row['id'], 'revision': row['revision'], 'supplier': facts.get('supplier', ''),
                          'number': facts.get('number', ''), 'reviewMonth': row['review_month'],
                          'method': 'mark' if exact_mark else 'business_identity', 'conflicts': differences(facts, record)})
    return found


class Intake:
    def __init__(self, repo):
        self.repo = repo

    def encrypt_response(self, content, job_id, page):
        return base64.b64encode(self.repo.encrypt(content, f'mydata:sync:{job_id}:{page}')).decode()

    @staticmethod
    def public(row):
        proposal = editable_facts(row['facts'])[0] if row['facts'].get('summary') else {}
        return {'proposedFields': proposal, 'id': row['id'], 'environment': row['environment'], 'mark': row['mark'], 'invoiceId': row['invoice_id'],
                'revision': row['revision'], **{k: v for k, v in row['facts'].items() if k != 'encryptedXml'}}

    def list(self, company_id, start, end, offset=0):
        domain.identifier(company_id)
        domain.month(start); domain.month(end)
        if start > end:
            domain.fail('The start month must precede the end month')
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            self.repo.require_company(conn, company_id)
            params = (company_id, start, end)
            total = conn.execute("SELECT count(*) AS n FROM mydata_remote_records WHERE company_id=%s AND facts->>'reviewMonth' BETWEEN %s AND %s", params).fetchone()['n']
            rows = conn.execute("SELECT * FROM mydata_remote_records WHERE company_id=%s AND facts->>'reviewMonth' BETWEEN %s AND %s ORDER BY facts->>'issueDate' DESC,id LIMIT 100 OFFSET %s", (*params, offset)).fetchall()
            invoices = conn.execute('SELECT * FROM mydata_invoices WHERE company_id=%s', (company_id,)).fetchall()
            linked = conn.execute('SELECT invoice_id,environment FROM mydata_remote_records WHERE company_id=%s AND invoice_id IS NOT NULL', (company_id,)).fetchall()
        result = []
        by_id = {r['id']: r for r in invoices}
        for row in rows:
            value = self.public(row)
            if row['invoice_id']:
                local = by_id[row['invoice_id']]
                value['conflicts'] = differences(local['facts'], row['facts'])
                value['matchStatus'] = 'conflict' if value['conflicts'] else 'linked'
            else:
                value['candidates'] = candidates(invoices, row['facts'], row['environment'], {r['invoice_id'] for r in linked if r['environment'] == row['environment']})
                value['matchStatus'] = 'needs_match'
            result.append(value)
        return {'records': result, 'total': total}

    def for_invoice(self, company_id, invoice_id):
        domain.identifier(company_id); domain.identifier(invoice_id)
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            local = conn.execute('SELECT * FROM mydata_invoices WHERE id=%s AND company_id=%s', (invoice_id, company_id)).fetchone()
            if not local:
                raise HTTPException(404, 'Purchase not found')
            rows = conn.execute('SELECT * FROM mydata_remote_records WHERE company_id=%s AND invoice_id=%s', (company_id, invoice_id)).fetchall()
        return {'records': [{**self.public(row), 'conflicts': differences(local['facts'], row['facts'])} for row in rows]}

    def new_draft(self, conn, company_id, record, environment, actor):
        facts, warnings = editable_facts(record)
        facts = domain.invoice(facts)
        facts.update(source='aade', sourceEnvironment=environment, sourceWarnings=warnings,
                     createdAt=now_iso(), updatedAt=now_iso(), documentId=None, filename='',
                     reviewed=False, reviewedAt=None, reviewedBy=None, issues=domain.review_issues(facts))
        record_id, revision = str(uuid4()), str(uuid4())
        conn.execute('INSERT INTO mydata_invoices VALUES (%s,%s,NULL,%s,%s::jsonb,%s)',
                     (record_id, company_id, facts['reviewMonth'], json.dumps(facts), revision))
        self.repo.audit(conn, company_id, record_id, 'aade_purchase_imported', actor, {'environment': environment, 'mark': record['mark'], 'revision': revision})
        return record_id

    def invalidate_review(self, conn, company_id, invoice_id, actor):
        row = conn.execute('SELECT * FROM mydata_invoices WHERE id=%s AND company_id=%s', (invoice_id, company_id)).fetchone()
        facts = {**row['facts'], 'reviewed': False, 'reviewedAt': None, 'reviewedBy': None}
        revision = str(uuid4())
        conn.execute('UPDATE mydata_invoices SET facts=%s::jsonb,revision=%s WHERE id=%s', (json.dumps(facts), revision, invoice_id))
        self.repo.audit(conn, company_id, invoice_id, 'remote_evidence_changed', actor, {'revision': revision})

    def ingest(self, conn, company_id, environment, page, month, actor):
        imported = changed = 0
        invoices = conn.execute('SELECT * FROM mydata_invoices WHERE company_id=%s', (company_id,)).fetchall()
        for record in page['records']:
            if record['reviewMonth'] != month:
                # Do not silently advance a date-filtered cursor over unexpected dates.
                raise HTTPException(400, 'AADE returned a purchase outside the requested month. Retry after checking the contract.')
            old = conn.execute('SELECT * FROM mydata_remote_records WHERE company_id=%s AND environment=%s AND mark=%s', (company_id, environment, record['mark'])).fetchone()
            record_id = old['id'] if old else str(uuid4())
            invoice_id = old['invoice_id'] if old else None
            prior = old['facts'] if old else {}
            xml = record['rawXml']
            facts = {k: v for k, v in record.items() if k != 'rawXml'}
            facts.update(events=prior.get('events', []), cancelled=record.get('cancelled', False) or prior.get('cancelled', False), retrievedAt=now_iso(),
                         encryptedXml=base64.b64encode(self.repo.encrypt(xml.encode(), 'mydata:remote:' + record_id)).decode())
            created_draft = False
            if not invoice_id:
                linked = {r['invoice_id'] for r in conn.execute('SELECT invoice_id FROM mydata_remote_records WHERE company_id=%s AND environment=%s AND invoice_id IS NOT NULL', (company_id, environment)).fetchall()}
                possible = candidates(invoices, facts, environment, linked)
                exact = [r for r in possible if r['method'] == 'mark']
                if len(possible) == 1 and len(exact) == 1 and not exact[0]['conflicts']:
                    invoice_id = exact[0]['invoiceId']
                elif not possible:
                    invoice_id = self.new_draft(conn, company_id, facts, environment, actor)
                    imported += 1
                    created_draft = True
            has_changed = bool(old and prior.get('payloadHash') != facts['payloadHash'])
            if invoice_id and not created_draft and (has_changed or not old or not old['invoice_id']):
                self.invalidate_review(conn, company_id, invoice_id, actor)
            if has_changed:
                changed += 1
            revision = str(uuid4()) if has_changed or not old or old['invoice_id'] != invoice_id else old['revision']
            conn.execute('INSERT INTO mydata_remote_records VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s) ON CONFLICT(company_id,environment,mark) DO UPDATE SET invoice_id=excluded.invoice_id,facts=excluded.facts,revision=excluded.revision',
                         (record_id, company_id, environment, record['mark'], invoice_id, json.dumps(facts), revision))
        for event in page['events']:
            old = conn.execute('SELECT * FROM mydata_remote_records WHERE company_id=%s AND environment=%s AND mark=%s', (company_id, environment, event['mark'])).fetchone()
            facts = old['facts'] if old else {'mark': event['mark'], 'reviewMonth': '', 'events': []}
            if any(item['hash'] == event['hash'] for item in facts.get('events', [])):
                continue
            facts.setdefault('events', []).append({**event, 'observedAt': now_iso()})
            if len(facts['events']) > 10000:
                domain.fail('This invoice exceeds the event history limit. Contact support before continuing intake.')
            if event['kind'] == 'cancelledInvoicesDoc':
                facts['cancelled'] = True
            if old and old['invoice_id']:
                self.invalidate_review(conn, company_id, old['invoice_id'], actor)
            record_id = old['id'] if old else str(uuid4())
            conn.execute('INSERT INTO mydata_remote_records VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s) ON CONFLICT(company_id,environment,mark) DO UPDATE SET facts=excluded.facts,revision=excluded.revision',
                         (record_id, company_id, environment, event['mark'], old['invoice_id'] if old else None, json.dumps(facts), str(uuid4())))
            changed += 1
        return imported, changed

    def match(self, company_id, remote_id, payload, actor):
        domain.identifier(company_id); domain.identifier(remote_id)
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            company = self.repo.require_company(conn, company_id)
            row = conn.execute('SELECT * FROM mydata_remote_records WHERE id=%s AND company_id=%s', (remote_id, company_id)).fetchone()
            if not row:
                raise HTTPException(404, 'Remote purchase not found')
            if row['revision'] != payload.get('remoteRevision'):
                raise HTTPException(409, 'Remote evidence changed. Reload before matching.')
            if row['invoice_id'] or row['facts'].get('recipientVat') != company['facts']['vatNumber']:
                domain.fail('This remote record is already linked or belongs to another taxpayer identity')
            if payload.get('create') is True:
                invoice_id = self.new_draft(conn, company_id, row['facts'], row['environment'], actor)
            else:
                invoice_id = domain.identifier(payload.get('invoiceId'))
                local = conn.execute('SELECT * FROM mydata_invoices WHERE id=%s AND company_id=%s', (invoice_id, company_id)).fetchone()
                if not local:
                    raise HTTPException(404, 'Purchase not found')
                if local['revision'] != payload.get('revision'):
                    raise HTTPException(409, 'Purchase changed. Reload before matching.')
                linked = conn.execute('SELECT id FROM mydata_remote_records WHERE company_id=%s AND environment=%s AND invoice_id=%s', (company_id, row['environment'], invoice_id)).fetchone()
                if linked or local['facts'].get('sourceEnvironment', row['environment']) != row['environment']:
                    domain.fail('This purchase is already linked or belongs to another environment')
                if differences(local['facts'], row['facts']):
                    domain.fail('Resolve conflicting identity/amount fields before linking. Neither side has been overwritten.')
                self.invalidate_review(conn, company_id, invoice_id, actor)
            conn.execute('UPDATE mydata_remote_records SET invoice_id=%s,revision=%s WHERE id=%s', (invoice_id, str(uuid4()), remote_id))
            self.repo.audit(conn, company_id, invoice_id, 'aade_match_confirmed', actor, {'remoteId': remote_id, 'mark': row['mark'], 'environment': row['environment']})
        return {'invoiceId': invoice_id}

    def apply(self, company_id, invoice_id, remote_id, payload, actor):
        domain.identifier(company_id); domain.identifier(invoice_id); domain.identifier(remote_id)
        fields = payload.get("fields")
        allowed = {"supplier", "supplierVat", "number", "series", "issueDate", "currency", "mark", "kind", "net", "vat", "total", "otherTaxes", "description", "lines"}
        if not isinstance(fields, list) or not fields or any(not isinstance(key, str) or key not in allowed for key in fields):
            domain.fail("Choose supported AADE fields to apply")
        with self.repo.store.pool.connection() as conn, conn.transaction():
            self.repo.lock(conn)
            company = self.repo.require_company(conn, company_id)
            remote = conn.execute("SELECT * FROM mydata_remote_records WHERE id=%s AND company_id=%s AND invoice_id=%s", (remote_id, company_id, invoice_id)).fetchone()
            local = conn.execute("SELECT * FROM mydata_invoices WHERE id=%s AND company_id=%s", (invoice_id, company_id)).fetchone()
            if not remote or not local:
                raise HTTPException(404, "Linked remote purchase not found")
            if local["revision"] != payload.get("revision") or remote["revision"] != payload.get("remoteRevision"):
                raise HTTPException(409, "Purchase or AADE evidence changed. Reload before applying.")
            if remote["facts"].get("recipientVat") != company["facts"]["vatNumber"]:
                domain.fail("Remote evidence belongs to a different taxpayer identity")
            proposed, warnings = editable_facts(remote["facts"])
            if any(key not in proposed or proposed[key] in ("", []) for key in fields):
                domain.fail("A selected field is absent or exceeds editable precision. Review it manually.")
            merged = {**local["facts"], **{key: proposed[key] for key in fields}}
            facts = {**merged, **domain.invoice(merged), "reviewed": False, "reviewedAt": None, "reviewedBy": None, "updatedAt": now_iso()}
            facts["issues"] = domain.review_issues(facts)
            revision = str(uuid4())
            conn.execute("UPDATE mydata_invoices SET facts=%s::jsonb,revision=%s WHERE id=%s", (json.dumps(facts), revision, invoice_id))
            self.repo.audit(conn, company_id, invoice_id, "aade_fields_applied", actor, {"remoteId": remote_id, "remoteRevision": remote["revision"], "fields": fields, "revision": revision})
        return {**facts, "id": invoice_id, "revision": revision}
