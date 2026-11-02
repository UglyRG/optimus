"""Bounded, credential-free local extraction subprocess. Input/output are private pipes."""
import base64
import csv
import io
import json
import os
import subprocess
import sys

from PIL import Image, ImageOps
from pypdf import PdfReader

from .qr import decode as decode_qr, decode_pdf_images, merge_codes

MAX_TEXT = 60000


def ocr(image, config):
    if not config.get("tesseract") or not config.get("languagesReady"):
        raise RuntimeError("OCR is unavailable. Install Tesseract with Greek (ell) and English (eng) language data.")
    image = ImageOps.exif_transpose(image).convert("RGB")
    if image.width * image.height > 30_000_000:
        raise RuntimeError("Page exceeds the OCR image-size limit")
    output = io.BytesIO()
    image.save(output, format="PNG")
    command = [config["tesseract"], "stdin", "stdout", "-l", "ell+eng", "--psm", "3"]
    if config.get("tessdata"):
        command += ["--tessdata-dir", config["tessdata"]]
    result = subprocess.run(command + ["tsv"], input=output.getvalue(), capture_output=True, timeout=40,
                            env={**os.environ, "OMP_THREAD_LIMIT": "1"})
    if result.returncode:
        raise RuntimeError("Local OCR could not read this page; retry with a clearer copy or enter the fields manually.")
    groups = {}
    for row in csv.DictReader(io.StringIO(result.stdout.decode("utf-8")), delimiter="\t"):
        if row.get("level") != "5" or not row.get("text", "").strip():
            continue
        key = (row["block_num"], row["par_num"], row["line_num"])
        groups.setdefault(key, []).append(row)
    lines, boxes = [], []
    for words in groups.values():
        text = " ".join(word["text"] for word in words)
        left, top = min(int(w["left"]) for w in words), min(int(w["top"]) for w in words)
        right = max(int(w["left"]) + int(w["width"]) for w in words)
        bottom = max(int(w["top"]) + int(w["height"]) for w in words)
        boxes.append({"line": len(lines), "bbox": [left, top, right, bottom],
                      "confidence": round(sum(float(w["conf"]) for w in words) / len(words), 2)})
        lines.append(text)
    return "\n".join(lines), boxes, [image.width, image.height]


def header_image_texts(pdf_page, config):
    """Read small, non-square header images locally; QR codes and body images are excluded."""
    import pypdfium2 as pdfium
    width, height = pdf_page.get_size()
    regions = []
    for image in pdf_page.get_objects():
        if image.type != pdfium.raw.FPDF_PAGEOBJ_IMAGE:
            continue
        left, bottom, right, top = image.get_bounds()
        w, h = right - left, top - bottom
        if w < 30 or h < 8 or bottom < height * .7 or not 1.3 <= w / h <= 8 or w * h > width * height * .12:
            continue
        bitmap = pdf_page.render(scale=min(4, (4_000_000 / (w * h)) ** .5),
                                 crop=(max(0, left - 2), max(0, bottom - 2), max(0, width - right - 2), max(0, height - top - 2)),
                                 may_draw_forms=False)
        try:
            with bitmap.to_pil() as image:
                text, boxes, _ = ocr(image, config)
        finally:
            bitmap.close()
        raw_lines = text.splitlines()
        ordered = sorted(boxes, key=lambda box: (box["bbox"][1], box["bbox"][0]))
        text = "\n".join(raw_lines[box["line"]] for box in ordered)[:2000]
        if text.strip():
            regions.append({"text": text, "bbox": [left, bottom, right, top], "method": "ocr", "role": "header_branding"})
        if len(regions) >= 2:
            break
    return regions


def extract(content, mime, config, progress=lambda *_: None):
    pages, warnings, remaining = [], [], MAX_TEXT
    reader = PdfReader(io.BytesIO(content)) if mime == "application/pdf" else None
    if reader and (reader.is_encrypted or not 1 <= len(reader.pages) <= 30):
        raise RuntimeError("This PDF cannot be processed")
    count = len(reader.pages) if reader else 1
    rendered = None
    try:
        for index in range(count):
            if remaining <= 0:
                warnings.append("The document text limit was reached. Check omitted pages manually.")
                break
            page = {"page": index + 1, "text": "", "method": "pdf_text", "ocrLines": []}
            # QR decoding is local and precedes OCR/model interpretation. It performs no network requests.
            try:
                if reader:
                    import pypdfium2 as pdfium
                    if rendered is None:
                        rendered = pdfium.PdfDocument(content)
                    qr_page = rendered[index]
                    try:
                        page["qrCodes"] = decode_pdf_images(qr_page, index + 1)
                        width, height = qr_page.get_size()
                        if width <= 0 or height <= 0:
                            raise RuntimeError("Invalid page dimensions")
                        bitmap = qr_page.render(scale=min(3, (12_000_000 / (width * height)) ** .5), may_draw_forms=False)
                        try:
                            with bitmap.to_pil() as image:
                                page["qrCodes"] = merge_codes(page["qrCodes"], [
                                    {**code, "source": "rendered_page"} for code in decode_qr(image, index + 1)])
                        finally:
                            bitmap.close()
                    finally:
                        qr_page.close()
                else:
                    with Image.open(io.BytesIO(content)) as image:
                        with ImageOps.exif_transpose(image).convert("RGB") as oriented:
                            page["qrCodes"] = decode_qr(oriented, 1)
            except Exception:
                page.setdefault("qrCodes", [])
                warnings.append(f"Page {index + 1}: Some QR scanning could not be completed; local text/OCR remains available.")
            if reader:
                # PDF content-stream order is often unrelated to visual reading order.
                # Keep both representations; field evidence points to the layout text.
                plain = reader.pages[index].extract_text() or ""
                try:
                    layout = reader.pages[index].extract_text(extraction_mode="layout") or ""
                except Exception:
                    layout = ""
                page.update(text=layout if layout.strip() else plain, plainText=plain[:MAX_TEXT], textRepresentation="layout" if layout.strip() else "plain")
                if index == 0 and page["text"].strip() and config.get("languagesReady"):
                    try:
                        import pypdfium2 as pdfium
                        if rendered is None:
                            rendered = pdfium.PdfDocument(content)
                        header_page = rendered[index]
                        try:
                            page["imageTexts"] = header_image_texts(header_page, config)
                        finally:
                            header_page.close()
                    except Exception:
                        warnings.append("Header image text could not be read. Verify supplier branding manually.")
            if not reader or len("".join(c for c in page["text"] if c.isalnum())) < 30:
                page["method"] = "ocr"
                try:
                    if reader:
                        import pypdfium2 as pdfium
                        if rendered is None:
                            rendered = pdfium.PdfDocument(content)
                        pdf_page = rendered[index]
                        width, height = pdf_page.get_size()
                        if width <= 0 or height <= 0:
                            raise RuntimeError("Invalid PDF page dimensions")
                        scale = min(3, (20_000_000 / (width * height)) ** .5)
                        bitmap = pdf_page.render(scale=scale, may_draw_forms=False)
                        try:
                            with bitmap.to_pil() as image:
                                text, boxes, size = ocr(image, config)
                        finally:
                            bitmap.close()
                            pdf_page.close()
                    else:
                        with Image.open(io.BytesIO(content)) as image:
                            text, boxes, size = ocr(image, config)
                    page.update(text=text, ocrLines=boxes, imageSize=size)
                except (RuntimeError, subprocess.TimeoutExpired) as exc:
                    # Other pages can still produce useful evidence; no invented replacements.
                    warnings.append(f"Page {index + 1}: " + (str(exc) if isinstance(exc, RuntimeError) else "OCR timed out; enter this page manually."))
                    page["method"] = "unreadable" if not page["text"] else "pdf_text"
            page["text"] = page["text"][:remaining]
            remaining -= len(page["text"])
            pages.append(page)
            progress(index + 1, count)
    finally:
        if rendered is not None:
            rendered.close()
    return {"pages": pages, "warnings": warnings}


if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        if "preview" in request:
            import pypdfium2 as pdfium
            with pdfium.PdfDocument(base64.b64decode(request["content"], validate=True)) as pdf:
                index = request["preview"] - 1
                if index < 0 or index >= len(pdf):
                    raise ValueError("Page not found")
                page = pdf[index]
                try:
                    width, height = page.get_size()
                    scale = min(2, (12_000_000 / (width * height)) ** .5)
                    bitmap = page.render(scale=scale, may_draw_forms=False)
                    try:
                        with bitmap.to_pil() as image:
                            output = io.BytesIO()
                            image.save(output, "PNG")
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            print(json.dumps({"event": "preview", "png": base64.b64encode(output.getvalue()).decode()}), flush=True)
        else:
            result = extract(base64.b64decode(request["content"], validate=True), request["mime"], request["config"],
                             lambda page, total: print(json.dumps({"event": "progress", "page": page, "total": total}), flush=True))
            print(json.dumps({"event": "result", **result}), flush=True)
    except Exception:
        # Never leak invoice text, local paths or parser diagnostics to logs/browser.
        print(json.dumps({"event": "error", "message": "Document extraction failed. Try a clearer copy or enter the fields manually."}), flush=True)
        sys.exit(1)
