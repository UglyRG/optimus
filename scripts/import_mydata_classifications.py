"""Build the offline dropdown catalogue from pinned public AADE sources (read-only).

Run with the bundled Python runtime containing openpyxl and pypdf; these are import-time
requirements, not new Optimus server dependencies. Original workbook cells are untouched.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile

import openpyxl
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / 'backend_py/optimus_api/mydata/contracts'
WORKBOOK_URL = 'https://www.aade.gr/sites/default/files/2026-09/syndiasmoi_xaraktirismwn_v2.0.2_0.xlsx'
PDF_URL = 'https://www.aade.gr/sites/default/files/2026-09/myDATA%20API%20Documentation%20v2.0.2_official_erp_1.pdf'


def build(workbook, api_pdf, schema_zip):
    labels, pages = {}, {}
    pdf = PdfReader(api_pdf)
    for page in range(99, 103):
        current = None
        for line in pdf.pages[page].extract_text(extraction_mode='layout').splitlines():
            found = re.match(r'^\s*(category2_[0-9]+|E3_[0-9]+(?:_[0-9]+)?|VAT_[0-9]+|NOT_VAT_[0-9]+)\s+(.+)', line)
            if found:
                current = found[1]
                assert current not in labels, f'Duplicate label: {current}'
                labels[current] = found[2].strip()
                pages[current] = page
            elif current and line.strip() and not line.strip().startswith('myDATA REST API'):
                labels[current] += ' ' + line.strip()
    with zipfile.ZipFile(schema_zip) as archive:
        simple_types = ET.fromstring(archive.read('SimpleTypes-v2.0.2.xsd'))
    ns = {'x': 'http://www.w3.org/2001/XMLSchema'}
    def enum(name):
        return [e.attrib['value'] for e in simple_types.findall(f"x:simpleType[@name='{name}']//x:enumeration", ns)]
    categories = enum('ExpensesClassificationCategoryType')
    values = enum('ExpensesClassificationValueType')
    # The schema also permits four third-party sales codes, labelled in appendix 8.9.
    for line in pdf.pages[98].extract_text(extraction_mode='layout').splitlines():
        found = re.match(r'^\s*(E3_881_00[1-4])\s+(.+)', line)
        if found:
            labels[found[1]], pages[found[1]] = found[2].strip(), 98
    assert set(categories + values) <= labels.keys(), 'An official code has no appendix label'
    wb = openpyxl.load_workbook(workbook, data_only=True)
    doc_types = {}
    unavailable = []
    for sheet in wb:
        title = str(sheet.cell(1, 2).value or '').strip()
        entry = {'label': re.sub(r'^ΤΥΠΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ:\s*' + re.escape(sheet.title) + r'\s*-\s*', '', title),
                 'categories': {}, 'notes': []}
        expense_header = str(sheet.cell(5, 5).value or '').replace('E', 'Ε')
        if 'ΕΞΟΔΩΝ' in expense_header:
            current = None
            for row in range(7, sheet.max_row + 1):
                cat, value = sheet.cell(row, 5).value, sheet.cell(row, 6).value
                if cat and re.fullmatch('category2_[0-9]+', str(cat)):
                    assert cat in categories
                    current = cat
                    entry['categories'].setdefault(cat, {'types': [], 'mode': 'explicit', 'notes': [], 'sourceRow': row})
                elif cat:
                    current = None
                    entry['notes'].append(str(cat).strip())
                if current and value:
                    item = entry['categories'][current]
                    value = str(value).strip()
                    if re.fullmatch('E3_[0-9]+(?:_[0-9]+)?', value):
                        if value not in values:
                            unavailable.append({'code': value, 'label': labels.get(value, value), 'sheet': sheet.title, 'cell': f'F{row}'})
                        else:
                            item['types'].append(value)
                    elif 'Δεν ενημερώνει E3' in value or 'Δεν γίνεται χαρακτηρισμός E3' in value:
                        item['mode'] = 'no_e3'
                        item['notes'].append(value)
                    else:
                        item['mode'] = 'conditional'
                        item['notes'].append(value)
            # Prior/next-year categories reference earlier classifications, with an extra
            # period/base-category condition. Expose choices but do not mark them validated.
            base_types = sorted({t for c, v in entry['categories'].items() if c not in {'category2_10', 'category2_11'} for t in v['types']})
            for cat, item in entry['categories'].items():
                item['types'] = sorted(set(item['types']))
                if item['mode'] == 'conditional' and cat in {'category2_10', 'category2_11'}:
                    item['types'] = base_types
        entry['mode'] = 'explicit' if entry['categories'] else 'conditional' if entry['notes'] else 'not_listed'
        doc_types[sheet.title] = entry
    combined = {}
    for cat in categories:
        entries = [d['categories'][cat] for d in doc_types.values() if cat in d['categories']]
        types = sorted({t for e in entries for t in e['types']})
        combined[cat] = {'types': types, 'mode': 'conditional' if cat in {'category2_10', 'category2_11'} else 'explicit' if types else 'no_e3'}
    digest = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
    return {'version': 'aade-2.0.2-2026-09', 'retrievedAt': '2026-11-02',
            'sources': {'combinations': {'url': WORKBOOK_URL, 'sha256': digest(workbook)},
                        'labels': {'url': PDF_URL, 'sha256': digest(api_pdf), 'pages': [98, 99, 100, 101, 102]},
                        'schemaPackageSha256': digest(schema_zip)},
            'sourceDiscrepancies': {'appendixCodesAbsentFromExpenseSchema': sorted(set(labels) - set(categories + values)), 'workbookCodesAbsentFromExpenseSchema': unavailable},
            'categories': [{'code': c, 'label': labels[c], 'page': pages[c]} for c in categories],
            'e3Types': [{'code': c, 'label': labels[c], 'page': pages[c]} for c in values if c.startswith('E3_')],
            'vatClassifications': [{'code': c, 'label': labels[c], 'page': pages[c]} for c in values if not c.startswith('E3_')],
            'invoiceTypes': doc_types, 'categoryTypes': combined}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('api_pdf', type=Path)
    parser.add_argument('schema_zip', type=Path)
    args = parser.parse_args()
    result = build(args.workbook, args.api_pdf, args.schema_zip)
    (CONTRACTS / 'classification-catalogue.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    shutil.copyfile(args.workbook, CONTRACTS / 'classification-combinations-v2.0.2.xlsx')
    print({'categories': len(result['categories']), 'e3Types': len(result['e3Types']),
           'vatClassifications': len(result['vatClassifications']), 'invoiceTypes': len(result['invoiceTypes'])})
