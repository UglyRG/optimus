"""Local QR decoding and explicit recognition. Decoding never fetches a URL."""
import hashlib
import re
from urllib.parse import parse_qs, urlsplit, urlunsplit

PROVIDERS = {"einvoice.impact.gr": "Impact", "einvoice.s1ecos.gr": "Entersoftone"}
PROVIDER_PATH = re.compile(r"^/p/EL(?P<vat>\d{9})/[A-Fa-f0-9]{40}/[A-Fa-f0-9]{32}(?:/(?P<format>mydata|pdf|EN16931))?/?$", re.I)


def recognise(value):
    """Only exact known hosts and read-only path shapes become actionable links."""
    result = {"kind": "unsupported", "provider": None, "verificationUrl": None, "downloadUrl": None}
    if not isinstance(value, str) or not value or len(value) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in value) or "\\" in value:
        return result
    try:
        url = urlsplit(value)
        if url.scheme != "https" or url.username or url.password or url.fragment or url.port not in {None, 443}:
            return result
        host = url.hostname
        if not host or url.netloc.lower() not in {host, host + ":443"}:
            return result
        if host in PROVIDERS and not url.query:
            match = PROVIDER_PATH.fullmatch(url.path)
            if match:
                path = re.sub(r"/(mydata|pdf|EN16931)/?$", "", url.path, flags=re.I).rstrip("/")
                base = urlunsplit(("https", host, path, "", ""))
                return {**result, "kind": "provider_invoice", "provider": PROVIDERS[host], "host": host,
                        "issuerVat": match["vat"], "verificationUrl": base, "downloadUrl": base + "/mydata"}
        if host == "epsilondigital-3rd.epsilonnet.gr" and not url.query and re.fullmatch(r"/fd/[A-Fa-f0-9]{32}:\d{1,6}/?", url.path):
            return {**result, "kind": "provider_reference", "provider": "Epsilon Digital", "host": host,
                    "verificationUrl": urlunsplit(("https", host, url.path, "", ""))}
        if host == "mydatapi.aade.gr" and url.path == "/myDATA/TimologioQR/QRInfo":
            query = parse_qs(url.query, keep_blank_values=True)
            if set(query) == {"q"} and len(query["q"]) == 1 and 1 <= len(query["q"][0]) <= 2048:
                return {**result, "kind": "aade_invoice", "provider": "AADE", "host": host, "verificationUrl": value}
        if host == "www1.aade.gr" and url.path in {"/tameiakes/myweb/q1.php", "/tameiakes/myweb/q18.php"}:
            query = parse_qs(url.query, keep_blank_values=True)
            if set(query) == {"SIG"} and len(query["SIG"]) == 1:
                signature = query["SIG"][0]
                if re.fullmatch(r"[A-Za-z0-9]{11}\d{8}[A-Fa-f0-9]{40}\d{1,12}\.\d{2}", signature):
                    return {**result, "kind": "aade_receipt", "provider": "AADE", "host": host, "verificationUrl": value,
                            "receiptHint": {"device": signature[:11], "sequence": signature[11:19], "total": signature[59:]}}
    except (ValueError, UnicodeError):
        pass
    return result


def decode(image, page):
    import zxingcpp
    # A bounded number of QR payloads; payment/marketing codes stay inert.
    found = []
    for code in zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode):
        if len(found) >= 16:
            break
        value = code.text
        if not value or len(value) > 4096:
            continue
        points = [code.position.top_left, code.position.top_right, code.position.bottom_right, code.position.bottom_left]
        found.append({"id": hashlib.sha256(value.encode()).hexdigest(), "payload": value, "page": page,
                      "bbox": [min(p.x for p in points), min(p.y for p in points), max(p.x for p in points), max(p.y for p in points)],
                      "imageSize": [image.width, image.height], "bboxUnits": "pixels", **recognise(value)})
    return found


def decode_pdf_images(pdf_page, page):
    """Preserve embedded-photo resolution instead of shrinking it to the PDF paper size."""
    import pypdfium2 as pdfium
    found, seen, pixels, images = [], set(), 0, 0
    width, height = pdf_page.get_size()
    for image in pdf_page.get_objects():
        if image.type != pdfium.raw.FPDF_PAGEOBJ_IMAGE:
            continue
        images += 1
        if images > 8:
            break
        try:
            info = image.get_metadata()
            count = int(info.width) * int(info.height)
            if count <= 0 or count > 30_000_000 or pixels + count > 60_000_000:
                continue
            bounds = list(image.get_bounds())
            if bounds[2] <= 0 or bounds[3] <= 0 or bounds[0] >= width or bounds[1] >= height:
                continue
            pixels += count
            bitmap = image.get_bitmap()
            try:
                with bitmap.to_pil() as original:
                    codes = decode(original, page)
            finally:
                bitmap.close()
            for code in codes:
                if code["id"] not in seen and len(found) < 16:
                    seen.add(code["id"])
                    found.append({**code, "source": "embedded_image", "imageIndex": images - 1,
                                  "pdfBounds": bounds, "pdfBoundsUnits": "pdf_points"})
        except Exception:
            # A damaged/unsupported embedded image must not disable page-render fallback.
            continue
    return found


def merge_codes(*groups):
    found, seen = [], set()
    for group in groups:
        for code in group:
            if code["id"] not in seen and len(found) < 16:
                seen.add(code["id"])
                found.append(code)
    return found
