"""Official dropdown contracts, code pairings and compatibility with saved working notes."""
import copy
import hashlib
from pathlib import Path
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
import pytest

from optimus_api.mydata import classifications, domain
from optimus_api.mydata.routes import build_router
from test_mydata import repo
from test_mydata_intake import VAT, company, local, page, config, queue
from optimus_api.mydata import sync_jobs
from optimus_api.mydata.sync_jobs import SyncJobs
from unittest.mock import Mock


def selection(**changes):
    return domain.invoice({'reviewMonth': '2026-10', 'mydataInvoiceType': '1.1',
                          'classificationCategory': 'category2_4', 'classificationType': 'E3_585_016',
                          'vatClassification': 'VAT_361', **changes})


def test_catalogue_is_official_expense_only_and_source_pinned():
    data = classifications.catalogue()
    assert len(data['categories']) == 15
    assert len(data['e3Types']) == 84 and len(data['vatClassifications']) == 7
    assert next(v for v in data['e3Types'] if v['code'] == 'E3_585_016')['label'] == 'Λοιπά έξοδα'
    assert next(v for v in data['vatClassifications'] if v['code'] == 'VAT_361')['label'] == 'Αγορές & δαπάνες στο εσωτερικό της χώρας'
    assert not any(v['code'].startswith('category1_') for v in data['categories'])
    assert not any(v['code'].startswith('VAT_') for v in data['e3Types'])
    assert 'E3_585_017' not in {v['code'] for v in data['e3Types']}
    assert data['sourceDiscrepancies']['workbookCodesAbsentFromExpenseSchema']
    path = Path(classifications.__file__).parent / 'contracts/classification-combinations-v2.0.2.xlsx'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == data['sources']['combinations']['sha256']
    assert data['invoiceTypes']['1.1']['categories']['category2_4']['sourceRow'] == 31


def test_document_category_filters_have_specific_pairings_and_conditional_types():
    rules, exact = classifications.category_rules('1.1')
    assert exact and 'E3_585_009' in rules['category2_3']['types']
    assert 'E3_585_010' not in rules['category2_3']['types']
    foreign, exact = classifications.category_rules('14.3')
    assert exact and 'E3_585_010' in foreign['category2_3']['types']
    assert 'E3_585_009' not in foreign['category2_3']['types']
    assert rules['category2_95']['mode'] == 'no_e3'
    assert rules['category2_10']['mode'] == 'conditional'
    assert classifications.category_rules('5.1')[1] is False
    assert classifications.category_rules('')[1] is False


def test_valid_choices_partial_choices_and_no_automatic_vat_inference():
    facts = selection()
    assert classifications.check_selections(facts, {}, {})['warnings'] == []
    partial = selection(classificationType='')
    assert 'E3 code has not been chosen' in ' '.join(classifications.check_selections(partial, {}, {})['warnings'])
    no_e3 = selection(classificationCategory='category2_95', classificationType='', vatClassification='NOT_VAT_295')
    assert classifications.check_selections(no_e3, {}, {})['warnings'] == []
    assert selection(classificationCategory='category2_5')['vatClassification'] == 'VAT_361'
    assert 'period' in ' '.join(classifications.check_selections(selection(classificationCategory='category2_10'), {}, {})['warnings'])
    assert 'document type' in ' '.join(classifications.check_selections(selection(mydataInvoiceType=''), {}, {})['warnings'])


@pytest.mark.parametrize('changes', [
    {'classificationCategory': 'category1_1'}, {'classificationType': 'invented_code'},
    {'vatClassification': 'deductible'}, {'classificationType': 'VAT_361'},
    {'mydataInvoiceType': '900.1'}, {'classificationCategory': 'category2_95'},
    {'classificationCategory': 'category2_1'},
    {'classificationCategory': 'category2_6'},
])
def test_new_invalid_or_incompatible_codes_rejected_on_backend(changes):
    with pytest.raises(HTTPException) as exc:
        classifications.check_selections(selection(**changes), {}, {})
    assert exc.value.status_code == 400


def test_legacy_notes_are_retained_and_line_choices_checked():
    old = selection(classificationCategory='office costs', classificationType='my accountant notes', vatClassification='')
    current = copy.deepcopy(old)
    current['notes'] = 'Unrelated fact edit'
    result = classifications.check_selections(current, old, {})
    assert any('existing typed expense category' in item for item in result['warnings'])
    assert current['classificationCategory'] == 'office costs'
    bad_line = selection(lines=[{'description': 'Line', 'net': '100', 'vat': '24', 'category': 'category2_1', 'type': 'E3_585_016'}])
    with pytest.raises(HTTPException, match='Line 1'):
        classifications.check_selections(bad_line, {}, {})
    good_line = selection(lines=[{'description': 'Line', 'net': '100', 'vat': '24', 'category': 'category2_4', 'type': 'E3_585_016', 'vatClassification': 'VAT_361'}])
    assert not classifications.check_selections(good_line, {}, {})['warnings']
    old_line = selection(lines=[{'description': 'Line', 'category': 'old note', 'type': ''}])
    assert classifications.check_selections(old_line, old_line, {})['warnings']


def test_remote_type_takes_precedence_and_cannot_be_overridden():
    with pytest.raises(HTTPException, match='differs'):
        classifications.check_selections(selection(mydataInvoiceType='14.3'), {}, {'remoteInvoiceType': '1.1'})
    facts = selection(mydataInvoiceType='', classificationCategory='category2_3', classificationType='E3_585_009')
    assert classifications.check_selections(facts, {}, {'remoteInvoiceType': '1.1'})['invoiceType'] == '1.1'
    with pytest.raises(HTTPException, match='combination'):
        classifications.check_selections(facts, {}, {'remoteInvoiceType': '14.3'})


def test_saved_dropdown_choices_and_backup_roundtrip(repo):
    comp = company(repo)
    saved = local(repo, comp, **{k: selection()[k] for k in ('classificationCategory','classificationType','vatClassification','mydataInvoiceType')},
                  lines=[{'description': 'Office', 'net': '100', 'vat': '24', 'category': 'category2_4', 'type': 'E3_585_016', 'vatClassification': 'VAT_361'}])
    assert saved['classificationCheck']['catalogueVersion'] == classifications.catalogue()['version']
    assert saved['lines'][0]['vatClassification'] == 'VAT_361'
    with pytest.raises(HTTPException):
        repo.save_invoice(comp['id'], {**saved, 'classificationType': 'E3_102_006'}, 'Owner')
    repo.restore(repo.validate_backup(repo.backup()), 'Restorer')
    result = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    assert result['vatClassification'] == 'VAT_361' and result['lines'][0]['type'] == 'E3_585_016'
    assert result['classificationCheck']['catalogueVersion'] == saved['classificationCheck']['catalogueVersion']


def test_catalogue_and_invoice_options_require_session_and_company_scope(repo, monkeypatch):
    comp = company(repo)
    jobs = SyncJobs(repo, config())
    monkeypatch.setattr(sync_jobs, 'request_docs', Mock(return_value=page()))
    queue(jobs, comp); jobs.process(jobs.claim())
    saved = repo.invoices(comp['id'], '2025-01', '2025-01')['invoices'][0]
    app = FastAPI()
    def auth(): return {'name': 'Owner'}
    app.include_router(build_router(repo, auth, SimpleNamespace(frontend_origin='http://localhost:5173'), sync_jobs=jobs))
    client = TestClient(app)
    base = '/api/tools/mydata-invoices'
    result = client.get(base + '/classification-options')
    assert result.status_code == 200 and result.headers['cache-control'] == 'no-store'
    result = client.get(f"{base}/companies/{comp['id']}/invoices/{saved['id']}/classification-options")
    assert result.json()['context']['remoteInvoiceType'] == '1.1'
    other = repo.save_company({'name': 'Other'}, 'Owner')
    assert client.get(f"{base}/companies/{other['id']}/invoices/{saved['id']}/classification-options").status_code == 404
    app.dependency_overrides[auth] = lambda: (_ for _ in ()).throw(HTTPException(401, 'login'))
    assert client.get(base + '/classification-options').status_code == 401
