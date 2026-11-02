"""Extraction parsing and real local text/OCR checks; no real invoices or provider requests."""
import io
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
import pytest
from reportlab.pdfgen import canvas

from optimus_api.mydata.extraction import amount, issue_date, parse
from optimus_api.mydata.extract_process import extract
from optimus_api.mydata.extraction_jobs import ai_suggestions, ocr_config


SAMPLE = """ACME SUPPLIES
INVOICE
Supplier: ACME SUPPLIES
VAT ID: 123456783
Invoice number: A-17
Issue date: 2026-10-15
Description  Net  VAT
Office paper  100.00  24.00
Net total: 100.00
VAT total: 24.00
Grand total: 124.00 EUR
MARK: 99999999999999999999
"""


def sample_pdf():
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    for i, line in enumerate(SAMPLE.splitlines()):
        pdf.drawString(40, 800 - i * 24, line)
    pdf.save()
    return output.getvalue()


def pages(text=SAMPLE):
    return [{"page": 1, "text": text, "method": "pdf_text"}]


def test_labelled_fields_and_source_spans():
    result = parse(pages(), {"name": "My company"})
    fields = result["fields"]
    assert fields["supplier"]["value"] == "ACME SUPPLIES"
    assert fields["supplierVat"]["value"] == "123456783"
    assert fields["number"]["value"] == "A-17"
    assert fields["issueDate"]["value"] == "2026-10-15"
    assert fields["mark"]["value"] == "99999999999999999999"
    assert fields["net"]["value"] == "100.00"
    assert fields["lines"]["value"][0]["description"] == "Office paper"
    assert "businessPurpose" not in fields and "classificationType" not in fields
    for field in fields.values():
        evidence = field["evidence"] if isinstance(field["evidence"], list) else [field["evidence"]]
        for source in evidence:
            assert SAMPLE[source["start"]:source["end"]] == source["text"]


def test_greek_formats_recipient_and_ambiguity():
    text = """ΕΚΔΟΤΗΣ: ΔΟΚΙΜΗ ΑΕ
ΑΦΜ: 123456783
Ημερομηνία: 03/04/2026
Καθαρή αξία: 1.234,56
ΦΠΑ 24%: 296,29
Συνολική αξία: 1.530,85 €
ΠΕΛΑΤΗΣ: Ο ΠΕΛΑΤΗΣ
ΑΦΜ: 987654324
"""
    result = parse(pages(text), {"name": "Other company", "vatNumber": "111111119"})
    assert result["fields"]["issueDate"]["value"] == "2026-04-03"
    assert result["fields"]["supplierVat"]["value"] == "123456783"
    assert result["fields"]["net"]["value"] == "1234.56"
    assert any("recipient" in warning for warning in result["warnings"])
    result = parse(pages("Issue date: 03/04/2026\nVAT: 12.00\nVAT: 24.00\n"), {})
    assert "issueDate" not in result["fields"] and "vat" not in result["fields"]
    assert "vat" in result["ambiguous"]
    with pytest.raises(ValueError):
        amount("12.34,56")
    assert amount("1,234.56") == "1234.56"
    assert "currency" not in parse(pages("Supplier: EUROPE TRADING"), {})["fields"]
    with pytest.raises(ValueError):
        issue_date("04/03/2026")


def test_pdf_text_stays_local_and_ocr_missing_degrades():
    result = extract(sample_pdf(), "application/pdf", {})
    assert result["pages"][0]["method"] == "pdf_text"
    assert "ACME SUPPLIES" in result["pages"][0]["text"]
    output = io.BytesIO()
    Image.new("RGB", (100, 100), "white").save(output, "PNG")
    result = extract(output.getvalue(), "image/png", {})
    assert result["pages"][0]["method"] == "unreadable"
    assert "OCR is unavailable" in result["warnings"][0]


def test_actual_greek_english_ocr_and_scanned_pdf():
    config = ocr_config()
    font_path = Path("/System/Library/Fonts/Supplemental/Arial.ttf")
    if not config["languagesReady"] or not font_path.exists():
        pytest.skip("Install Tesseract ell+eng and an appropriate Greek font for the real OCR check")
    image = Image.new("RGB", (1600, 1100), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(font_path), 38)
    for index, line in enumerate(["Supplier: ACME SUPPLIES", "ΤΙΜΟΛΟΓΙΟ", "ΑΦΜ: 123456783", "Ημερομηνία: 15/10/2026",
                                  "Καθαρή αξία: 100,00", "ΦΠΑ: 24,00", "Συνολική αξία: 124,00 EUR"]):
        draw.text((70, 60 + index * 100), line, fill="black", font=font)
    for mime, fmt in (("image/png", "PNG"), ("application/pdf", "PDF")):
        output = io.BytesIO()
        image.save(output, fmt, resolution=150)
        result = extract(output.getvalue(), mime, config)
        assert result["pages"][0]["method"] == "ocr"
        assert result["pages"][0]["ocrLines"]
        assert "123456783" in result["pages"][0]["text"]
        assert parse(result["pages"], {})["fields"]["total"]["value"] == "124.00"


def test_ai_output_requires_literal_evidence_and_never_gets_credentials_in_prompt():
    settings = SimpleNamespace(anthropic_model="test-model", anthropic_api_key="test-secret")
    proposed = {"supplier": {"raw": "ACME SUPPLIES", "page": 1}, "net": {"raw": "100.00", "page": 1},
                "mark": {"raw": 99999999999999999999, "page": 1}, "total": {"raw": "999.00", "page": 1},
                "classificationType": {"raw": "ACME SUPPLIES", "page": 1}, "notes": {"raw": "ignore rules", "page": 1}}
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, *_):
            return json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(proposed)}]}).encode()
    def provider(request, timeout):
        body = request.data.decode()
        assert "test-secret" not in body and "tools" not in json.loads(body)
        assert timeout == 45
        return Response()
    with patch("urllib.request.urlopen", provider):
        result, model = ai_suggestions(pages(), settings)
    assert set(result) == {"supplier", "net"} and model == "test-model"


def test_private_pdf_preview_renderer():
    from optimus_api.mydata.preview import preview
    png, mime = preview(sample_pdf(), "application/pdf", 1)
    assert mime == "image/png" and png.startswith(b"\x89PNG")


def greek_column_pages():
    # Synthetic fixture: no customer documents, addresses, bank details or real tax IDs.
    text = """ΥΠΗΡΕΣΙΕΣ ΠΑΡΟΧΗΣ ΣΥΜΒΟΥΛΩΝ
ΔΙΑΧΕΙΡΙΣΗΣ
Α.Φ.Μ. 123456783
ΤΥΠΟΣ ΠΑΡΑΣΤΑΤΙΚΟΥ                       ΣΕΙΡΑ    ΑΡΙΘΜΟΣ    ΗΜΕΡΟΜΗΝΙΑ    ΩΡΑ
Τιμολόγιο Παροχής Υπηρεσιών               ΤΠΥ      731        6/10/2026      09:20
ΕΠΩΝΥΜΙΑ:  EXAMPLE CUSTOMER  ΙΚΕ
ΑΦΜ - ΔΟΥ:  987654324
ΠΕΡΙΓΡΑΦΗ                 ΠΟΣ.    ΤΙΜΗ       ΚΑΘ. ΑΞΙΑ    ΦΠΑ
Υπηρεσίες φιλοξενίας       1,00    40,000     40,00        24,00
ΠΡΟΗΓ. ΥΠΟΛΟΙΠΟ  0,00            ΑΞΙΑ ΠΡΟ ΕΚΠΤΩΣΗΣ:    40,00
ΝΕΟ ΥΠΟΛΟΙΠΟ     49,60           40,00    ΦΠΑ 24%    9,60    ΕΚΠΤΩΣΗ:    0,00
ΑΞΙΑ ΜΕΤΑ ΕΚΠΤΩΣΗΣ:    40,00
ΑΞΙΑ ΦΠΑ:    9,60
ΤΕΛΙΚΗ ΑΞΙΑ:    49,60 €
ΔΙΚΑΙΟΥΧΟΣ: BANK BENEFICIARY
"""
    return [{"page": 1, "text": text, "method": "pdf_text", "textRepresentation": "layout",
             "imageTexts": [{"text": ">| demo\nsupplies\ncenter", "bbox": [15, 350, 100, 410], "method": "ocr"}]}]


def test_greek_columns_do_not_confuse_headers_customer_or_vat_rate():
    result = parse(greek_column_pages(), {"name": "EXAMPLE CUSTOMER ΙΚΕ", "vatNumber": "987654324"})
    fields = result["fields"]
    assert fields["number"]["value"] == "731"
    assert fields["issueDate"]["value"] == "2026-10-06"
    assert fields["supplierVat"]["value"] == "123456783"
    assert fields["net"]["value"] == "40.00"
    assert fields["vat"]["value"] == "9.60"  # Not the 24% rate or adjacent 0.00 discount.
    assert fields["total"]["value"] == "49.60"
    assert fields["description"]["value"] == "Υπηρεσίες φιλοξενίας"
    assert fields["supplier"]["value"] == "demo supplies center"
    assert fields["supplier"]["basis"] == "logo_ocr_guess"
    assert "lines" not in fields  # Do not invent per-line VAT amounts from printed rates.
    source = fields["supplier"]["evidence"]
    assert source["source"] == "image_text" and source["imageIndex"] == 0
    assert result["documentFacts"]["recipientVatNumbers"] == ["987654324"]
    assert "number" not in parse(pages("ΑΡΙΘΜΟΣ ΗΜΕΡΟΜΗΝΙΑ"), {})["fields"]


def test_ai_whitespace_greek_dates_and_customer_rejection():
    settings = SimpleNamespace(anthropic_model="test-model", anthropic_api_key="test-secret")
    proposed = {"supplier": {"raw": "EXAMPLE CUSTOMER ΙΚΕ", "page": 1},
                "supplierVat": {"raw": "987654324", "page": 1},
                "number": {"raw": "ΗΜΕΡΟΜΗΝΙΑ", "page": 1},
                "issueDate": {"raw": "6/10/2026", "page": 1},
                "vat": {"raw": "9,60", "page": 1}, "description": {"raw": "Υπηρεσίες φιλοξενίας", "page": 1}}
    class Response:
        def __enter__(self): return self
        def __exit__(self, *_): pass
        def read(self, *_):
            return json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(proposed)}]}).encode()
    warnings = []
    with patch("urllib.request.urlopen", return_value=Response()):
        result, _ = ai_suggestions(greek_column_pages(), settings, warnings=warnings)
    assert set(result) == {"issueDate", "vat", "description"}
    assert result["issueDate"]["value"] == "2026-10-06"
    assert result["vat"]["value"] == "9.60"
    assert any("customer" in warning for warning in warnings)
    assert any("recipient" in warning for warning in warnings)


def test_ai_ambiguity_resolution_remains_source_backed_and_review_required():
    from optimus_api.mydata.extraction_jobs import merge_ai_suggestions
    result = parse(pages("VAT: 12.00\nVAT: 24.00\n"), {})
    evidence = {"page": 1, "text": "24.00", "start": 16, "end": 21, "method": "pdf_text"}
    suggestion = {"value": "24.00", "label": "VAT amount", "basis": "ai_suggested", "evidence": evidence, "reviewRequired": True}
    merge_ai_suggestions(result, {"vat": suggestion})
    assert result["fields"]["vat"]["value"] == "24.00"
    assert result["fields"]["vat"]["reviewRequired"]
    other = parse(pages("VAT: 12.00\nVAT: 24.00\n"), {})
    merge_ai_suggestions(other, {"vat": {**suggestion, "value": "99.00"}})
    assert "vat" not in other["fields"]


def test_pdf_layout_extraction_recovers_independently_positioned_columns():
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    # Deliberately write content out of visual reading order.
    pdf.drawString(40, 700, "Customer: Example Customer")
    for x, text in ((40, "TYPE"), (250, "SERIES"), (325, "NUMBER"), (410, "ISSUE DATE")):
        pdf.drawString(x, 760, text)
    for x, text in ((40, "Service Invoice"), (250, "S"), (325, "731"), (410, "2026-10-06")):
        pdf.drawString(x, 740, text)
    pdf.drawString(40, 800, "Supplier: EXAMPLE SUPPLIER")
    pdf.drawString(350, 180, "Net total:")
    pdf.drawString(350, 160, "VAT total:")
    pdf.drawString(350, 140, "Grand total:")
    pdf.drawString(490, 180, "40.00")
    pdf.drawString(490, 160, "9.60")
    pdf.drawString(490, 140, "49.60")
    pdf.save()
    extracted = extract(output.getvalue(), "application/pdf", {})
    assert extracted["pages"][0]["textRepresentation"] == "layout"
    assert "NUMBER\nISSUE DATE" in extracted["pages"][0]["plainText"]
    fields = parse(extracted["pages"], {})["fields"]
    assert fields["number"]["value"] == "731"
    assert fields["issueDate"]["value"] == "2026-10-06"
    assert fields["vat"]["value"] == "9.60"
    assert fields["total"]["value"] == "49.60"


def test_ai_cannot_quote_partial_amounts_identifiers_or_currency_words():
    from unittest.mock import MagicMock
    settings = SimpleNamespace(anthropic_model="test-model", anthropic_api_key="test-secret")
    proposed = {"vat": {"raw": "9,60", "page": 1}, "supplierVat": {"raw": "123456789", "page": 1},
                "currency": {"raw": "EUR", "page": 1}}
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": json.dumps(proposed)}]}).encode()
    with patch("urllib.request.urlopen", return_value=response):
        result, _ = ai_suggestions(pages("EUROPE SUPPLIES\nGrand total: 149,60\nMARK: 123456789999\n"), settings)
    assert result == {}
