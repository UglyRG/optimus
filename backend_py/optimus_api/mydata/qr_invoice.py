"""Read a single provider myDATA invoice and propose facts, never accounting codes."""
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import re

from defusedxml import ElementTree as ET

from ..utils import now_iso
from .extraction import FIELD_LABELS
from .qr_transport import LookupError

NS = "http://www.aade.gr/myDATA/invoice/v1.0"
PREFIX = "{" + NS + "}"


def one(parent, name, required=False):
    found = parent.findall(PREFIX + name)
    if len(found) > 1 or (required and not found):
        raise LookupError("The provider returned an ambiguous or incomplete invoice.")
    return found[0] if found else None


def text(parent, name, required=False):
    node = one(parent, name, required)
    value = (node.text or "").strip() if node is not None else ""
    if required and not value:
        raise LookupError("The provider returned an incomplete invoice.")
    return value


def decimal(value):
    # Exact decimal normalization only: no rounding of unknown schema precision.
    if not re.fullmatch(r"-?\d{1,12}(?:\.\d{1,8})?", value):
        raise LookupError("An invoice amount has an unsupported format.")
    try:
        result = Decimal(value)
        if result != result.quantize(Decimal("0.01")):
            raise LookupError("An invoice amount needs more precision than this workspace supports.")
        return format(result, ".2f")
    except InvalidOperation as exc:
        raise LookupError("An invoice amount could not be read exactly.") from exc


def read_invoice(content, reference):
    try:
        root = ET.fromstring(content, forbid_dtd=True, forbid_entities=True, forbid_external=True)
    except Exception as exc:
        raise LookupError("The provider did not return safe myDATA invoice XML.") from exc
    if root.tag != PREFIX + "InvoicesDoc" or len(list(root.iter())) > 10000:
        raise LookupError("The provider returned an unsupported document format.")
    invoice = one(root, "invoice", required=True)
    if len(root) != 1:
        raise LookupError("The provider returned more than one document; choose a single invoice.")
    issuer = one(invoice, "issuer", required=True)
    recipient = one(invoice, "counterpart")
    header = one(invoice, "invoiceHeader", required=True)
    summary = one(invoice, "invoiceSummary", required=True)
    issuer_vat = text(issuer, "vatNumber", True)
    if issuer_vat != reference["issuerVat"] or not re.fullmatch(r"\d{9}", issuer_vat):
        raise LookupError("The returned issuer does not match the QR invoice reference.")
    mark = text(invoice, "mark", True)
    number = text(header, "aa", True)
    issued = text(header, "issueDate", True)
    currency = text(header, "currency", True)
    if not re.fullmatch(r"\d{1,80}", mark) or len(number) > 100 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", issued) or not re.fullmatch(r"[A-Z]{3}", currency):
        raise LookupError("The returned invoice identity is invalid.")
    try:
        date.fromisoformat(issued)
    except ValueError as exc:
        raise LookupError("The returned invoice date is invalid.") from exc
    summary_values = {key: decimal(text(summary, key, key in {"totalNetValue", "totalVatAmount", "totalGrossValue"}) or "0") for key in (
        "totalNetValue", "totalVatAmount", "totalGrossValue", "totalWithheldAmount", "totalFeesAmount", "totalStampDutyAmount", "totalOtherTaxesAmount", "totalDeductionsAmount")}
    rows = invoice.findall(PREFIX + "invoiceDetails")
    if not 1 <= len(rows) <= 500:
        raise LookupError("The invoice has an unsupported number of lines.")
    lines, metadata, numbers = [], [], set()
    for row in rows:
        line_number = text(row, "lineNumber", True)
        if not line_number.isascii() or not line_number.isdigit() or line_number in numbers:
            raise LookupError("The provider returned invalid or duplicate line references.")
        numbers.add(line_number)
        description = text(row, "itemDescr")
        if len(description) > 2000:
            raise LookupError("A provider line description is too long.")
        lines.append({"description": description, "net": decimal(text(row, "netValue", True)),
                      "vat": decimal(text(row, "vatAmount", True)), "category": "", "type": ""})
        metadata.append({"lineNumber": line_number, "itemCode": text(row, "itemCode"), "quantity": text(row, "quantity"),
                         "vatCategory": text(row, "vatCategory"), "descriptionPresent": bool(description)})
    if sum(Decimal(line["net"]) for line in lines) != Decimal(summary_values["totalNetValue"]) or sum(Decimal(line["vat"]) for line in lines) != Decimal(summary_values["totalVatAmount"]):
        raise LookupError("The provider line amounts do not reconcile with its summary.")
    special_taxes = any(Decimal(value) for key, value in summary_values.items() if key not in {"totalNetValue", "totalVatAmount", "totalGrossValue"})
    if not special_taxes and Decimal(summary_values["totalGrossValue"]) != Decimal(summary_values["totalNetValue"]) + Decimal(summary_values["totalVatAmount"]):
        raise LookupError("The provider summary amounts do not reconcile.")
    checksum, retrieved = hashlib.sha256(content).hexdigest(), now_iso()
    fields = {}
    def add(key, value, path):
        if value != "":
            fields[key] = {"value": value, "raw": value, "label": FIELD_LABELS[key], "basis": "provider_xml", "reviewRequired": True,
                           "evidence": {"source": "provider_xml", "page": reference["page"], "method": "structured_download",
                           "provider": reference["provider"], "text": f"{path}: {value}" if not isinstance(value, list) else "Printed line descriptions and exact net/VAT amounts from the provider XML.",
                           "xmlPath": "/InvoicesDoc/invoice/" + path, "responseHash": checksum, "retrievedAt": retrieved}}
    add("supplierVat", issuer_vat, "issuer/vatNumber")
    add("supplier", text(issuer, "name"), "issuer/name")
    add("number", number, "invoiceHeader/aa")
    add("issueDate", issued, "invoiceHeader/issueDate")
    add("currency", currency, "invoiceHeader/currency")
    add("mark", mark, "mark")
    for field, key in (("net", "totalNetValue"), ("vat", "totalVatAmount"), ("total", "totalGrossValue")):
        add(field, summary_values[key], "invoiceSummary/" + key)
    kind = {"1.1": "supplier_invoice", "2.1": "supplier_invoice", "5.1": "credit_note", "5.2": "credit_note",
            "11.1": "retail_receipt", "11.2": "retail_receipt", "11.4": "credit_note"}.get(text(header, "invoiceType"))
    if kind:
        add("kind", kind, "invoiceHeader/invoiceType")
    # Do not reconstruct missing printed descriptions from totals or myDATA type codes.
    add("lines", lines, "invoiceDetails")
    if all(line["description"] for line in lines):
        add("description", "; ".join(line["description"] for line in lines[:3])[:2000], "invoiceDetails/itemDescr")
    return {"fields": fields, "issuerVat": issuer_vat, "recipientVat": text(recipient, "vatNumber") if recipient is not None else "",
            "series": text(header, "series"), "invoiceType": text(header, "invoiceType"), "lineReferences": metadata,
            "summary": summary_values, "specialTaxes": special_taxes, "responseHash": checksum, "retrievedAt": retrieved,
            "rawXml": content.decode("utf-8-sig"), "source": "provider", "aadeVerified": False}
