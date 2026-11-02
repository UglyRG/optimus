"""Bounded, namespace-aware read model for the pinned AADE RequestedDoc contract."""
from datetime import date
from decimal import Decimal
import hashlib
import re
from xml.etree.ElementTree import tostring

from defusedxml import ElementTree as ET

from .aade import MAX_RESPONSE, ReadError
from .qr_invoice import PREFIX as P, one, text

E = '{https://www.aade.gr/myDATA/expensesClassificaton/v1.0}'
I = '{https://www.aade.gr/myDATA/incomeClassificaton/v1.0}'
SERIALIZED_STRING = '{http://schemas.microsoft.com/2003/10/Serialization/}string'


def mark(value):
    if not re.fullmatch(r'[0-9]{1,80}', value):
        raise ReadError('AADE returned an invalid MARK.')
    return value


def amount(value):
    if not re.fullmatch(r'-?[0-9]{1,16}(?:\.[0-9]{1,8})?', value):
        raise ReadError('AADE returned an unsupported amount format.')
    return format(Decimal(value), 'f')


def tree(node):
    return {'name': node.tag, 'value': (node.text or '').strip(), 'children': [tree(child) for child in node]}


def classification_rows(node, path=''):
    rows = []
    name = node.tag.rsplit('}', 1)[-1]
    path += '/' + name
    values = {child.tag.rsplit('}', 1)[-1]: (child.text or '').strip() for child in node if not len(child)}
    if 'classificationCategory' in values or 'classificationType' in values:
        if 'amount' in values:
            values['amount'] = amount(values['amount'])
        rows.append({'path': path, **values})
    for child in node:
        rows.extend(classification_rows(child, path))
    return rows


def invoice_record(node, target_vat):
    issuer = one(node, 'issuer', True)
    recipient = one(node, 'counterpart')
    if recipient is None or text(recipient, 'vatNumber') != target_vat:
        return None  # RequestDocs includes other event types; never import sales as purchases.
    header = one(node, 'invoiceHeader', True)
    summary = one(node, 'invoiceSummary', True)
    issued = text(header, 'issueDate', True)
    try:
        if date.fromisoformat(issued).isoformat() != issued:
            raise ValueError()
    except ValueError:
        raise ReadError('AADE returned an invalid invoice issue date.') from None
    supplier_vat = text(issuer, 'vatNumber', True)
    number, series = text(header, 'aa', True), text(header, 'series')
    currency = text(header, 'currency') or 'EUR'
    if len(number) > 100 or len(series) > 100 or len(supplier_vat) > 32 or not re.fullmatch('[A-Z]{3}', currency):
        raise ReadError('AADE returned unsupported invoice identity fields.')
    summary_names = ('totalNetValue', 'totalVatAmount', 'totalGrossValue', 'totalWithheldAmount',
                     'totalFeesAmount', 'totalStampDutyAmount', 'totalOtherTaxesAmount', 'totalDeductionsAmount')
    totals = {key: amount(text(summary, key, key in summary_names[:3]) or '0') for key in summary_names}
    rows, refs = [], []
    for row in node.findall(P + 'invoiceDetails'):
        if len(rows) >= 500:
            raise ReadError('AADE returned more than 500 lines in one purchase.')
        line = text(row, 'lineNumber', True)
        if not re.fullmatch('[0-9]+', line) or line in refs:
            raise ReadError('AADE returned ambiguous invoice line references.')
        refs.append(line)
        rows.append({'lineNumber': line, 'description': text(row, 'itemDescr')[:2000],
                     'net': amount(text(row, 'netValue', True)), 'vat': amount(text(row, 'vatAmount', True)),
                     'vatCategory': text(row, 'vatCategory'), 'recType': text(row, 'recType'),
                     'classifications': classification_rows(row)})
    warnings = []
    # Tax/recType rows may not sum like ordinary item rows. Preserve them without inventing allocations.
    if rows and any(sum(Decimal(row[k]) for row in rows) != Decimal(totals[t]) for k, t in (('net', 'totalNetValue'), ('vat', 'totalVatAmount'))):
        warnings.append('Remote lines do not sum to summary totals; inspect tax and special line types.')
    adjustment = sum(Decimal(totals[k]) for k in ('totalFeesAmount', 'totalStampDutyAmount', 'totalOtherTaxesAmount')) - sum(Decimal(totals[k]) for k in ('totalWithheldAmount', 'totalDeductionsAmount'))
    if Decimal(totals['totalNetValue']) + Decimal(totals['totalVatAmount']) + adjustment != Decimal(totals['totalGrossValue']):
        warnings.append('Remote summary does not reconcile using ordinary taxes and deductions.')
    if adjustment or any(Decimal(totals[k]) for k in summary_names[3:]):
        warnings.append('Special taxes, withholding or deductions require review; no tax treatment is inferred.')
    cancelled_by = text(node, 'cancelledByMark')
    if cancelled_by:
        mark(cancelled_by)
    xml = tostring(node, encoding='unicode')
    return {'mark': mark(text(node, 'mark', True)), 'uid': text(node, 'uid'), 'issuerVat': supplier_vat,
            'cancelled': bool(cancelled_by), 'cancelledByMark': cancelled_by, 'recipientVat': target_vat, 'supplier': text(issuer, 'name')[:200], 'number': number, 'series': series,
            'issueDate': issued, 'reviewMonth': issued[:7], 'currency': currency, 'invoiceType': text(header, 'invoiceType', True),
            'summary': totals, 'adjustment': format(adjustment, 'f'), 'lines': rows,
            'classifications': classification_rows(summary), 'warnings': warnings,
            'payloadHash': hashlib.sha256(xml.encode()).hexdigest(), 'rawXml': xml}


def parse_page(content, target_vat):
    if not content or len(content) > MAX_RESPONSE:
        raise ReadError('The AADE response is empty or exceeds the intake limit.')
    try:
        root = ET.fromstring(content, forbid_dtd=True, forbid_entities=True, forbid_external=True)
        # Production can serialize RequestedDoc as escaped XML inside this exact WCF string.
        # Unwrap once only; both layers retain DTD/entity and response-size protections.
        if root.tag == SERIALIZED_STRING:
            inner = root.text or ''
            if len(root) or not inner.strip() or len(inner.encode('utf-8')) > MAX_RESPONSE:
                raise ReadError('AADE returned an invalid serialized XML response. No cursor was advanced.')
            root = ET.fromstring(inner, forbid_dtd=True, forbid_entities=True, forbid_external=True)
        if root.tag != P + 'RequestedDoc' or len(list(root.iter())) > 100000:
            raise ReadError('AADE did not return the expected RequestedDoc XML. No cursor was advanced.')
        allowed = {'continuationToken', 'invoicesDoc', 'cancelledInvoicesDoc', 'incomeClassificationsDoc', 'expensesClassificationsDoc', 'paymentMethodsDoc'}
        if any(child.tag not in {P + name for name in allowed} for child in root):
            raise ReadError('AADE returned an unsupported response section. No cursor was advanced.')
        for name in allowed:
            one(root, name)
        token_node = one(root, 'continuationToken')
        token = None if token_node is None else {key: text(token_node, key, True) for key in ('nextPartitionKey', 'nextRowKey')}
        if token and any(len(v) > 2048 for v in token.values()):
            raise ReadError('AADE returned an oversized continuation token.')
        records, skipped, seen = [], 0, set()
        container = one(root, 'invoicesDoc')
        if container is not None:
            for node in container:
                if node.tag != P + 'invoice':
                    raise ReadError('AADE returned an unexpected invoice element.')
                record = invoice_record(node, target_vat)
                if not record:
                    skipped += 1
                    continue
                if record['mark'] in seen:
                    raise ReadError('AADE returned duplicate invoice MARKs in one page.')
                seen.add(record['mark'])
                records.append(record)
        events = []
        for section, item, prefix in (('cancelledInvoicesDoc', 'cancelledInvoice', P),
                                     ('incomeClassificationsDoc', 'incomeInvoiceClassification', I),
                                     ('expensesClassificationsDoc', 'expensesInvoiceClassification', E)):
            container = one(root, section)
            if container is None:
                continue
            # The wrapper item is in invoice NS; its type's fields use the imported classification NS.
            for node in container:
                if node.tag != P + item:
                    raise ReadError('AADE returned an unexpected classification/cancellation element.')
                ids = node.findall(prefix + 'invoiceMark')
                if len(ids) != 1:
                    raise ReadError('AADE returned an event without a unique invoice reference.')
                xml = tostring(node, encoding='unicode')
                events.append({'mark': mark((ids[0].text or '').strip()), 'kind': section,
                               'hash': hashlib.sha256(xml.encode()).hexdigest(), 'data': tree(node),
                               'classifications': classification_rows(node)})
        return {'records': records, 'events': events, 'token': token, 'skipped': skipped,
                'responseHash': hashlib.sha256(content).hexdigest()}
    except ReadError:
        raise
    except Exception:
        raise ReadError('AADE returned invalid or unsafe XML. No cursor was advanced.') from None


def editable_facts(record):
    """Initialize a new draft only. Retain unsupported precision in remote evidence."""
    warnings = list(record['warnings'])
    def cents(value):
        result = Decimal(value)
        if abs(result) >= Decimal('1000000000000') or result != result.quantize(Decimal('0.01')):
            warnings.append('Remote amounts exceed editable draft precision; enter reviewed values manually.')
            return ''
        return format(result, '.2f')
    kind = 'credit_note' if record['invoiceType'] in {'5.1', '5.2', '11.4'} else 'retail_receipt' if record['invoiceType'] in {'11.1','11.2','11.3','11.5'} else 'supplier_invoice' if record['invoiceType'] in {'1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '2.1', '2.2', '2.3', '2.4'} else 'other'
    if kind == 'other':
        warnings.append('This AADE document type requires manual review; it is not assumed to be an ordinary supplier invoice.')
    if kind == 'credit_note':
        warnings.append('Credit amounts retain the remote signs. No expense or VAT sign treatment is inferred.')
    result = {'reviewMonth': record['reviewMonth'], 'kind': kind, 'supplier': record['supplier'], 'supplierVat': record['issuerVat'],
              'series': record['series'], 'number': record['number'], 'issueDate': record['issueDate'], 'currency': record['currency'],
              'mark': record['mark'], 'net': cents(record['summary']['totalNetValue']), 'vat': cents(record['summary']['totalVatAmount']),
              'total': cents(record['summary']['totalGrossValue']), 'otherTaxes': cents(record['adjustment']),
              'lines': [{'description': row['description'], 'net': cents(row['net']), 'vat': cents(row['vat']), 'category': '', 'type': ''} for row in record['lines']]}
    result['description'] = '; '.join(row['description'] for row in record['lines'][:3] if row['description'])[:2000]
    return result, list(dict.fromkeys(warnings))
