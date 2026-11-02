"""Resolve recognised QR references and compare them with local extraction before proposing."""
import hashlib

from .qr import recognise
from .qr_invoice import read_invoice
from .qr_transport import LookupError, fetch_xml


def inspect_references(pages):
    references = {}
    for page in pages:
        for raw in page.get("qrCodes", []):
            # Recognition is re-run server-side; no trust in subprocess/link metadata.
            payload = raw.get("payload")
            if not isinstance(payload, str) or not payload or len(payload) > 4096:
                continue
            recognised = recognise(payload)
            ref_id = hashlib.sha256(payload.encode()).hexdigest()
            references.setdefault(ref_id, {**raw, **recognised, "id": ref_id, "page": page["page"]})
    return list(references.values())


def resolve(result, company, enabled=False, choice=None, fetcher=None, alive=lambda: True):
    references = inspect_references(result["pages"])
    qr = {"references": references, "status": "not_found", "message": "No QR code found.", "selectedId": None,
          "source": None, "aadeVerified": False, "conflicts": [], "data": None}
    result["qr"] = qr
    if not references:
        return qr
    eligible = [ref for ref in references if ref["kind"] != "unsupported"]
    if not eligible:
        qr.update(status="unsupported", message="QR code found, but its destination is not a supported invoice source. Local extraction is available.")
        return qr
    selected = next((ref for ref in eligible if ref["id"] == choice), None)
    if choice and not selected:
        qr.update(status="invalid_selection", message="The selected QR reference is not present in this document. Choose a detected reference.")
        return qr
    if not selected and len(eligible) != 1:
        qr.update(status="needs_selection", message="Several invoice/receipt QR references were found. Choose one and extract again; no link was opened.")
        return qr
    selected = selected or eligible[0]
    qr["selectedId"] = selected["id"]
    if selected["kind"] == "provider_reference":
        qr.update(status="provider_reference", message=f"{selected['provider']} QR found. Open the verification page to view the document. Automatic data retrieval for this provider is not implemented; local extraction remains available.")
        return qr
    if selected["kind"] == "aade_receipt":
        qr.update(status="receipt_reference", message="AADE receipt QR found. Its encoded total is an unverified hint; full receipt retrieval is not implemented.")
        hint = selected.get("receiptHint", {})
        qr["receiptHint"] = hint
        if hint.get("total") and "total" not in result["fields"]:
            result["fields"]["total"] = {"label": "Total amount", "value": hint["total"], "raw": hint["total"], "basis": "qr_unverified",
                "reviewRequired": True, "evidence": {"source": "qr_payload", "page": selected["page"], "method": "qr_decode",
                "text": "Total encoded in the receipt QR; not checked against AADE."}}
        elif hint.get("total") and result["fields"]["total"]["value"] != hint["total"]:
            qr["conflicts"].append({"field": "total", "local": result["fields"]["total"]["value"], "remote": hint["total"]})
            qr["message"] += " The encoded total differs from the document extraction; review both."
        return qr
    if selected["kind"] == "aade_invoice":
        qr.update(status="aade_reference", message="AADE invoice verification QR found. Structured AADE import needs the company read connector, which is not connected yet.")
        return qr
    if not enabled:
        qr.update(status="lookup_disabled", message="Provider invoice QR found. Enable QR lookup and extract again to retrieve its structured data.")
        return qr
    if not alive():
        return qr
    try:
        content = (fetcher or fetch_xml)(selected["downloadUrl"])
        if not alive():
            return qr
        data = read_invoice(content, selected)
    except LookupError as exc:
        qr.update(status="unavailable", message=str(exc) + " Local extraction is available.")
        return qr
    except Exception:
        qr.update(status="unavailable", message="QR lookup could not be completed. Local extraction is available.")
        return qr
    qr.update(data=data, source="provider")
    conflicts = qr["conflicts"]
    if company.get("vatNumber") and data["recipientVat"] and company["vatNumber"] != data["recipientVat"]:
        conflicts.append({"field": "recipientVat", "local": company["vatNumber"], "remote": data["recipientVat"]})
    for key in ("supplierVat", "number", "issueDate", "currency", "mark", "net", "vat", "total"):
        local, remote = result["fields"].get(key), data["fields"].get(key)
        if local and remote and local["value"] != remote["value"]:
            conflicts.append({"field": key, "local": local["value"], "remote": remote["value"]})
    if conflicts:
        qr.update(status="conflict", message="Provider data was retrieved, but company or document values differ. No provider fields were substituted; review the differences.")
        return qr
    if data["specialTaxes"]:
        qr.update(status="review_required", message="Provider data includes withholding, fees or other adjustments. Review the structured details before entering allocations manually.")
        return qr
    qr.update(status="retrieved", message=f"Structured invoice data retrieved from {selected['provider']}. Review the suggested fields before applying. This is not an AADE acceptance check.")
    if not company.get("vatNumber") or not data["recipientVat"]:
        qr["message"] += " Recipient identity could not be confirmed against the company profile."
    else:
        qr["recipientMatched"] = True
    compared = sum(key in result["fields"] for key in ("supplierVat", "number", "issueDate", "currency", "mark", "net", "vat", "total"))
    if compared < 8:
        qr["message"] += " Only available printed fields could be compared; check the original document."
    result["fields"].update(data["fields"])
    result["ambiguous"] = [key for key in result["ambiguous"] if key not in data["fields"]]
    result["documentFacts"]["providerInvoice"] = {key: value for key, value in data.items() if key not in {"fields", "rawXml"}}
    return qr
