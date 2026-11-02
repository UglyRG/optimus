"""QR decode, safe read-only retrieval and structured data tests. No live requests."""
import hashlib
import io
from types import SimpleNamespace
from unittest.mock import Mock

from PIL import Image
import pytest
import qrcode
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader

from optimus_api.mydata.extract_process import extract
from optimus_api.mydata.extraction import parse
from optimus_api.mydata.qr import decode, recognise
from optimus_api.mydata.qr_invoice import read_invoice
from optimus_api.mydata.qr_lookup import resolve
from optimus_api.mydata.qr_transport import LookupError, fetch_xml, public_addresses, PinnedHTTPS

QR_URL = "https://einvoice.impact.gr/p/EL123456783/" + "A" * 40 + "/" + "B" * 32
OTHER_URL = "https://einvoice.impact.gr/p/EL123456783/" + "C" * 40 + "/" + "D" * 32


def xml(**changes):
    values = {"issuer": "123456783", "recipient": "987654324", "mark": "99999999999999999999", "net": "40.00", "vat": "9.60", "gross": "49.60", **changes}
    return f'''<?xml version="1.0" encoding="utf-8"?>
<InvoicesDoc xmlns="http://www.aade.gr/myDATA/invoice/v1.0"><invoice>
<mark>{values['mark']}</mark><issuer><vatNumber>{values['issuer']}</vatNumber><name>EXAMPLE SUPPLIER</name></issuer>
<counterpart><vatNumber>{values['recipient']}</vatNumber></counterpart>
<invoiceHeader><series>S</series><aa>731</aa><issueDate>2026-10-06</issueDate><invoiceType>2.1</invoiceType><currency>EUR</currency></invoiceHeader>
<invoiceDetails><lineNumber>1</lineNumber><itemCode>P001</itemCode><itemDescr>Hosting service</itemDescr><quantity>1.000</quantity><netValue>{values['net']}</netValue><vatCategory>1</vatCategory><vatAmount>{values['vat']}</vatAmount></invoiceDetails>
<invoiceSummary><totalNetValue>{values['net']}</totalNetValue><totalVatAmount>{values['vat']}</totalVatAmount><totalGrossValue>{values['gross']}</totalGrossValue><totalWithheldAmount>0.00</totalWithheldAmount><totalFeesAmount>0.00</totalFeesAmount><totalStampDutyAmount>0.00</totalStampDutyAmount><totalOtherTaxesAmount>0.00</totalOtherTaxesAmount><totalDeductionsAmount>0.00</totalDeductionsAmount></invoiceSummary>
</invoice></InvoicesDoc>'''.encode()


def reference(url=QR_URL, page=1):
    return {"id": hashlib.sha256(url.encode()).hexdigest(), "payload": url, "page": page, **recognise(url)}


def local_result(urls=(QR_URL,), text="Source document"):
    return parse([{"page": 1, "text": text, "method": "pdf_text", "qrCodes": [reference(url) for url in urls]}], {})


def test_real_qr_decoding_rotated_png_and_pdf_without_network():
    qr = qrcode.make(QR_URL).get_image().convert("RGB")
    assert decode(qr.rotate(90, expand=True), 2)[0]["page"] == 2
    result = decode(qr, 1)[0]
    assert result["payload"] == QR_URL and result["kind"] == "provider_invoice"
    assert result["downloadUrl"] == QR_URL + "/mydata"
    png = io.BytesIO(); qr.save(png, "PNG")
    extracted = extract(png.getvalue(), "image/png", {})
    assert extracted["pages"][0]["qrCodes"][0]["id"] == result["id"]
    pdf = io.BytesIO(); writer = canvas.Canvas(pdf)
    writer.drawString(30, 800, "Synthetic QR-bearing invoice")
    writer.drawImage(ImageReader(qr), 30, 550, width=200, height=200)
    writer.save()
    extracted = extract(pdf.getvalue(), "application/pdf", {})
    assert extracted["pages"][0]["qrCodes"][0]["payload"] == QR_URL


@pytest.mark.parametrize("url", [
    "http://einvoice.impact.gr" + QR_URL.split('.gr', 1)[1],
    QR_URL.replace("einvoice.impact.gr", "einvoice.impact.gr.evil.example"),
    QR_URL.replace("einvoice.impact.gr", "einvoice.impact.gr@evil.example"),
    QR_URL.replace("einvoice.impact.gr", "user:password@einvoice.impact.gr"),
    QR_URL.replace("einvoice.impact.gr", "einvoice.impact.gr:444"),
    QR_URL + "?url=http://127.0.0.1", QR_URL + "#fragment", QR_URL + "/../admin",
    QR_URL.replace("/p/", "/%70/"), "file:///etc/passwd", "javascript:alert(1)",
    "https://127.0.0.1/invoice", "https://[::1]/invoice", "https://einvoice.impact.gr/api/invoice/delete",
])
def test_unknown_or_unsafe_urls_are_inert(url):
    recognised = recognise(url)
    assert recognised["kind"] == "unsupported" and recognised["verificationUrl"] is None
    fetcher = Mock(side_effect=AssertionError("No request allowed"))
    resolve(local_result((url,)), {}, enabled=True, fetcher=fetcher)
    fetcher.assert_not_called()


def test_aa_de_receipt_and_invoice_references_are_not_claimed_verified():
    invoice = "https://mydatapi.aade.gr/myDATA/TimologioQR/QRInfo?q=opaque-reference"
    signature = "GRT99000204" + "00000387" + "A" * 30 + "2610061037" + "18.35"
    receipt = "https://www1.aade.gr/tameiakes/myweb/q1.php?SIG=" + signature
    fetcher = Mock(side_effect=AssertionError("No public data API contracted"))
    result = local_result((receipt,)); qr = resolve(result, {}, enabled=True, fetcher=fetcher)
    assert qr["status"] == "receipt_reference" and not qr["aadeVerified"]
    assert result["fields"]["total"]["value"] == "18.35" and result["fields"]["total"]["basis"] == "qr_unverified"
    qr = resolve(local_result((invoice,)), {}, enabled=True, fetcher=fetcher)
    assert qr["status"] == "aade_reference" and not qr["aadeVerified"]
    fetcher.assert_not_called()


def test_provider_xml_preserves_identifiers_and_line_evidence():
    value = read_invoice(xml(), reference())
    assert value["fields"]["mark"]["value"] == "99999999999999999999"
    assert value["fields"]["vat"]["value"] == "9.60"
    assert value["fields"]["lines"]["value"][0] == {"description": "Hosting service", "net": "40.00", "vat": "9.60", "category": "", "type": ""}
    assert value["fields"]["lines"]["evidence"]["source"] == "provider_xml"
    assert value["lineReferences"][0]["lineNumber"] == "1"
    assert value["lineReferences"][0]["quantity"] == "1.000"
    assert not value["aadeVerified"]


@pytest.mark.parametrize("content", [
    b"<html>Login required</html>", b"<InvoicesDoc><invoice/></InvoicesDoc>",
    b'<!DOCTYPE doc [<!ENTITY x SYSTEM "file:///etc/passwd">]><doc>&x;</doc>',
    xml(issuer="111111119"), xml(net="40.001"), xml(mark="123e10"), xml(gross="99.00"),
    xml().replace(b"<lineNumber>1</lineNumber>", b"<lineNumber>1</lineNumber><lineNumber>2</lineNumber>"),
    xml().replace(b"<totalVatAmount>9.60", b"<totalVatAmount>0.00"),
    xml().replace(b"</invoice>", b"</invoice><invoice/>"),
])
def test_xml_identity_precision_schema_and_entity_safety(content):
    with pytest.raises(LookupError):
        read_invoice(content, reference())


def test_lookup_is_opt_in_and_conflicts_do_not_substitute_fields():
    fetcher = Mock(return_value=xml())
    result = local_result()
    assert resolve(result, {}, fetcher=fetcher)["status"] == "lookup_disabled"
    fetcher.assert_not_called()
    result = local_result(text="Grand total: 99.00")
    qr = resolve(result, {"vatNumber": "987654324"}, enabled=True, fetcher=fetcher)
    assert qr["status"] == "conflict" and result["fields"]["total"]["value"] == "99.00"
    assert all(field["basis"] != "provider_xml" for field in result["fields"].values())
    result = local_result()
    assert resolve(result, {"vatNumber": "111111119"}, enabled=True, fetcher=fetcher)["status"] == "conflict"
    result = local_result()
    qr = resolve(result, {"vatNumber": "987654324"}, enabled=True, fetcher=fetcher)
    assert qr["status"] == "retrieved" and qr["recipientMatched"]
    assert result["fields"]["total"]["value"] == "49.60"
    assert result["fields"]["total"]["basis"] == "provider_xml"
    assert result["fields"]["lines"]["value"][0]["vat"] == "9.60"
    result = local_result()
    assert resolve(result, {}, enabled=True, fetcher=fetcher, alive=lambda: False)["source"] is None


def test_multiple_qr_codes_require_an_explicit_valid_choice():
    fetcher = Mock(return_value=xml())
    result = local_result((QR_URL, OTHER_URL))
    assert resolve(result, {}, enabled=True, fetcher=fetcher)["status"] == "needs_selection"
    fetcher.assert_not_called()
    assert resolve(result, {}, enabled=True, choice="a" * 64, fetcher=fetcher)["status"] == "invalid_selection"
    assert resolve(result, {}, enabled=True, choice=reference(OTHER_URL)["id"], fetcher=fetcher)["status"] == "retrieved"
    fetcher.assert_called_once_with(OTHER_URL + "/mydata")


def test_provider_failure_keeps_local_extraction_available():
    result = local_result(text="Net total: 40.00")
    qr = resolve(result, {}, enabled=True, fetcher=Mock(side_effect=LookupError("The provider timed out.")))
    assert qr["status"] == "unavailable" and result["fields"]["net"]["value"] == "40.00"


def test_dns_rejects_private_addresses_and_mixed_answers(monkeypatch):
    import socket
    for addresses in (("127.0.0.1",), ("::1",), ("169.254.169.254",), ("8.8.8.8", "10.0.0.1")):
        monkeypatch.setattr(socket, "getaddrinfo", lambda *_, **__: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443)) for address in addresses])
        with pytest.raises(LookupError):
            public_addresses("einvoice.impact.gr")


def test_transport_has_no_credentials_limits_bytes_and_revalidates_redirects(monkeypatch):
    from optimus_api.mydata import qr_transport as transport
    monkeypatch.setattr(transport, "public_addresses", lambda _: ["8.8.8.8"])
    responses, connections = [], []
    class Response(io.BytesIO):
        def __init__(self, content=b"", status=200, headers=None):
            super().__init__(content); self.status = status; self.headers = headers or {}
        def getheader(self, name, default=None): return self.headers.get(name, default)
    class Connection:
        def __init__(self, host, address, timeout):
            assert address == "8.8.8.8" and timeout <= 8
            connections.append(self)
        def request(self, method, path, headers):
            assert method == "GET" and path.endswith("/mydata")
            assert set(headers) == {"Accept", "Accept-Encoding", "User-Agent", "Connection"}
        def getresponse(self): return responses.pop(0)
        def close(self): pass
    monkeypatch.setattr(transport, "PinnedHTTPS", Connection)
    responses.append(Response(xml()))
    assert fetch_xml(QR_URL + "/mydata") == xml()
    for response in (Response(status=302, headers={"Location": "https://127.0.0.1/private"}),
                     Response(headers={"Content-Length": str(transport.MAX_RESPONSE + 1)}),
                     Response(headers={"Content-Encoding": "gzip"}), Response(status=403)):
        responses.append(response)
        with pytest.raises(LookupError):
            fetch_xml(QR_URL + "/mydata")
    responses.append(Response(status=302, headers={"Location": OTHER_URL + "/mydata"}))
    with pytest.raises(LookupError):
        fetch_xml(QR_URL + "/mydata")
    # A redirect to a different invoice issuer is not followed either.
    responses.append(Response(status=302, headers={"Location": QR_URL.replace("123456783", "111111119") + "/mydata"}))
    with pytest.raises(LookupError):
        fetch_xml(QR_URL + "/mydata")


def test_pinned_transport_preserves_tls_hostname(monkeypatch):
    from optimus_api.mydata import qr_transport as transport
    sock = Mock(); context = Mock()
    monkeypatch.setattr(transport.ssl, "create_default_context", lambda: context)
    create = Mock(return_value=sock)
    monkeypatch.setattr(transport.socket, "create_connection", create)
    connection = PinnedHTTPS("einvoice.impact.gr", "8.8.8.8", 3)
    connection.connect()
    create.assert_called_once_with(("8.8.8.8", 443), 3)
    context.wrap_socket.assert_called_once_with(sock, server_hostname="einvoice.impact.gr")


def sample_qr_pdf():
    output = io.BytesIO(); writer = canvas.Canvas(output)
    lines = ["Supplier: EXAMPLE SUPPLIER", "INVOICE", "VAT ID: 123456783", "Invoice number: 731", "Issue date: 2026-10-06",
             "Net total: 40.00", "VAT total: 9.60", "Grand total: 49.60 EUR", "MARK: 99999999999999999999"]
    for index, line in enumerate(lines):
        writer.drawString(30, 800 - index * 22, line)
    writer.drawImage(ImageReader(qrcode.make(QR_URL).get_image()), 330, 550, width=200, height=200)
    writer.save()
    return output.getvalue()


def test_special_adjustments_remain_review_only():
    content = xml().replace(b"<totalFeesAmount>0.00", b"<totalFeesAmount>1.00").replace(b"<totalGrossValue>49.60", b"<totalGrossValue>50.60")
    result = local_result()
    qr = resolve(result, {}, enabled=True, fetcher=lambda _: content)
    assert qr["status"] == "review_required"
    assert not any(field["basis"] == "provider_xml" for field in result["fields"].values())

EPSILON_URL = "https://epsilondigital-3rd.epsilonnet.gr/fd/" + "A" * 32 + ":97"


def test_native_receipt_photo_qr_survives_pdf_downsampling():
    import pypdfium2 as pdfium
    qr = qrcode.QRCode(box_size=2, border=4)
    qr.add_data(EPSILON_URL); qr.make(fit=True)
    code = qr.make_image().get_image().convert("RGB")
    photo = Image.new("RGB", (2000, 6000), "white")
    photo.paste(code, (600, 5400))
    output = io.BytesIO(); writer = canvas.Canvas(output, pagesize=(595, 842))
    scaled_width = 2000 * 842 / 6000
    writer.drawImage(ImageReader(photo), (595 - scaled_width) / 2, 0, width=scaled_width, height=842)
    writer.save()
    content = output.getvalue()
    # This reproduces the original failure: page-sized rendering loses QR modules.
    with pdfium.PdfDocument(content) as document:
        page = document[0]; bitmap = page.render(scale=3, may_draw_forms=False)
        try:
            with bitmap.to_pil() as rendered:
                assert decode(rendered, 1) == []
        finally:
            bitmap.close(); page.close()
    extracted = extract(content, "application/pdf", {})
    found = extracted["pages"][0]["qrCodes"]
    assert len(found) == 1
    assert found[0]["payload"] == EPSILON_URL and found[0]["source"] == "embedded_image"
    assert found[0]["imageSize"] == [2000, 6000]
    assert found[0]["pdfBoundsUnits"] == "pdf_points"
    assert found[0]["kind"] == "provider_reference" and found[0]["provider"] == "Epsilon Digital"
    fetcher = Mock(side_effect=AssertionError("Epsilon is verification-only until its retrieval contract is validated"))
    result = parse(extracted["pages"], {})
    assert resolve(result, {}, enabled=True, fetcher=fetcher)["status"] == "provider_reference"
    fetcher.assert_not_called()


def test_embedded_image_scanning_has_pixel_limits_and_retains_page_fallback():
    import pypdfium2 as pdfium
    from optimus_api.mydata.qr import decode_pdf_images, merge_codes
    image = SimpleNamespace(type=pdfium.raw.FPDF_PAGEOBJ_IMAGE,
                            get_metadata=lambda: SimpleNamespace(width=100000, height=100000),
                            get_bitmap=Mock(side_effect=AssertionError("Oversized images must not be decoded")))
    page = SimpleNamespace(get_size=lambda: (595, 842), get_objects=lambda: [image])
    assert decode_pdf_images(page, 1) == []
    image.get_bitmap.assert_not_called()
    native = reference(); native["source"] = "embedded_image"
    rendered = {**reference(), "source": "rendered_page"}
    assert merge_codes([native], [rendered]) == [native]


@pytest.mark.parametrize("url", [
    EPSILON_URL.replace("epsilonnet.gr", "epsilonnet.gr.evil.example"),
    EPSILON_URL.replace("https://", "http://"), EPSILON_URL + "/mydata",
    EPSILON_URL + "?next=https://example.com", EPSILON_URL.replace("/fd/", "/api/"),
])
def test_epsilon_recognition_does_not_expand_network_fetch_permissions(url):
    assert recognise(url)["kind"] == "unsupported"
    with pytest.raises(LookupError):
        fetch_xml(url)
