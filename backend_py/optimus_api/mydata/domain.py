"""Deterministic draft validation; no tax treatment is inferred here."""
from datetime import date
from decimal import Decimal, InvalidOperation
import re
from uuid import UUID

from fastapi import HTTPException


def fail(message):
    raise HTTPException(400, message)


def identifier(value):
    try:
        return str(UUID(str(value)))
    except (ValueError, TypeError):
        fail("Invalid record ID")


def text(value, limit=200):
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > limit:
        fail(f"Enter text of at most {limit} characters")
    return value.strip()


def month(value):
    value = text(value, 7)
    if not re.fullmatch(r"\d{4}-\d{2}", value):
        fail("Choose a review month (YYYY-MM)")
    try:
        date.fromisoformat(value + "-01")
    except ValueError:
        fail("Invalid review month")
    return value


def money(value):
    value = text(value, 30)
    if not value:
        return ""
    # Decimal comma is accepted; grouped thousands are intentionally rejected as ambiguous.
    if not re.fullmatch(r"-?\d{1,12}([.,]\d{1,2})?", value):
        fail("Amounts need up to two decimal places, without thousands separators")
    try:
        return format(Decimal(value.replace(",", ".")).quantize(Decimal("0.01")), ".2f")
    except InvalidOperation:
        fail("Invalid amount")


def vat_number(value):
    value = text(value, 32)
    if value and (not value.isascii() or not value.isdigit() or len(value) != 9):
        fail("Greek company ΑΦΜ must contain nine digits")
    if value:
        checksum = sum(int(digit) * 2 ** (8 - i) for i, digit in enumerate(value[:8])) % 11 % 10
        if checksum != int(value[-1]):
            fail("Greek company ΑΦΜ checksum is invalid")
    return value


READ_CONNECTIONS = {f"slot_{slot}_{env}" for slot in range(1, 4) for env in ("test", "prod")}


def company(payload):
    name = text(payload.get("name"), 200)
    if not name:
        fail("Company name is required")
    alias = payload.get("readConnection", "")
    principal = payload.get("readPrincipal", "company")
    if alias not in READ_CONNECTIONS | {""} or principal not in {"company", "representative"}:
        fail("Choose a supported AADE connection and access type")
    return {"readConnection": alias, "readPrincipal": principal, "name": name, "vatNumber": vat_number(payload.get("vatNumber")),
            "notes": text(payload.get("notes"), 4000)}


def invoice(payload):
    result = {key: text(payload.get(key), limit) for key, limit in {
        "supplier": 200, "supplierVat": 32, "number": 100, "series": 100, "issueDate": 10,
        "description": 2000, "businessPurpose": 2000, "classificationCategory": 120,
        "classificationType": 120, "vatTreatment": 500, "vatClassification": 32, "mydataInvoiceType": 20, "notes": 8000, "mark": 80,
    }.items()}
    if result["issueDate"]:
        try:
            date.fromisoformat(result["issueDate"])
        except ValueError:
            fail("Issue date must be a valid YYYY-MM-DD date")
    if result["mark"] and not re.fullmatch(r"\d+", result["mark"]):
        fail("MARK must contain digits and is stored as text")
    kind = payload.get("kind", "supplier_invoice")
    if kind not in {"supplier_invoice", "retail_receipt", "credit_note", "other"}:
        fail("Invalid purchase document kind")
    currency = text(payload.get("currency", "EUR"), 3).upper()
    if not re.fullmatch("[A-Z]{3}", currency):
        fail("Currency must be a three-letter code")
    lines = payload.get("lines", [])
    if not isinstance(lines, list) or len(lines) > 500 or any(not isinstance(row, dict) for row in lines):
        fail("At most 500 purchase lines are supported")
    result.update(kind=kind, currency=currency, reviewMonth=month(payload.get("reviewMonth")),
                  lines=[{"description": text(row.get("description"), 2000),
                          "net": money(row.get("net")), "vat": money(row.get("vat")),
                          "category": text(row.get("category"), 120),
                          "type": text(row.get("type"), 120),
                          "vatClassification": text(row.get("vatClassification"), 32)} for row in lines])
    for key in ("net", "vat", "otherTaxes", "total"):
        result[key] = money(payload.get(key))
    return result


def review_issues(facts):
    issues = []
    for key, label in (("supplier", "Supplier"), ("issueDate", "Issue date"),
                       ("description", "Purchase description"), ("net", "Net amount"),
                       ("vat", "VAT amount"), ("total", "Total amount")):
        if not facts.get(key):
            issues.append(f"{label} is missing")
    if all(facts.get(key) for key in ("net", "vat", "total")):
        expected = Decimal(facts["net"]) + Decimal(facts["vat"]) + Decimal(facts.get("otherTaxes") or "0")
        if expected != Decimal(facts["total"]):
            issues.append("Net + VAT + other taxes does not equal total")
    if facts.get("lines") and all(row["net"] and row["vat"] for row in facts["lines"]):
        for key in ("net", "vat"):
            if facts.get(key) and sum(Decimal(row[key]) for row in facts["lines"]) != Decimal(facts[key]):
                issues.append(f"Line {key} amounts do not equal the document {key}")
    return issues
