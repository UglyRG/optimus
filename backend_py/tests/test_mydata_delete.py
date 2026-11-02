"""Deletion of local uploads, with scoped revisions, file cleanup and remote evidence retained."""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from optimus_api.mydata.extraction_jobs import ExtractionJobs
from optimus_api.mydata.intake import Intake
from optimus_api.mydata.aade_xml import parse_page
from optimus_api.mydata.routes import build_router
from test_mydata import repo, png
from test_mydata_intake import company, page, VAT, MARK, SUPPLIER


def upload(repo, comp):
    return repo.upload(comp['id'], '2025-01', 'receipt.png', png(), 'Owner')['invoice']


def stored_path(repo, doc_id):
    with repo.store.pool.connection() as conn:
        row = conn.execute('SELECT facts FROM mydata_documents WHERE id=%s', (doc_id,)).fetchone()
    return repo.directory / row['facts']['storageId']


def test_delete_upload_removes_original_and_jobs_and_allows_reupload(repo):
    comp = company(repo)
    saved = upload(repo, comp)
    path = stored_path(repo, saved['documentId'])
    jobs = ExtractionJobs(repo, SimpleNamespace())
    jobs.queue(comp['id'], saved['id'], {'revision': saved['revision']}, 'Owner')
    in_flight = jobs.claim()
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]['canDelete'] is True
    result = repo.delete_upload(comp['id'], saved['id'], saved['revision'], 'Owner')
    assert result['deleted'] and not result['originalCleanupPending'] and not path.exists()
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 0
    assert jobs.get(comp['id'], saved['id']) is None
    jobs.process(in_flight)  # Stale worker cannot recreate a deleted draft/job.
    assert jobs.get(comp['id'], saved['id']) is None
    with pytest.raises(HTTPException) as exc:
        repo.document(comp['id'], saved['documentId'])
    assert exc.value.status_code == 404
    assert repo.history(comp['id'], saved['id'])[0]['action'] == 'uploaded_purchase_deleted'
    snapshot = repo.validate_backup(repo.backup())
    assert snapshot['mydata_invoices'] == snapshot['mydata_documents'] == snapshot['mydata_extractions'] == []
    assert upload(repo, comp)['id'] != saved['id']


def test_scope_stale_revision_and_transaction_failure_keep_original(repo, monkeypatch):
    comp = company(repo)
    other = repo.save_company({'name': 'Other'}, 'Owner')
    saved = upload(repo, comp)
    path = stored_path(repo, saved['documentId'])
    with pytest.raises(HTTPException) as exc:
        repo.delete_upload(other['id'], saved['id'], saved['revision'], 'Owner')
    assert exc.value.status_code == 404
    updated = repo.save_invoice(comp['id'], {**saved, 'notes': 'Edited'}, 'Owner')
    with pytest.raises(HTTPException) as exc:
        repo.delete_upload(comp['id'], saved['id'], saved['revision'], 'Owner')
    assert exc.value.status_code == 409 and path.exists()
    with monkeypatch.context() as patch:
        patch.setattr(repo, 'audit', Mock(side_effect=RuntimeError('simulated rollback')))
        with pytest.raises(RuntimeError):
            repo.delete_upload(comp['id'], updated['id'], updated['revision'], 'Owner')
    assert path.exists() and repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 1


def test_aade_imports_and_pure_manual_entries_are_not_upload_deletions(repo):
    comp = company(repo)
    intake = Intake(repo)
    with repo.store.pool.connection() as conn, conn.transaction():
        repo.lock(conn)
        intake.ingest(conn, comp['id'], 'test', parse_page(page(), VAT), '2025-01', 'Owner')
    imported = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    attached = repo.upload(comp['id'], '2025-01', 'original.png', png(), 'Owner', {'id': imported['id'], 'revision': imported['revision']})['invoice']
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]['canDelete'] is False
    with pytest.raises(HTTPException, match='Only manually uploaded'):
        repo.delete_upload(comp['id'], attached['id'], attached['revision'], 'Owner')
    manual = repo.save_invoice(comp['id'], {'reviewMonth': '2025-01'}, 'Owner')
    with pytest.raises(HTTPException, match='Only manually uploaded'):
        repo.delete_upload(comp['id'], manual['id'], manual['revision'], 'Owner')


def test_linked_local_upload_is_deleted_without_losing_remote_record(repo):
    comp = company(repo)
    saved = upload(repo, comp)
    saved = repo.save_invoice(comp['id'], {**saved, 'supplierVat': SUPPLIER, 'number': '42', 'series': 'A',
        'mark': MARK, 'issueDate': '2025-01-17', 'net': '100', 'vat': '24', 'total': '124'}, 'Owner')
    intake = Intake(repo)
    with repo.store.pool.connection() as conn, conn.transaction():
        repo.lock(conn)
        intake.ingest(conn, comp['id'], 'test', parse_page(page(), VAT), '2025-01', 'Owner')
    current = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    remote = intake.list(comp['id'], '2025-01', '2025-01')['records'][0]
    assert remote['invoiceId'] == saved['id'] and current['canDelete']
    result = repo.delete_upload(comp['id'], current['id'], current['revision'], 'Owner')
    assert result['remoteLinksPreserved'] == 1
    preserved = intake.list(comp['id'], '2025-01', '2025-01')['records'][0]
    assert preserved['mark'] == MARK and preserved['invoiceId'] is None
    assert preserved['revision'] != remote['revision']
    repo.validate_backup(repo.backup())


def test_file_cleanup_failure_is_reported_after_successful_transaction(repo, monkeypatch):
    comp = company(repo)
    saved = upload(repo, comp)
    path = stored_path(repo, saved['documentId'])
    unlink = Path.unlink
    def fail_original(self, *args, **kwargs):
        if self == path:
            raise PermissionError('simulated file lock')
        return unlink(self, *args, **kwargs)
    with monkeypatch.context() as patch:
        patch.setattr(Path, 'unlink', fail_original)
        result = repo.delete_upload(comp['id'], saved['id'], saved['revision'], 'Owner')
    assert result['originalCleanupPending'] is True and path.exists()
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 0


def test_delete_route_checks_session_origin_and_revision(repo):
    comp = company(repo)
    saved = upload(repo, comp)
    app = FastAPI()
    def auth(): return {'name': 'Owner'}
    app.include_router(build_router(repo, auth, SimpleNamespace(frontend_origin='http://localhost:5173')))
    client = TestClient(app)
    url = f"/api/tools/mydata-invoices/companies/{comp['id']}/invoices/{saved['id']}"
    assert client.request('DELETE', url, json={'revision': saved['revision']}, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.request('DELETE', url, json={}).status_code == 409
    app.dependency_overrides[auth] = lambda: (_ for _ in ()).throw(HTTPException(401, 'login'))
    assert client.request('DELETE', url, json={'revision': saved['revision']}).status_code == 401
    app.dependency_overrides.clear()
    result = client.request('DELETE', url, json={'revision': saved['revision']})
    assert result.status_code == 200 and result.json()['deleted']
    assert result.headers['cache-control'] == 'no-store'
    assert client.request('DELETE', url, json={'revision': saved['revision']}).status_code == 404
