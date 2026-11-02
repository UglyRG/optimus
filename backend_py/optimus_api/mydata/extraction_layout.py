"""Column-aware invoice facts from layout text, preserving literal row evidence."""
import re

# Ordered alternatives prevent TOTAL inside NET TOTAL from becoming a gross-total label.
MONEY_LABEL = re.compile(
    r"(?P<net>ΑΞΙΑ\s+ΜΕΤΑ\s+ΕΚΠΤΩΣΗΣ|ΚΑΘΑΡΗ\s+ΑΞΙΑ|ΣΥΝΟΛΟ\s+ΚΑΘΑΡ\w*|NET\s*(?:TOTAL|AMOUNT|VALUE)|SUBTOTAL)"
    r"|(?P<vat>(?:ΣΥΝΟΛΟ\s+|ΑΞΙΑ\s+)?Φ\.?\s*Π\.?\s*Α\.?|(?:TOTAL\s+)?\bVAT\b(?:\s+(?:TOTAL|AMOUNT))?)"
    r"|(?P<total>ΓΕΝΙΚΟ\s+ΣΥΝΟΛΟ|ΤΕΛΙΚΟ\s+ΣΥΝΟΛΟ|ΣΥΝΟΛΙΚΗ\s+ΑΞΙΑ|ΤΕΛΙΚΗ\s+ΑΞΙΑ|ΠΛΗΡΩΤΕΟ|GRAND\s+TOTAL|TOTAL\s+DUE|AMOUNT\s+DUE|\bTOTAL\b|^ΣΥΝΟΛΟ(?=\s*[:：]))"
    r"|(?P<otherTaxes>OTHER\s+TAXES|ΛΟΙΠΟΙ\s+ΦΟΡΟΙ)"
)


def cells(raw):
    return [part.strip() for part in re.split(r"\s*\|\s*|\t+| {2,}", raw.strip()) if part.strip()]


def is_number(value):
    return bool(re.fullmatch(r"[\w][\w./-]{0,99}", value) and re.search(r"\d", value))


def table_header_facts(source_rows, add, fold, issue_date):
    for index, row in enumerate(source_rows[:-1]):
        labels = [fold(cell) for cell in cells(row["text"])]
        number = next((i for i, label in enumerate(labels) if label in {"ΑΡΙΘΜΟΣ", "Α/Α", "INVOICE NUMBER", "INVOICE NO", "NUMBER"}), None)
        issued = next((i for i, label in enumerate(labels) if label in {"ΗΜΕΡΟΜΗΝΙΑ", "ISSUE DATE", "INVOICE DATE", "DATE"}), None)
        if number is None or issued is None:
            continue
        following = source_rows[index + 1]
        if following["evidence"]["page"] != row["evidence"]["page"]:
            continue
        values = cells(following["text"])
        if len(values) != len(labels):
            continue
        if is_number(values[number]):
            add("number", values[number], values[number], following, "labelled_columns", 3)
        try:
            value = issue_date(values[issued], greek="ΗΜΕΡΟΜΗΝΙΑ" in labels)
            add("issueDate", values[issued], value, following, "labelled_columns", 3)
        except ValueError:
            pass


def monetary_facts(row, add, fold, amount_pattern, amount):
    values = cells(row["text"])
    for index, cell in enumerate(values):
        normalized = fold(cell)
        if re.search(r"VAT\s*(?:ID|NO|NUMBER)|Α\.?Φ\.?Μ|ΠΕΡΙΓΡΑΦΗ|DESCRIPTION|UNIT PRICE", normalized):
            continue
        labels = list(MONEY_LABEL.finditer(normalized))
        for position, label in enumerate(labels):
            key = label.lastgroup
            if key == "vat" and re.search(r"VAT\s+RATE|ΠΟΣΟΣΤΟ|ΣΥΝΤΕΛΕΣΤΗΣ", normalized):
                continue
            tail = cell[label.end():labels[position + 1].start() if position + 1 < len(labels) else len(cell)]
            matches = [m for m in amount_pattern.finditer(tail) if not re.match(r"\s*%", tail[m.end():])]
            if not matches and len(labels) == 1 and index + 1 < len(values):
                # A labelled value in the next aligned column, never in an arbitrary later row.
                following = values[index + 1]
                match = amount_pattern.fullmatch(re.sub(r"\s*(?:€|EUR|USD|GBP)\s*$", "", following).strip())
                matches = [match] if match else []
            if len(matches) != 1:
                continue
            try:
                value = amount(matches[0].group())
            except ValueError:
                continue
            # Standalone totals outrank individual VAT-breakdown rows.
            label_text = label.group()
            priority = 3 if key != "vat" or re.search(r"ΑΞΙΑ|ΣΥΝΟΛΟ|TOTAL|AMOUNT", label_text) or re.match(r"\s*[:：]", tail) else 1
            add(key, matches[0].group(), value, row, "labelled_columns", priority)


def recipient_name(value, company, document_facts, fold):
    compact = lambda text: re.sub(r"\W+", "", fold(text))
    candidate = compact(value)
    names = [company.get("name", ""), *document_facts.get("recipientNames", [])]
    return any(len(candidate) >= 8 and len(compact(name)) >= 8 and
               (candidate in compact(name) or compact(name) in candidate) for name in names)
