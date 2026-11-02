"""Evidence-backed suggestions from local document text. Never infers tax treatment."""
from datetime import date
from decimal import Decimal
import re
import unicodedata

from .extraction_layout import cells, is_number, monetary_facts, recipient_name, table_header_facts

VERSION = "local-invoice-v4"
FIELD_LABELS = {
    "supplier": "Supplier", "supplierVat": "Supplier tax ID", "number": "Document number",
    "issueDate": "Issue date", "net": "Net amount", "vat": "VAT amount", "total": "Total amount",
    "otherTaxes": "Other taxes", "mark": "Printed MARK", "currency": "Currency", "kind": "Document kind",
    "description": "Purchase description", "lines": "Purchase lines",
}
AMOUNT = re.compile(r"(?<![\w.,])[-−]?(?:\d{1,3}(?:[., \u00a0]\d{3})+|\d+)[.,]\d{2}(?![\d.,])")
DATE = re.compile(r"\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})\b")


def fold(value):
    return "".join(c for c in unicodedata.normalize("NFD", value) if unicodedata.category(c) != "Mn").upper()


def amount(raw):
    value = raw.strip().replace("−", "-").replace("\u00a0", " ")
    if not AMOUNT.fullmatch(value):
        raise ValueError("Not an explicit two-decimal amount")
    decimal = value[-3]
    integer, fraction = value[:-3], value[-2:]
    grouping = "." if decimal == "," else ","
    if grouping in integer or " " in integer:
        if not re.fullmatch(r"-?\d{1,3}(?:" + re.escape(grouping) + r"\d{3})+|-?\d{1,3}(?: \d{3})+", integer):
            raise ValueError("Ambiguous amount grouping")
    integer = integer.replace(grouping, "").replace(" ", "")
    if not re.fullmatch(r"-?\d{1,12}", integer):
        raise ValueError("Amount exceeds supported precision")
    return format(Decimal(integer + "." + fraction), ".2f")


def issue_date(raw, greek=False):
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return date.fromisoformat(raw).isoformat()
    day, month, year = (int(x) for x in re.split(r"[/.-]", raw))
    if not greek and day <= 12 and month <= 12 and day != month:
        raise ValueError("Ambiguous day/month order")
    return date(year, month, day).isoformat()


def rows(pages):
    result = []
    for page in pages:
        offset = 0
        boxes = {line["line"]: line for line in page.get("ocrLines", [])}
        for position, line in enumerate(page["text"].splitlines(keepends=True)):
            raw = line.rstrip("\r\n")
            if raw.strip():
                evidence = {"page": page["page"], "text": raw, "start": offset, "end": offset + len(raw),
                            "method": page["method"]}
                if position in boxes:
                    evidence.update(bbox=boxes[position]["bbox"], ocrConfidence=boxes[position]["confidence"])
                result.append({"text": raw, "fold": fold(raw), "evidence": evidence})
            offset += len(line)
    return result


def parse(pages, company):
    candidates, warnings, document_facts = {}, [], {}
    source_rows = rows(pages)

    def add(key, raw, value, row, basis="labelled", priority=2):
        if value != "":
            candidates.setdefault(key, []).append({"raw": raw, "value": value, "basis": basis, "priority": priority,
                                                    "evidence": row["evidence"]})

    table_header_facts(source_rows, add, fold, issue_date)
    recipient, document_heading_seen = False, False
    for row in source_rows:
        raw, normalized = row["text"], row["fold"]
        if "ΤΥΠΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ" in normalized or "ΤΙΜΟΛΟΓΙΟ" in normalized or normalized.strip() == "INVOICE":
            document_heading_seen = True
        name_label = re.match(r"\s*ΕΠΩΝΥΜΙΑ\s*[:：]\s*(.+)", normalized)
        if name_label and document_heading_seen:
            recipient = True
            document_facts.setdefault("recipientNames", []).append(raw[name_label.start(1):].strip())
        party_label = re.match(r"\s*(?:CUSTOMER|RECIPIENT|BILL TO|ΠΕΛΑΤΗΣ|ΠΑΡΑΛΗΠΤΗΣ)\s*[:：]\s*(.+)", normalized)
        if party_label:
            recipient = True
            document_facts.setdefault("recipientNames", []).append(raw[party_label.start(1):].strip())
        if re.search(r"\b(CUSTOMER|RECIPIENT|BILL TO|ΠΕΛΑΤΗΣ|ΠΑΡΑΛΗΠΤΗΣ)\b|ΣΤΟΙΧΕΙΑ ΠΕΛΑΤΗ", normalized):
            recipient = True
        if re.search(r"\b(SUPPLIER|ISSUER|ΕΚΔΟΤΗΣ|ΠΡΟΜΗΘΕΥΤΗΣ)\b", normalized):
            recipient = False
        row["recipient"] = recipient
        label = re.match(r"\s*(?:SUPPLIER|ISSUER|ΕΚΔΟΤΗΣ|ΠΡΟΜΗΘΕΥΤΗΣ)\s*[:：]\s*(.+)", raw, re.I)
        if not label:
            label = re.match(r"\s*(?:ΕΚΔΟΤΗΣ|ΠΡΟΜΗΘΕΥΤΗΣ)\s*[:：]\s*(.+)", normalized)
        if label:
            value = raw[label.start(1):].strip()
            add("supplier", value, value[:200], row)
        if re.search(r"\b(VAT\s*(?:NO\.?|NUMBER|ID)|TAX\s*ID|Α\.?\s*Φ\.?\s*Μ\.?)\b", normalized):
            values = re.findall(r"(?<!\d)(?:EL\s*)?(\d{9})(?!\d)", raw, re.I)
            for value in values:
                if recipient:
                    document_facts.setdefault("recipientVatNumbers", []).append(value)
                elif value != company.get("vatNumber"):
                    add("supplierVat", value, value, row)
        if re.search(r"ΗΜΕΡΟΜΗΝΙΑ|\bISSUE DATE\b|\bINVOICE DATE\b|^\s*DATE\s*:", normalized) and not re.search(r"ΛΗΞΗ|DUE|PAYMENT|DELIVERY", normalized):
            for match in DATE.finditer(raw):
                try:
                    add("issueDate", match.group(), issue_date(match.group(), "ΗΜΕΡΟΜΗΝΙΑ" in normalized), row)
                except ValueError:
                    warnings.append("Issue date is ambiguous or invalid; enter it manually from the original.")
        number = re.search(r"(?:INVOICE\s*(?:NO\.?|NUMBER|#)|RECEIPT\s*(?:NO\.?|NUMBER|#)|ΑΡΙΘΜΟΣ(?:\s+ΠΑΡΑΣΤΑΤΙΚΟΥ)?|Α/Α)\s*[:#：]?\s*([\w][\w./-]*)", normalized)
        if number:
            value = raw[number.start(1):number.end(1)]
            if is_number(value):
                add("number", value, value, row)
        mark = re.search(r"(?:\bMARK\b|\bΜΑΡΚ\b|Μ\.Α\.Ρ\.Κ\.)\s*[:：]?\s*(\d+)", normalized)
        if mark:
            add("mark", mark.group(1), mark.group(1), row)
        monetary_facts(row, add, fold, AMOUNT, amount)
        for symbol, code in (("€", "EUR"), ("EUR", "EUR"), ("USD", "USD"), ("GBP", "GBP")):
            if (symbol == "€" and symbol in normalized) or (symbol != "€" and re.search(r"\b" + symbol + r"\b", normalized)):
                add("currency", symbol, code, row)
        if re.search(r"CREDIT NOTE|ΠΙΣΤΩΤΙΚΟ", normalized):
            add("kind", raw, "credit_note", row)
        elif re.search(r"RETAIL RECEIPT|ΑΠΟΔΕΙΞΗ\s+ΛΙΑΝΙΚΗΣ", normalized):
            add("kind", raw, "retail_receipt", row)
        elif re.search(r"\bINVOICE\b|ΤΙΜΟΛΟΓΙΟ", normalized) and not re.search(r"NUMBER|NO\.|DATE|ΑΡΙΘΜΟΣ", normalized):
            add("kind", raw, "supplier_invoice", row)

    # Only explicitly headed tables with matching columns are parsed. No reconstruction from totals.
    header, parsed_lines, line_evidence, descriptions, description_evidence = None, [], [], [], []
    for row in source_rows:
        columns = cells(row["text"])
        labels = [fold(cell).strip() for cell in columns]
        desc = next((i for i, label in enumerate(labels) if label in {"DESCRIPTION", "ΠΕΡΙΓΡΑΦΗ"}), None)
        net = next((i for i, label in enumerate(labels) if label in {"NET", "NET AMOUNT", "ΚΑΘΑΡΗ ΑΞΙΑ", "ΚΑΘ. ΑΞΙΑ"}), None)
        vat = next((i for i, label in enumerate(labels) if label in {"VAT", "VAT AMOUNT", "ΦΠΑ", "Φ.Π.Α."}), None)
        if all(index is not None for index in (desc, net, vat)):
            header = (desc, net, vat, len(columns), labels[vat] in {"ΦΠΑ", "Φ.Π.Α."})
            continue
        if header:
            d, n, v, width, possible_rate = header
            if len(columns) != width or re.search(r"ΣΥΝΟΛ|TOTAL", row["fold"]):
                header = None
                continue
            if columns[d] and re.search(r"[A-Za-zΑ-Ωα-ω]", columns[d]):
                descriptions.append(columns[d][:2000])
                description_evidence.append(row["evidence"])
            if possible_rate:
                document_facts.setdefault("printedLineTables", []).append({"columns": columns, "evidence": row["evidence"]})
                continue
            try:
                line = {"description": columns[d][:2000], "net": amount(columns[n]), "vat": amount(columns[v]), "category": "", "type": ""}
            except ValueError:
                header = None
                continue
            if line["description"]:
                parsed_lines.append(line)
                line_evidence.append(row["evidence"])
    if parsed_lines:
        candidates["lines"] = [{"value": parsed_lines[:500], "raw": "Printed line table", "basis": "labelled_table",
                                 "evidence": line_evidence[:500]}]
        candidates["description"] = [{"value": "; ".join(line["description"] for line in parsed_lines[:3])[:2000],
                                       "raw": "Printed item descriptions", "basis": "printed_lines", "evidence": line_evidence[:3]}]
    if descriptions:
        candidates["description"] = [{"value": "; ".join(descriptions[:3])[:2000], "raw": "Printed item descriptions", "basis": "printed_lines", "priority": 2, "evidence": description_evidence[:3]}]
    if "supplier" not in candidates:
        for row in source_rows[:8]:
            value = row["text"].strip()
            if not row.get("recipient") and len(value) >= 4 and not value.endswith(":") and not re.search(r"INVOICE|RECEIPT|ΤΙΜΟΛΟΓΙΟ|ΑΠΟΔΕΙΞΗ|CUSTOMER|ΠΕΛΑΤ|Α\.?Φ\.?Μ|VAT|DATE|ΗΜΕΡΟΜΗΝΙΑ|MARK|ΚΩΔΙΚΟΣ|ΕΠΩΝΥΜΙΑ|ΔΙΕΥΘΥΝΣΗ|ΠΟΛΗ|\d{4}|ΥΠΗΡΕΣΙΕΣ|ΔΙΑΧΕΙΡΙΣΗΣ|ΕΠΑΓΓΕΛΜΑ|ΤΡΑΠΕΖ|ΔΙΚΑΙΟΥΧΟΣ|BANK|IBAN|EMAIL|ΤΗΛ|ΔΟΥ|Τ\.Κ\.", row["fold"]) and not recipient_name(value, company, document_facts, fold):
                add("supplier", value, value[:200], row, "header_guess")
                break
    if "supplier" not in candidates:
        image_candidates = []
        for page in pages:
            for image_index, region in enumerate(page.get("imageTexts", [])):
                lines = [re.sub(r"^[^\w]+", "", line).strip() for line in region["text"].splitlines()]
                value = " ".join(line for line in lines if line)
                if value and len(value) <= 200 and not recipient_name(value, company, document_facts, fold):
                    image_candidates.append({"value": value, "raw": region["text"], "basis": "logo_ocr_guess", "priority": 1,
                                             "evidence": {"page": page["page"], "text": region["text"], "start": 0, "end": len(region["text"]),
                                             "method": "ocr", "source": "image_text", "imageIndex": image_index,
                                             "bbox": region["bbox"], "bboxUnits": "pdf_points"}})
        if len(image_candidates) == 1:
            candidates["supplier"] = image_candidates
            warnings.append("Supplier name was read from header branding. Verify the legal or trading name against the original.")
    fields, ambiguous = {}, []
    for key, values in candidates.items():
        priority = max(value.get("priority", 2) for value in values)
        values = [value for value in values if value.get("priority", 2) == priority]
        distinct = {json_value(value["value"]) for value in values}
        if len(distinct) == 1:
            fields[key] = {**values[0], "label": FIELD_LABELS[key], "reviewRequired": True}
        else:
            ambiguous.append(key)
            warnings.append(f"Several different values were found for {FIELD_LABELS[key]}; check the original.")
    recipients = set(document_facts.get("recipientVatNumbers", []))
    if company.get("vatNumber") and recipients and recipients != {company["vatNumber"]}:
        warnings.append("The printed recipient tax ID differs from this company. Check that the document belongs here.")
    if all(key in fields for key in ("net", "vat", "total")):
        expected = Decimal(fields["net"]["value"]) + Decimal(fields["vat"]["value"]) + Decimal(fields.get("otherTaxes", {}).get("value", "0"))
        if expected != Decimal(fields["total"]["value"]):
            warnings.append("Extracted amounts do not reconcile. Check all totals before reviewing.")
    if "supplier" not in fields:
        warnings.append("Issuer name could not be identified reliably. Customer details were not used as the supplier.")
    return {"version": VERSION, "candidates": candidates, "fields": fields, "ambiguous": ambiguous, "warnings": list(dict.fromkeys(warnings)),
            "documentFacts": document_facts, "pages": pages, "provider": "local"}


def json_value(value):
    import json
    return json.dumps(value, sort_keys=True)
