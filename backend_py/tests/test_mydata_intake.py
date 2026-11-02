"""Read-only contracts, isolation, durable cursor/restore, and matching tests. No real API calls."""
import base64
import copy
import json
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from optimus_api.mydata import aade, domain, sync_jobs
from optimus_api.mydata.aade_xml import parse_page, editable_facts
from optimus_api.mydata.intake import Intake
from optimus_api.mydata.routes import build_router
from optimus_api.mydata.sync_jobs import SyncJobs
from test_mydata import repo, png

VAT = '123456783'
OTHER = '987654324'
SUPPLIER = '111111114'
MARK = '99999999999999999999'
NS = 'http://www.aade.gr/myDATA/invoice/v1.0'
E = 'https://www.aade.gr/myDATA/expensesClassificaton/v1.0'


def invoice(mark=MARK, vat=VAT, total='124.00', net='100.00', name='Example supplier', series='A', day='2025-01-17'):
    return f'''<invoice><uid>uid-{mark}</uid><mark>{mark}</mark><issuer><vatNumber>{SUPPLIER}</vatNumber><name>{name}</name></issuer>
<counterpart><vatNumber>{vat}</vatNumber></counterpart><invoiceHeader><series>{series}</series><aa>42</aa><issueDate>{day}</issueDate><invoiceType>1.1</invoiceType><currency>EUR</currency></invoiceHeader>
<invoiceDetails><lineNumber>1</lineNumber><netValue>{net}</netValue><vatAmount>24.00</vatAmount><vatCategory>1</vatCategory><itemDescr>Office supplies</itemDescr><expensesClassification><e:classificationType>E3_585_016</e:classificationType><e:classificationCategory>category2_4</e:classificationCategory><e:amount>100.00</e:amount></expensesClassification></invoiceDetails>
<invoiceSummary><totalNetValue>{net}</totalNetValue><totalVatAmount>24.00</totalVatAmount><totalGrossValue>{total}</totalGrossValue></invoiceSummary></invoice>'''


def page(invoices=None, token='', events=''):
    return f'<RequestedDoc xmlns="{NS}" xmlns:e="{E}">{token}<invoicesDoc>{invoice() if invoices is None else invoices}</invoicesDoc>{events}</RequestedDoc>'.encode()


def config():
    return SimpleNamespace(mydata_slot_1_test_user_id='test-user', mydata_slot_1_test_subscription_key='test-secret', mydata_slot_1_test_vat_number=VAT)


def company(repo, **kwargs):
    return repo.save_company({'name': 'First', 'vatNumber': VAT, 'readConnection': 'slot_1_test', **kwargs}, 'Owner')


def queue(jobs, comp, **kwargs):
    return jobs.queue(comp['id'], {'start': '2025-01', 'end': '2025-01', 'companyRevision': comp['revision'], **kwargs}, 'Owner')


def local(repo, comp, **kwargs):
    return repo.save_invoice(comp['id'], {'reviewMonth': '2025-01', 'supplier': 'My edited supplier', 'supplierVat': SUPPLIER,
        'series': 'A', 'number': '42', 'issueDate': '2025-01-17', 'currency': 'EUR', 'net': '100', 'vat': '24', 'total': '124',
        'description': 'My description', **kwargs}, 'Owner')


def test_connection_alias_validation_and_environment_isolation():
    assert domain.company({'name': 'A'})['readConnection'] == ''
    for alias in ['ANTHROPIC_API_KEY', 'slot_4_test', 'slot_1_test_user_id']:
        with pytest.raises(HTTPException):
            domain.company({'name': 'A', 'readConnection': alias})
    comp = {'vatNumber': VAT, 'readConnection': 'slot_1_test', 'readPrincipal': 'company'}
    result = aade.configured_connection(config(), comp)
    assert result['subscription_key'] == 'test-secret'
    with pytest.raises(HTTPException, match='missing'):
        aade.configured_connection(config(), {**comp, 'readConnection': 'slot_1_prod'})
    with pytest.raises(HTTPException, match='match'):
        aade.configured_connection(config(), {**comp, 'vatNumber': OTHER})
    representative = aade.configured_connection(config(), {**comp, 'vatNumber': OTHER, 'readPrincipal': 'representative'})
    assert aade.request_params(representative, '2024-02')['entityVatNumber'] == OTHER
    assert 'entityVatNumber' not in aade.request_params(result, '2024-02')
    assert aade.request_params(result, '2024-02')['dateTo'] == '29/02/2024'
    public = json.dumps(aade.connection_options(config()))
    assert 'test-secret' not in public and 'test-user' not in public
    assert aade.month_range('2024-12', '2025-02') == ['2024-12', '2025-01', '2025-02']
    with pytest.raises(HTTPException):
        aade.month_range('2000-01', '2025-01')


def test_requested_doc_parsing_and_exact_remote_precision():
    parsed = parse_page(page(), VAT)
    record = parsed['records'][0]
    assert record['mark'] == MARK and record['series'] == 'A'
    assert record['lines'][0]['classifications'][0]['classificationType'] == 'E3_585_016'
    assert parse_page(page(invoice(vat=OTHER)), VAT)['skipped'] == 1
    result, warnings = editable_facts(parse_page(page(invoice(net='100.00001')), VAT)['records'][0])
    assert result['net'] == '' and warnings
    assert parse_page(page(invoice(net='100.00001')), VAT)['records'][0]['summary']['totalNetValue'] == '100.00001'
    assert 'classificationCategory' not in editable_facts(record)[0]


@pytest.mark.parametrize('content', [b'<html>Login</html>', b'<!DOCTYPE x [<!ENTITY x "bad">]><RequestedDoc/>',
    f'<RequestedDoc xmlns="{NS}"><invoicesDoc/><invoicesDoc/></RequestedDoc>'.encode(),
    page(invoice() + invoice()), page(invoice(mark='1e30')), page(token='<continuationToken><nextPartitionKey>a</nextPartitionKey></continuationToken>'),
    f'<RequestedDoc xmlns="{NS}"><unknown/></RequestedDoc>'.encode(), page(invoice().replace('<aa>42</aa>', '<aa>1</aa><aa>2</aa>'))])
def test_rejects_unsafe_ambiguous_or_wrong_response(content):
    with pytest.raises(aade.ReadError):
        parse_page(content, VAT)


def test_transport_only_get_fixed_route_no_redirect_or_credential_leak(monkeypatch):
    client = Mock()
    response = client.getresponse.return_value
    response.status = 200
    response.getheader.side_effect = lambda key, default=None: default
    response.read.side_effect = [page(), b'']
    monkeypatch.setattr(aade, 'PinnedHTTPS', Mock(return_value=client))
    monkeypatch.setattr(aade, 'public_addresses', lambda host: ['8.8.8.8'])
    conf = aade.configured_connection(config(), {'vatNumber': VAT, 'readConnection': 'slot_1_test'})
    assert aade.request_docs(conf, '2025-01').startswith(b'<RequestedDoc')
    args, kwargs = client.request.call_args
    assert args[0] == 'GET' and args[1].startswith('/RequestDocs?mark=0&')
    assert 'test-secret' not in args[1] and kwargs['headers']['ocp-apim-subscription-key'] == 'test-secret'
    response.status = 302
    with pytest.raises(aade.ReadError) as exc:
        aade.request_docs(conf, '2025-01')
    assert 'test-secret' not in str(exc.value)
    response.status = 401
    with pytest.raises(aade.ReadError, match='denied'):
        aade.request_docs(conf, '2025-01')
    assert client.request.call_count == 3
    with pytest.raises(aade.ReadError, match='separately registered test credentials'):
        aade.request_docs(conf, '2025-01')
    with pytest.raises(aade.ReadError, match='production API credentials'):
        aade.request_docs({**conf, 'environment': 'prod'}, '2025-01')
    response.status = 403
    with pytest.raises(aade.ReadError, match='denied permission'):
        aade.request_docs(conf, '2025-01')


def test_sync_is_idempotent_preserves_edits_and_invalidates_review(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    fetch = Mock(return_value=page())
    monkeypatch.setattr(sync_jobs, 'request_docs', fetch)
    queue(jobs, comp); jobs.process(jobs.claim())
    invoices = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices']
    assert len(invoices) == 1 and invoices[0]['sourceEnvironment'] == 'test'
    saved = repo.save_invoice(comp['id'], {**invoices[0], 'supplier': 'User corrected name', 'markReviewed': True}, 'Owner')
    queue(jobs, comp); jobs.process(jobs.claim())
    result = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    assert result['revision'] == saved['revision'] and result['reviewed']
    fetch.return_value = page(invoice(total='125.00', name='Changed remote name'))
    queue(jobs, comp); jobs.process(jobs.claim())
    updated = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    assert updated['supplier'] == 'User corrected name' and updated['total'] == '124.00'
    assert not updated['reviewed'] and updated['revision'] != saved['revision']
    remote = jobs.intake.for_invoice(comp['id'], saved['id'])['records'][0]
    assert remote['conflicts'][0]['field'] == 'total'
    assert 'encryptedXml' not in remote
    with pytest.raises(HTTPException) as exc:
        jobs.intake.apply(comp['id'], saved['id'], remote['id'], {'revision': saved['revision'], 'remoteRevision': remote['revision'], 'fields': ['total']}, 'Owner')
    assert exc.value.status_code == 409
    applied = jobs.intake.apply(comp['id'], saved['id'], remote['id'], {'revision': updated['revision'], 'remoteRevision': remote['revision'], 'fields': ['total']}, 'Owner')
    assert applied['total'] == '125.00' and applied['supplier'] == 'User corrected name'
    assert jobs.status(comp['id'])['job']['state'] == 'completed'


def test_pages_checkpoint_and_cancellation_events_across_months(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    token = '<continuationToken><nextPartitionKey>partition</nextPartitionKey><nextRowKey>row</nextRowKey></continuationToken>'
    cancel = f'<cancelledInvoicesDoc><cancelledInvoice><invoiceMark>{MARK}</invoiceMark><cancellationMark>8888</cancellationMark><cancellationDate>2025-02-01</cancellationDate></cancelledInvoice></cancelledInvoicesDoc>'
    classification = f'<expensesClassificationsDoc><expensesInvoiceClassification><e:invoiceMark>{MARK}</e:invoiceMark><e:classificationMark>5555</e:classificationMark><e:invoicesExpensesClassificationDetails><e:lineNumber>1</e:lineNumber><e:expensesClassificationDetailData><e:classificationCategory>category2_4</e:classificationCategory><e:amount>100.00</e:amount></e:expensesClassificationDetailData></e:invoicesExpensesClassificationDetails></expensesInvoiceClassification></expensesClassificationsDoc>'
    fetch = Mock(side_effect=[page(token=token), page('', events=classification), page('', events=cancel)])
    monkeypatch.setattr(sync_jobs, 'request_docs', fetch)
    queue(jobs, comp, end='2025-02')
    jobs.process(jobs.claim())
    assert jobs.status(comp['id'])['job']['state'] == 'queued'
    assert len(repo.invoices(comp['id'], '2025-01', '2025-01')['invoices']) == 1
    jobs.process(jobs.claim()); jobs.process(jobs.claim())
    assert fetch.call_args_list[1].args[2] == {'nextPartitionKey': 'partition', 'nextRowKey': 'row'}
    assert fetch.call_args_list[2].args[1:] == ('2025-02', None)
    remote = jobs.intake.list(comp['id'], '2025-01', '2025-01')['records'][0]
    assert remote['cancelled'] and len(remote['events']) == 2
    assert remote['events'][0]['classifications'][0]['amount'] == '100.00'
    assert jobs.status(comp['id'])['job']['state'] == 'completed'


def test_cancel_restore_company_edit_and_repeated_tokens_do_not_advance(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    queued = queue(jobs, comp); claimed = jobs.claim()
    jobs.cancel(comp['id'], queued['id'], 'Owner'); jobs.process(claimed)
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 0
    queue(jobs, comp); claimed = jobs.claim()
    comp = repo.save_company({**comp, 'name': 'Edited'}, 'Owner')
    jobs.process(claimed)
    assert jobs.status(comp['id'])['job']['state'] == 'failed'
    token = '<continuationToken><nextPartitionKey>p</nextPartitionKey><nextRowKey>r</nextRowKey></continuationToken>'
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page(token=token)))
    queue(jobs, comp); jobs.process(jobs.claim()); jobs.process(jobs.claim())
    assert jobs.status(comp['id'])['job']['state'] == 'failed'
    assert jobs.status(comp['id'])['job']['pages'] == 1
    envelope = repo.backup()
    assert 'test-secret' not in json.dumps(envelope)
    snapshot = repo.validate_backup(envelope)
    assert 'test-secret' not in json.dumps(snapshot)
    queue(jobs, comp); claimed = jobs.claim()
    repo.restore(snapshot, 'Restorer'); jobs.process(claimed)
    assert jobs.claim() is None
    with pytest.raises(HTTPException):
        repo.save_company({**repo.companies()[0], 'vatNumber': OTHER}, 'Owner')


def test_matching_company_scope_business_candidates_and_revision_checks(repo, monkeypatch):
    comp = company(repo)
    local_invoice = local(repo, comp, markReviewed=True)
    jobs = SyncJobs(repo, config())
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    queue(jobs, comp); jobs.process(jobs.claim())
    remote = jobs.intake.list(comp['id'], '2025-01', '2025-01')['records'][0]
    assert not remote['invoiceId'] and len(remote['candidates']) == 1
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 1
    payload = {'remoteRevision': remote['revision'], 'invoiceId': local_invoice['id'], 'revision': local_invoice['revision']}
    linked = jobs.intake.match(comp['id'], remote['id'], payload, 'Owner')
    assert linked['invoiceId'] == local_invoice['id']
    assert not repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]['reviewed']
    other = repo.save_company({'name': 'Other company', 'vatNumber': OTHER}, 'Owner')
    with pytest.raises(HTTPException) as exc:
        jobs.intake.match(other['id'], remote['id'], payload, 'Owner')
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException):
        jobs.intake.match(comp['id'], remote['id'], payload, 'Owner')


def test_exact_mark_match_and_conflicting_matches_require_review(repo, monkeypatch):
    comp = company(repo)
    saved = local(repo, comp, mark=MARK, markReviewed=True)
    jobs = SyncJobs(repo, config())
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    queue(jobs, comp); jobs.process(jobs.claim())
    remote = jobs.intake.list(comp['id'], '2025-01', '2025-01')['records'][0]
    assert remote['invoiceId'] == saved['id']
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 1
    # A different company/profile does not share the first company's MARK match.
    other = company(repo, name='Second', vatNumber=OTHER, readPrincipal='representative')
    conflict = local(repo, other, mark=MARK, total='999')
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page(invoice(vat=OTHER))))
    queue(jobs, other); jobs.process(jobs.claim())
    remote2 = jobs.intake.list(other['id'], '2025-01', '2025-01')['records'][0]
    assert remote2['invoiceId'] is None and remote2['candidates'][0]['conflicts']
    with pytest.raises(HTTPException, match='conflicting'):
        jobs.intake.match(other['id'], remote2['id'], {'remoteRevision': remote2['revision'], 'invoiceId': conflict['id'], 'revision': conflict['revision']}, 'Owner')


def test_attach_original_and_backup_keeps_remote_evidence_and_cancels_jobs(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    queue(jobs, comp); jobs.process(jobs.claim())
    saved = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    attached = repo.upload(comp['id'], '2000-01', 'invoice.png', png(), 'Owner', {'id': saved['id'], 'revision': saved['revision']})['invoice']
    assert attached['id'] == saved['id'] and attached['supplier'] == 'Example supplier'
    assert attached['reviewMonth'] == '2025-01' and attached['documentId']
    with pytest.raises(HTTPException):
        repo.upload(comp['id'], '2000-01', 'invoice.png', png(), 'Owner', {'id': attached['id'], 'revision': attached['revision']})
    queue(jobs, comp)
    snapshot = repo.validate_backup(repo.backup())
    bad = copy.deepcopy(snapshot)
    bad['mydata_remote_records'][0]['facts']['payloadHash'] = 'tampered'
    with pytest.raises(HTTPException):
        repo.validate_backup({'version': 1, 'algorithm': 'AES-256-GCM', 'ciphertext': base64.b64encode(repo.encrypt(json.dumps(bad).encode(), 'mydata:backup:v1')).decode()})
    repo.restore(snapshot, 'Restorer')
    assert jobs.status(comp['id'])['job']['state'] == 'cancelled'
    assert jobs.claim() is None
    assert jobs.intake.list(comp['id'], '2025-01', '2025-01')['records'][0]['mark'] == MARK


def test_session_routes_metadata_no_write_and_test_mode(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    app = FastAPI()
    def auth():
        return {'name': 'Owner'}
    settings = config(); settings.frontend_origin = 'http://localhost:5173'
    app.include_router(build_router(repo, auth, settings, sync_jobs=jobs))
    client = TestClient(app)
    base = '/api/tools/mydata-invoices'
    assert client.get(base+'/companies').json()['aadeWrites'] is False
    status = client.get(f"{base}/companies/{comp['id']}/connection")
    assert status.json()['ready'] is True and 'test-secret' not in status.text
    url = f"{base}/companies/{comp['id']}/connection/test"
    payload = {'start': '2025-01', 'end': '2025-01', 'companyRevision': comp['revision']}
    assert client.post(url, json=payload, headers={'Origin': 'https://evil.example'}).status_code == 403
    assert client.post(url, json=payload).status_code == 200
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    jobs.process(jobs.claim())
    assert jobs.status(comp['id'])['job']['state'] == 'completed'
    assert repo.invoices(comp['id'], '2025-01', '2025-01')['total'] == 0
    assert client.post(f"{base}/companies/{comp['id']}/submit", json={}).status_code == 404
    app.dependency_overrides[auth] = lambda: (_ for _ in ()).throw(HTTPException(401, 'login'))
    assert client.get(f"{base}/companies/{comp['id']}/sync").status_code == 401


def test_cancelled_by_mark_and_old_backup_compatibility(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    cancelled = invoice().replace(f"<mark>{MARK}</mark>", f"<mark>{MARK}</mark><cancelledByMark>777777</cancelledByMark>")
    monkeypatch.setattr(sync_jobs, "request_docs", Mock(return_value=page(cancelled)))
    queue(jobs, comp); jobs.process(jobs.claim())
    assert jobs.intake.list(comp["id"], "2025-01", "2025-01")["records"][0]["cancelled"] is True
    snapshot = repo.validate_backup(repo.backup())
    snapshot.pop("mydata_remote_records"); snapshot.pop("mydata_sync_jobs")
    envelope = {"version": 1, "algorithm": "AES-256-GCM", "ciphertext": base64.b64encode(repo.encrypt(json.dumps(snapshot).encode(), "mydata:backup:v1")).decode()}
    restored = repo.validate_backup(envelope)
    assert restored["mydata_remote_records"] == restored["mydata_sync_jobs"] == []
    repo.restore(restored, "Restorer")
    assert jobs.status(comp["id"])["job"] is None


def test_same_mark_in_test_and_production_never_reuses_imported_test_draft(repo, monkeypatch):
    comp = company(repo)
    settings = config()
    settings.mydata_slot_1_prod_user_id = "prod-user"
    settings.mydata_slot_1_prod_subscription_key = "prod-secret"
    settings.mydata_slot_1_prod_vat_number = VAT
    jobs = SyncJobs(repo, settings)
    monkeypatch.setattr(sync_jobs, "request_docs", Mock(return_value=page()))
    queue(jobs, comp); jobs.process(jobs.claim())
    comp = repo.save_company({**comp, "readConnection": "slot_1_prod"}, "Owner")
    queue(jobs, comp); jobs.process(jobs.claim())
    records = jobs.intake.list(comp["id"], "2025-01", "2025-01")["records"]
    assert len(records) == 2 and len({r["invoiceId"] for r in records}) == 2
    assert {r["environment"] for r in records} == {"test", "prod"}


def test_attach_route_multipart_keeps_draft_and_checks_revision(repo):
    comp = company(repo)
    saved = local(repo, comp)
    app = FastAPI()
    settings = config(); settings.frontend_origin = "http://localhost:5173"
    app.include_router(build_router(repo, lambda: {"name": "Owner"}, settings))
    client = TestClient(app)
    url = f"/api/tools/mydata-invoices/companies/{comp['id']}/invoices/{saved['id']}/document"
    response = client.post(url, data={"revision": saved["revision"]}, files={"file": ("receipt.png", png(), "image/png")})
    assert response.status_code == 200
    result = response.json()
    assert result["invoice"]["id"] == saved["id"] and result["invoice"]["description"] == saved["description"]
    assert result["extraction"]["state"] == "queued"
    assert client.post(url, data={"revision": saved["revision"]}, files={"file": ("receipt.png", png(), "image/png")}).status_code == 409


def serialized_page(content):
    from xml.etree.ElementTree import Element, tostring
    wrapper = Element("{http://schemas.microsoft.com/2003/10/Serialization/}string")
    wrapper.text = content.decode("utf-8")
    return tostring(wrapper, encoding="utf-8", xml_declaration=True)


def test_production_serialized_xml_matches_direct_response_and_retains_wire_hash():
    import hashlib
    token = "<continuationToken><nextPartitionKey>partition</nextPartitionKey><nextRowKey>row</nextRowKey></continuationToken>"
    event = f"<cancelledInvoicesDoc><cancelledInvoice><invoiceMark>{MARK}</invoiceMark><cancellationMark>8888</cancellationMark><cancellationDate>2025-01-18</cancellationDate></cancelledInvoice></cancelledInvoicesDoc>"
    direct = page(token=token, events=event)
    wrapped = serialized_page(direct)
    expected, actual = parse_page(direct, VAT), parse_page(wrapped, VAT)
    assert actual["records"] == expected["records"]
    assert actual["events"] == expected["events"] and actual["token"] == expected["token"]
    assert actual["responseHash"] == hashlib.sha256(wrapped).hexdigest()
    assert actual["responseHash"] != expected["responseHash"]
    assert parse_page(serialized_page(page("")), VAT)["records"] == []


@pytest.mark.parametrize("content", [serialized_page(b"<!DOCTYPE x [<!ENTITY x 'unsafe'>]><RequestedDoc/>"),
    serialized_page(serialized_page(page())), serialized_page(b"<html>Login</html>"),
    serialized_page(b""), serialized_page(b"broken XML"),
    b'<string xmlns="http://schemas.microsoft.com/2003/10/Serialization/"><RequestedDoc/></string>',
    b'<string xmlns="https://untrusted.example">&lt;RequestedDoc/&gt;</string>'])
def test_serialized_response_rejects_unsafe_nested_or_unsupported_envelopes(content):
    with pytest.raises(aade.ReadError):
        parse_page(content, VAT)
