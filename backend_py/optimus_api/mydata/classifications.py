"""Offline official code choices and structural checks, never a tax decision or submission."""
from functools import lru_cache
import json
from pathlib import Path

from fastapi import HTTPException

from . import domain


@lru_cache(maxsize=1)
def catalogue():
    return json.loads((Path(__file__).parent / 'contracts/classification-catalogue.json').read_text())


def context(connection, company_id, invoice_id):
    rows = connection.execute('SELECT facts FROM mydata_remote_records WHERE company_id=%s AND invoice_id=%s', (company_id, invoice_id)).fetchall()
    types = {row['facts'].get('invoiceType') for row in rows if row['facts'].get('invoiceType')}
    return {'remoteInvoiceType': next(iter(types)) if len(types) == 1 else '',
            'conflictingRemoteTypes': len(types) > 1}


def options(repo, company_id=None, invoice_id=None):
    result = {'catalogue': catalogue(), 'context': {'remoteInvoiceType': '', 'conflictingRemoteTypes': False}}
    if invoice_id:
        domain.identifier(company_id); domain.identifier(invoice_id)
        with repo.store.pool.connection() as conn, conn.transaction():
            repo.lock(conn)
            if not conn.execute('SELECT id FROM mydata_invoices WHERE company_id=%s AND id=%s', (company_id, invoice_id)).fetchone():
                raise HTTPException(404, 'Purchase not found')
            result['context'] = context(conn, company_id, invoice_id)
    return result


def category_rules(invoice_type):
    data = catalogue()
    document = data['invoiceTypes'].get(invoice_type)
    if document and document['mode'] == 'explicit':
        return document['categories'], True
    return data['categoryTypes'], False


def check_selections(facts, previous, remote_context):
    """Reject new unknown/incompatible choices; retain existing free-text notes visibly.

    Partial optional selections are savable drafts. Current workbook pairing checks do not
    establish fiscal-year applicability, deduction rights, allocation or AADE eligibility.
    """
    data = catalogue()
    warnings = []
    previous = previous or {}
    chosen_type = facts.get('mydataInvoiceType', '')
    old_type = previous.get('mydataInvoiceType', '')
    remote_type = remote_context.get('remoteInvoiceType', '')
    invoice_type = remote_type or chosen_type
    if chosen_type and chosen_type not in data['invoiceTypes']:
        if chosen_type != old_type:
            domain.fail('Choose an official myDATA document type')
        warnings.append('Saved myDATA document type is absent from the current catalogue.')
    if remote_type and chosen_type and chosen_type != remote_type:
        if chosen_type != old_type:
            domain.fail('The chosen myDATA document type differs from the linked AADE record')
        warnings.append('The saved document type differs from linked AADE evidence; remote type is used for choices.')
    if remote_context.get('conflictingRemoteTypes'):
        warnings.append('Linked AADE records disagree on document type. Document-specific combinations are not established.')
    rules, exact = category_rules(invoice_type)
    category_codes = {v['code'] for v in data['categories']}
    type_codes = {v['code'] for v in data['e3Types']}
    vat_codes = {v['code'] for v in data['vatClassifications']}
    any_selection = False
    old_rows = {(r.get('category', ''), r.get('type', ''), r.get('vatClassification', '')) for r in previous.get('lines', [])}

    def check(category, e3, vat, old, label):
        nonlocal any_selection
        any_selection |= bool(category or e3 or vat)
        values = (category, e3, vat)
        known = True
        for value, prior, valid, field in zip(values, old, (category_codes, type_codes, vat_codes), ('expense category', 'E3 code', 'VAT classification')):
            if value and value not in valid:
                known = False
                if value != prior:
                    domain.fail(f'{label}: choose an official {field} from the dropdown')
                warnings.append(f'{label}: an existing typed {field} is retained for review; choose an official value or clear it.')
        if not known:
            return
        rule = rules.get(category)
        invalid = bool(category and (not rule or e3 and (rule['mode'] == 'no_e3' or e3 not in rule['types'])))
        changed = (category, e3) != old[:2] or chosen_type != old_type
        if invalid:
            if changed:
                domain.fail(f'{label}: this expense category/E3 combination is not listed for the selected myDATA document type. Choose another value or leave the E3 field blank.')
            warnings.append(f'{label}: saved category/E3 combination needs review against the selected document type.')
        elif rule and rule['mode'] == 'conditional':
            warnings.append(f'{label}: this category has additional period or related-document conditions; its combination is not fully validated.')
        if e3 and not category:
            warnings.append(f'{label}: choose an expense category for the selected E3 code.')
        if category and rule and rule['types'] and not e3:
            warnings.append(f'{label}: E3 code has not been chosen.')
    check(facts.get('classificationCategory', ''), facts.get('classificationType', ''), facts.get('vatClassification', ''),
          (previous.get('classificationCategory', ''), previous.get('classificationType', ''), previous.get('vatClassification', '')), 'Document')
    for index, row in enumerate(facts.get('lines', []), 1):
        values = (row.get('category', ''), row.get('type', ''), row.get('vatClassification', ''))
        old = values if values in old_rows else ('', '', '')
        check(*values, old, f'Line {index}')
    if any_selection and not exact:
        warnings.append('Choose/confirm the myDATA document type to establish document-specific combinations; related-document types require additional review.')
    return {'catalogueVersion': data['version'], 'invoiceType': invoice_type,
            'scope': 'dropdown-codes-and-listed-pairings-only', 'warnings': list(dict.fromkeys(warnings))}
