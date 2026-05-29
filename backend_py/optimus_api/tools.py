from __future__ import annotations

import base64
import csv
import io
import json
import re
import shutil
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from html import escape
from pathlib import Path
from typing import Any

from pypdf import PdfReader, PdfWriter

from .config import Settings
from .domain import normalize_betlog_bet, normalize_padelog_match
from .knowledge import fetch_anthropic_message, model_names
from .store import JsonStore
from .utils import bad_request, clean_positive_integer, clean_text, now_iso


OLYMPIACOS_NEWS_WINDOW_HOURS = 24
OLYMPIACOS_NEWS_TEAMS = [
    {"id": "football", "label": "Olympiacos FC"},
    {"id": "basketball", "label": "Olympiacos BC"},
]


def output_file_name(file_name: str, suffix: str = "-iframe.txt") -> str:
    stem = Path(file_name or "output").stem or "output"
    return safe_file_stem(stem) + suffix


def output_pdf_file_name(file_name: str) -> str:
    return safe_file_stem(Path(file_name or "output").stem or "output") + "-iframe.txt"


def output_html_file_name(file_name: str, fallback: str = "output") -> str:
    name = safe_file_stem(Path(file_name or fallback).stem or fallback)
    return f"{name}.html"


def output_combined_pdf_file_name(file_name: str) -> str:
    name = safe_file_stem(Path(file_name or "combined").stem or "combined")
    return f"{name}.pdf"


def output_csv_json_base_name(file_name: str) -> str:
    return safe_file_stem(Path(file_name or "rows").stem or "rows")


def safe_file_stem(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value or "output")).strip(".-")[:120] or "output"


def has_pdf_header(data: bytes) -> bool:
    return data[:1024].lstrip().startswith(b"%PDF-")


def save_iframe_source(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    file_name = str(payload.get("fileName") or "")
    html = payload.get("html")
    if not file_name or not isinstance(html, str):
        raise bad_request("An HTML file is required")
    iframe_source = "data:text/html;base64," + base64.b64encode(html.encode("utf-8")).decode("ascii")
    saved_file_name = output_file_name(file_name)
    output_path = settings.outputs_dir / saved_file_name
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_text(iframe_source, encoding="utf-8")
    return {"fileName": saved_file_name, "outputPath": str(output_path), "iframeSource": iframe_source}


def save_pdf_iframe_source(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    file_name = str(payload.get("fileName") or "")
    compact_base64 = str(payload.get("base64") or "").strip()
    if not file_name or not compact_base64:
        raise bad_request("A PDF file is required")
    try:
        pdf_bytes = base64.b64decode(compact_base64, validate=True)
    except Exception as exc:
        raise bad_request("PDF content must be a Base64 string") from exc
    if not has_pdf_header(pdf_bytes):
        raise bad_request("Choose a valid PDF file")
    iframe_source = f"data:application/pdf;base64,{compact_base64}"
    saved_file_name = output_pdf_file_name(file_name)
    output_path = settings.outputs_dir / saved_file_name
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_text(iframe_source, encoding="utf-8")
    return {"fileName": saved_file_name, "outputPath": str(output_path), "iframeSource": iframe_source}


def combine_pdf_documents(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    files = payload.get("files")
    if not isinstance(files, list) or len(files) < 2:
        raise bad_request("Choose at least two PDF files to combine")
    if len(files) > 5:
        raise bad_request("Combine PDFs supports up to five documents at a time")
    writer = PdfWriter()
    page_count = 0
    for index, file in enumerate(files):
        source_name = str((file or {}).get("fileName") or f"Document {index + 1}")
        compact_base64 = str((file or {}).get("base64") or "").strip()
        try:
            pdf_bytes = base64.b64decode(compact_base64, validate=True)
        except Exception as exc:
            raise bad_request(f"{source_name} must be a Base64 PDF") from exc
        if not has_pdf_header(pdf_bytes):
            raise bad_request(f"{source_name} is not a valid PDF file")
        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
        except Exception as exc:
            raise bad_request(f"{source_name} could not be read as a PDF") from exc
        for page in reader.pages:
            writer.add_page(page)
            page_count += 1
    if page_count == 0:
        raise bad_request("The selected PDFs do not contain any pages")
    buffer = io.BytesIO()
    writer.write(buffer)
    pdf_bytes = buffer.getvalue()
    saved_file_name = output_combined_pdf_file_name(str(payload.get("fileName") or "combined.pdf"))
    output_path = settings.outputs_dir / saved_file_name
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(pdf_bytes)
    pdf_source = "data:application/pdf;base64," + base64.b64encode(pdf_bytes).decode("ascii")
    return {"fileName": saved_file_name, "outputPath": str(output_path), "pageCount": page_count, "pdfSource": pdf_source}


def save_csv_json_rows(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    file_name = str(payload.get("fileName") or "")
    csv_text = payload.get("csv")
    if not file_name or not isinstance(csv_text, str):
        raise bad_request("A CSV file is required")
    if Path(file_name).suffix.lower() != ".csv":
        raise bad_request("Choose a CSV file")
    rows = list(csv.reader(io.StringIO(csv_text.lstrip("\ufeff"))))
    if not rows:
        raise bad_request("The CSV file is empty")
    headers = [header.strip() or f"Column {index + 1}" for index, header in enumerate(rows[0])]
    if not any(headers):
        raise bad_request("The CSV file needs a header row")
    max_columns = max([len(headers), *[len(row) for row in rows[1:]]], default=len(headers))
    headers = unique_headers(headers, max_columns)
    data_rows = [row for row in rows[1:] if any(str(cell).strip() for cell in row)]
    if not data_rows:
        raise bad_request("The CSV file does not contain any data rows")
    base_name = output_csv_json_base_name(file_name)
    output_dir = settings.outputs_dir / base_name
    temp_dir = settings.outputs_dir / f".csv-json-rows-{base_name}-{uuid.uuid4()}"
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    files: list[str] = []
    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        for index, row in enumerate(data_rows, start=1):
            record = {header: row[column_index] if column_index < len(row) else "" for column_index, header in enumerate(headers)}
            saved_file_name = f"{base_name}{index}.json"
            (temp_dir / saved_file_name).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
            files.append(saved_file_name)
        if output_dir.exists():
            shutil.rmtree(output_dir)
        temp_dir.rename(output_dir)
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise
    warnings = []
    skipped_blank_rows = len(rows) - 1 - len(data_rows)
    if skipped_blank_rows:
        warnings.append(f"{skipped_blank_rows} blank rows were skipped.")
    return {
        "fileName": base_name,
        "outputPath": str(output_dir),
        "rowCount": len(files),
        "columnCount": len(headers),
        "skippedBlankRows": skipped_blank_rows,
        "warnings": warnings,
        "files": files,
    }


def unique_headers(headers: list[str], column_count: int) -> list[str]:
    seen: dict[str, int] = {}
    result = []
    for index in range(column_count):
        header = headers[index] if index < len(headers) else f"Column {index + 1}"
        count = seen.get(header, 0)
        seen[header] = count + 1
        result.append(f"{header} ({count + 1})" if count else header)
    return result


def list_iframe_source_files(settings: Settings) -> list[str]:
    if not settings.outputs_dir.exists():
        return []
    return sorted(
        path.name
        for path in settings.outputs_dir.glob("*.txt")
        if path.is_file() and path.read_text(encoding="utf-8", errors="ignore").startswith("data:")
    )


def read_iframe_source_file(settings: Settings, file_name: str) -> str:
    safe_name = Path(file_name).name
    if not safe_name or safe_name != file_name:
        raise bad_request("Iframe source file is not valid")
    path = settings.outputs_dir / safe_name
    if not path.exists():
        raise bad_request("Iframe source file not found")
    text = path.read_text(encoding="utf-8")
    if not text.startswith("data:"):
        raise bad_request("Iframe source file is not a data URL")
    return text


def save_presentation_suite(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    count = int(payload.get("tabCount") or 0)
    labels = payload.get("labels")
    source_files = payload.get("sourceFiles")
    if count < 1 or count > 12:
        raise bad_request("Choose between 1 and 12 tabs")
    if not isinstance(labels, list) or len(labels) != count:
        raise bad_request("Provide one label for each tab")
    if not isinstance(source_files, list) or len(source_files) != count:
        raise bad_request("Provide one content choice for each tab")
    tabs = []
    for index, label in enumerate(labels):
        source_file = str(source_files[index] or "").strip()
        tabs.append({
            "label": clean_text(label, "Deck" if index == 0 else f"Demo {index}", 80),
            "iframeSource": read_iframe_source_file(settings, source_file) if source_file else "",
        })
    html = build_presentation_suite_html(tabs)
    saved_file_name = output_html_file_name(str(payload.get("fileName") or "presentation-suite.html"), "presentation-suite")
    output_path = settings.outputs_dir / saved_file_name
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    return {"fileName": saved_file_name, "outputPath": str(output_path), "html": html}


def build_presentation_suite_html(tabs: list[dict[str, str]]) -> str:
    buttons = "\n".join(f'<button data-tab="{index}" class="{ "active" if index == 0 else "" }">{escape(tab["label"])}</button>' for index, tab in enumerate(tabs))
    panes = "\n".join(
        f'<section class="pane { "active" if index == 0 else "" }" data-pane="{index}">'
        + (f'<iframe src="{escape(tab["iframeSource"], quote=True)}"></iframe>' if tab["iframeSource"] else "<div class=\"empty\">No iframe source selected.</div>")
        + "</section>"
        for index, tab in enumerate(tabs)
    )
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Presentation Suite</title><style>
body{{margin:0;font-family:Inter,system-ui,sans-serif;background:#0f172a;color:#e5e7eb}}.tabs{{height:48px;display:flex;gap:6px;align-items:center;padding:0 12px;background:#111827;border-bottom:1px solid #334155}}button{{border:1px solid #475569;border-radius:6px;background:#1f2937;color:#e5e7eb;padding:8px 12px;font-weight:700}}button.active{{background:#2563eb;border-color:#2563eb}}.pane{{display:none;height:calc(100vh - 49px)}}.pane.active{{display:block}}iframe{{width:100%;height:100%;border:0;background:white}}.empty{{display:grid;place-items:center;height:100%;color:#94a3b8}}
</style></head><body><nav class="tabs">{buttons}</nav>{panes}<script>
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{{document.querySelectorAll('[data-tab]').forEach(b=>b.classList.toggle('active',b===button));document.querySelectorAll('[data-pane]').forEach(p=>p.classList.toggle('active',p.dataset.pane===button.dataset.tab));}}));
</script></body></html>"""


def save_demo_builder_template(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    count = int(payload.get("scenarioCount") or 0)
    if count < 1 or count > 8:
        raise bad_request("Choose between 1 and 8 scenarios")
    html = build_demo_builder_html(payload)
    saved_file_name = output_html_file_name(str(payload.get("fileName") or "demo-builder-template.html"), "demo-builder-template")
    output_path = settings.outputs_dir / saved_file_name
    settings.outputs_dir.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding="utf-8")
    return {"fileName": saved_file_name, "outputPath": str(output_path), "html": html}


def build_demo_builder_html(payload: dict[str, Any]) -> str:
    title = escape(str(payload.get("title") or "Use-case Demo"))
    subtitle = escape(str(payload.get("subtitle") or "Configurable agent simulation template"))
    logo = escape(str(payload.get("logoText") or "LOGO"))
    brand = escape(str(payload.get("brandColor") or "#003a7d"))
    accent = escape(str(payload.get("accentColor") or "#c8a84b"))
    background = escape(str(payload.get("backgroundColor") or "#0e1117"))
    font_color = escape(str(payload.get("fontColor") or "#e8eaf0"))
    try:
        parsed = json.loads(str(payload.get("contentJson") or "[]"))
        scenarios = parsed if isinstance(parsed, list) else parsed.get("scenarios", [])
    except Exception:
        scenarios = []
    if not scenarios:
        scenarios = [{"label": "Scenario 1", "messages": [{"role": "agent", "text": "Welcome."}], "logs": []}]
    scenario_options = "".join(f"<option>{escape(str(item.get('label') or f'Scenario {i+1}'))}</option>" for i, item in enumerate(scenarios))
    first = scenarios[0]
    messages = "".join(f'<div class="msg {escape(str(msg.get("role") or "agent"))}">{escape(str(msg.get("text") or ""))}</div>' for msg in first.get("messages", [])[:8])
    logs = "".join(f'<div class="log">{escape(str(log.get("type") or "info"))}: {escape(str(log.get("text") or ""))}</div>' for log in first.get("logs", [])[:12])
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>
body{{margin:0;height:100vh;display:grid;grid-template-rows:58px 1fr 48px;background:{background};color:{font_color};font-family:Inter,system-ui,sans-serif}}header{{display:flex;align-items:center;gap:14px;padding:0 18px;background:{brand};border-bottom:3px solid {accent}}}.logo{{background:white;color:{brand};font-weight:900;padding:6px 10px;border-radius:4px}}h1{{font-size:16px;margin:0}}p{{margin:2px 0 0;color:rgba(255,255,255,.72)}}main{{display:grid;grid-template-columns:42% 58%;min-height:0}}.chat{{background:#f8fafc;color:#111827;overflow:auto;padding:14px}}.msg{{margin:0 0 10px;padding:10px 12px;border-radius:10px;background:white;border:1px solid #dbe3ef}}.msg.user{{background:{brand};color:white;margin-left:30px}}.right{{background:#111827;display:grid;grid-template-rows:1fr 130px}}.doc{{margin:14px;padding:14px;border:1px solid #334155;border-radius:8px;background:#1f2937}}.logs{{background:#020617;color:#cbd5e1;font-family:monospace;padding:10px;overflow:auto}}footer{{display:flex;align-items:center;gap:10px;padding:0 18px;background:#1f2937;border-top:1px solid #334155}}button,select{{border:1px solid #475569;border-radius:6px;background:#111827;color:white;padding:7px 10px}}
</style></head><body><header><div class="logo">{logo}</div><div><h1>{title}</h1><p>{subtitle}</p></div><select>{scenario_options}</select></header><main><section class="chat">{messages}</section><section class="right"><article class="doc"><h2>Deployment Prerequisites</h2><p>Edit the exported HTML to add full demo behavior, documents, and scenario controls.</p></article><div class="logs">{logs}</div></section></main><footer><button>Start</button><button disabled>Pause</button><span>Generated by Optimus Demo Builder</span></footer></body></html>"""


def token_usage_ranges(payload: dict[str, Any]) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc)
    month_start = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    year_start = datetime(now.year, 1, 1, tzinfo=timezone.utc)
    ranges = [
        {"id": "month", "label": "Month to date", "start": month_start, "end": now},
        {"id": "year", "label": "Year to date", "start": year_start, "end": now},
    ]
    if payload.get("from") and payload.get("to"):
        start = datetime.fromisoformat(str(payload["from"])).replace(tzinfo=timezone.utc)
        end = datetime.fromisoformat(str(payload["to"])).replace(tzinfo=timezone.utc) + timedelta(days=1)
        if end <= start:
            raise bad_request("Custom range end must be after start")
        ranges.append({"id": "custom", "label": "Custom range", "start": start, "end": end})
    for item in ranges:
        item["startingAt"] = item["start"].isoformat().replace("+00:00", "Z")
        item["endingAt"] = item["end"].isoformat().replace("+00:00", "Z")
    return ranges


def check_token_usage(payload: dict[str, Any], settings: Settings) -> dict[str, Any]:
    ranges = token_usage_ranges(payload)
    return {
        "generatedAt": now_iso(),
        "ranges": [{k: item[k] for k in ("id", "label", "startingAt", "endingAt")} for item in ranges],
        "providers": [
            usage_provider_result("openai", "OpenAI", ranges, get_openai_usage, settings),
            usage_provider_result("anthropic", "Anthropic", ranges, get_anthropic_usage, settings),
        ],
    }


def usage_provider_result(provider_id: str, name: str, ranges: list[dict[str, Any]], loader: Any, settings: Settings) -> dict[str, Any]:
    try:
        return {"id": provider_id, "name": name, "ok": True, "ranges": [loader(item, settings) for item in ranges]}
    except Exception as exc:
        return {"id": provider_id, "name": name, "ok": False, "error": str(exc), "ranges": []}


def empty_totals(model: str = "") -> dict[str, int | str]:
    return {
        "model": model,
        "inputTokens": 0,
        "outputTokens": 0,
        "cachedInputTokens": 0,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 0,
        "inputAudioTokens": 0,
        "outputAudioTokens": 0,
        "requests": 0,
        "totalTokens": 0,
    }


def get_openai_usage(range_item: dict[str, Any], settings: Settings) -> dict[str, Any]:
    api_key = getattr(settings, "openai_admin_key", None)
    if not api_key:
        raise RuntimeError("Set OPENAI_ADMIN_KEY in .env")
    buckets = fetch_openai_usage_buckets(range_item, api_key)
    totals = empty_totals()
    by_model: dict[str, dict[str, Any]] = {}
    for bucket in buckets:
        for result in bucket.get("results", []):
            model = result.get("model") or "All models"
            by_model.setdefault(model, empty_totals(model))
            add_openai_usage(totals, result)
            add_openai_usage(by_model[model], result)
    return usage_range_result(range_item, totals, by_model)


def add_openai_usage(target: dict[str, Any], result: dict[str, Any]) -> None:
    target["inputTokens"] += clean_usage_number(result.get("input_tokens"))
    target["outputTokens"] += clean_usage_number(result.get("output_tokens"))
    target["cachedInputTokens"] += clean_usage_number(result.get("input_cached_tokens"))
    target["inputAudioTokens"] += clean_usage_number(result.get("input_audio_tokens"))
    target["outputAudioTokens"] += clean_usage_number(result.get("output_audio_tokens"))
    target["requests"] += clean_usage_number(result.get("num_model_requests"))
    target["totalTokens"] = target["inputTokens"] + target["outputTokens"] + target["inputAudioTokens"] + target["outputAudioTokens"]


def get_anthropic_usage(range_item: dict[str, Any], settings: Settings) -> dict[str, Any]:
    api_key = getattr(settings, "anthropic_admin_key", None)
    if not api_key:
        raise RuntimeError("Set ANTHROPIC_ADMIN_KEY in .env")
    buckets = fetch_anthropic_usage_buckets(range_item, api_key)
    totals = empty_totals()
    by_model: dict[str, dict[str, Any]] = {}
    for bucket in buckets:
        for result in bucket.get("results", []):
            model = result.get("model") or "All models"
            by_model.setdefault(model, empty_totals(model))
            add_anthropic_usage(totals, result)
            add_anthropic_usage(by_model[model], result)
    return usage_range_result(range_item, totals, by_model)


def add_anthropic_usage(target: dict[str, Any], result: dict[str, Any]) -> None:
    cache_creation = sum(clean_usage_number(value) for value in (result.get("cache_creation") or {}).values())
    cache_read = clean_usage_number(result.get("cache_read_input_tokens"))
    target["inputTokens"] += clean_usage_number(result.get("uncached_input_tokens")) + cache_creation + cache_read
    target["outputTokens"] += clean_usage_number(result.get("output_tokens"))
    target["cacheCreationInputTokens"] += cache_creation
    target["cacheReadInputTokens"] += cache_read
    target["requests"] += clean_usage_number(result.get("requests") or result.get("num_model_requests"))
    target["totalTokens"] = target["inputTokens"] + target["outputTokens"]


def usage_range_result(range_item: dict[str, Any], totals: dict[str, Any], by_model: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {
        "rangeId": range_item["id"],
        "label": range_item["label"],
        "startingAt": range_item["startingAt"],
        "endingAt": range_item["endingAt"],
        "totals": totals,
        "models": sorted(by_model.values(), key=lambda item: item["totalTokens"], reverse=True),
    }


def clean_usage_number(value: Any) -> int:
    try:
        number = int(value or 0)
    except Exception:
        return 0
    return max(0, number)


def fetch_json(url: str, headers: dict[str, str] | None = None, data: dict[str, Any] | None = None) -> dict[str, Any]:
    request = urllib.request.Request(url, headers=headers or {}, method="POST" if data is not None else "GET")
    if data is not None:
        request.data = json.dumps(data).encode("utf-8")
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="ignore")
        try:
            payload = json.loads(body or "{}")
            message = payload.get("error", {}).get("message") or payload.get("message") or body
        except Exception:
            message = body
        raise RuntimeError(message or f"Provider returned HTTP {exc.code}") from exc


def fetch_openai_usage_buckets(range_item: dict[str, Any], api_key: str) -> list[dict[str, Any]]:
    buckets = []
    page = ""
    while True:
        params = (
            f"start_time={int(range_item['start'].timestamp())}&end_time={int(range_item['end'].timestamp())}"
            "&bucket_width=1d&limit=31&group_by[]=model"
        )
        if page:
            params += f"&page={page}"
        payload = fetch_json(
            f"https://api.openai.com/v1/organization/usage/completions?{params}",
            {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        )
        buckets.extend(payload.get("data", []))
        page = payload.get("next_page") if payload.get("has_more") else ""
        if not page:
            return buckets


def fetch_anthropic_usage_buckets(range_item: dict[str, Any], api_key: str) -> list[dict[str, Any]]:
    buckets = []
    page = ""
    while True:
        params = f"starting_at={range_item['startingAt']}&ending_at={range_item['endingAt']}&bucket_width=1d&limit=31&group_by[]=model"
        if page:
            params += f"&page={page}"
        payload = fetch_json(
            f"https://api.anthropic.com/v1/organizations/usage_report/messages?{params}",
            {"anthropic-version": "2023-06-01", "content-type": "application/json", "x-api-key": api_key},
        )
        buckets.extend(payload.get("data", []))
        page = payload.get("next_page") if payload.get("has_more") else ""
        if not page:
            return buckets


def default_olympiacos_news_store() -> dict[str, Any]:
    return {
        "sites": [
            {"url": "https://www.sport24.gr/", "enabled": True},
            {"url": "https://www.gazzetta.gr/", "enabled": True},
            {"url": "https://www.sdna.gr/", "enabled": True},
        ],
        "runs": [],
    }


def load_olympiacos_news_store(store: JsonStore, settings: Settings) -> dict[str, Any]:
    parsed = store.get("olympiacos_news", default_olympiacos_news_store(), settings.data_dir / "olympiacos-news.json")
    return normalize_olympiacos_news_store(parsed)


def save_olympiacos_news_store(store_obj: dict[str, Any], store: JsonStore) -> dict[str, Any]:
    normalized = normalize_olympiacos_news_store(store_obj)
    store.set("olympiacos_news", normalized)
    return normalized


def normalize_olympiacos_news_store(value: dict[str, Any] | None = None) -> dict[str, Any]:
    value = value or {}
    default = default_olympiacos_news_store()
    raw_sites = value.get("sites") if isinstance(value.get("sites"), list) and value.get("sites") else default["sites"]
    sites = unique_sites([normalize_olympiacos_news_site(site) for site in raw_sites])
    runs = [normalize_olympiacos_news_run(run) for run in value.get("runs", []) if isinstance(run, dict)]
    return {"sites": sites, "runs": sorted(runs, key=lambda item: item["generatedAt"], reverse=True)[:120]}


def unique_sites(sites: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    result = []
    for site in sites:
        if site["hostname"] not in seen:
            seen.add(site["hostname"])
            result.append(site)
    return result


def normalize_olympiacos_news_site(raw_site: Any) -> dict[str, Any]:
    source = {"url": raw_site} if isinstance(raw_site, str) else raw_site or {}
    url = normalize_url(source.get("url") or source.get("href") or source.get("hostname"))
    from urllib.parse import urlparse
    hostname = urlparse(url).hostname or "site"
    hostname = hostname.removeprefix("www.")
    return {
        "id": clean_text(source.get("id"), hostname, 80),
        "name": clean_text(source.get("name"), title_from_hostname(hostname), 80),
        "url": url,
        "hostname": hostname,
        "enabled": source.get("enabled") is not False,
    }


def normalize_url(value: Any) -> str:
    from urllib.parse import urlparse, urlunparse
    text = str(value or "").strip()
    if not text:
        raise bad_request("Website URL is required")
    if not re.match(r"^https?://", text, flags=re.I):
        text = "https://" + text
    parsed = urlparse(text)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise bad_request("Website URL is not valid")
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", "", "", ""))


def title_from_hostname(hostname: str) -> str:
    return re.sub(r"\b\w", lambda match: match.group(0).upper(), hostname.split(".")[0].replace("-", " "))


def normalize_olympiacos_news_run(raw: dict[str, Any]) -> dict[str, Any]:
    generated = clean_text(raw.get("generatedAt"), now_iso(), 40)
    window = raw.get("window") or {}
    return {
        "id": clean_text(raw.get("id"), str(uuid.uuid4()), 80),
        "generatedAt": generated,
        "window": {
            "hours": clean_positive_integer(window.get("hours"), OLYMPIACOS_NEWS_WINDOW_HOURS),
            "from": clean_text(window.get("from"), (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(), 40),
            "to": clean_text(window.get("to"), generated, 40),
        },
        "sites": [normalize_olympiacos_run_site(site) for site in raw.get("sites", []) if isinstance(site, dict)],
    }


def normalize_olympiacos_run_site(site: dict[str, Any]) -> dict[str, Any]:
    return {
        "siteId": clean_text(site.get("siteId"), "", 80),
        "name": clean_text(site.get("name"), "News site", 80),
        "url": clean_text(site.get("url"), "", 240),
        "hostname": clean_text(site.get("hostname"), "", 120),
        "teams": {
            team["id"]: {
                "summary": clean_text((site.get("teams") or {}).get(team["id"], {}).get("summary"), "Δεν βρέθηκαν επιβεβαιωμένες ειδήσεις στο τελευταίο 24ωρο.", 1000),
                "articles": [normalize_article(article) for article in (site.get("teams") or {}).get(team["id"], {}).get("articles", [])[:6]],
            }
            for team in OLYMPIACOS_NEWS_TEAMS
        },
        "errors": [clean_text(error, "", 240) for error in site.get("errors", []) if error],
    }


def normalize_article(article: dict[str, Any]) -> dict[str, str]:
    return {
        "title": clean_text(article.get("title"), "Untitled article", 240),
        "url": clean_text(article.get("url"), "", 600),
        "publishedAt": clean_text(article.get("publishedAt"), "", 40),
        "snippet": clean_text(article.get("snippet"), "", 500),
    }


def update_olympiacos_news_sites(payload: dict[str, Any], store: JsonStore, settings: Settings) -> dict[str, Any]:
    incoming = payload.get("sites")
    if not isinstance(incoming, list) or not incoming:
        raise bad_request("Add at least one website.")
    current = load_olympiacos_news_store(store, settings)
    return save_olympiacos_news_store({**current, "sites": incoming}, store)


def run_olympiacos_news_search(store: JsonStore, settings: Settings) -> dict[str, Any]:
    current = load_olympiacos_news_store(store, settings)
    enabled = [site for site in current["sites"] if site["enabled"]]
    if not enabled:
        raise bad_request("Enable at least one website before running the search.")
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=OLYMPIACOS_NEWS_WINDOW_HOURS)
    sites = openai_olympiacos_news_for_sites(enabled, start, now, settings)
    run = normalize_olympiacos_news_run({
        "id": str(uuid.uuid4()),
        "generatedAt": now.isoformat(),
        "window": {"hours": OLYMPIACOS_NEWS_WINDOW_HOURS, "from": start.isoformat(), "to": now.isoformat()},
        "sites": sites,
    })
    saved = save_olympiacos_news_store({**current, "runs": [run, *current["runs"]]}, store)
    return {"run": run, "runs": saved["runs"], "sites": saved["sites"]}


def openai_olympiacos_news_for_sites(sites: list[dict[str, Any]], start: datetime, end: datetime, settings: Settings) -> list[dict[str, Any]]:
    if not settings.openai_api_key:
        raise bad_request("Set OPENAI_API_KEY in .env")
    prompt = {
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "sites": sites,
        "task": "Search for Olympiacos FC and Olympiacos BC news in the last 24 hours. Return JSON only.",
    }
    payload = fetch_json(
        "https://api.openai.com/v1/responses",
        {"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
        {
            "model": getattr(settings, "openai_olympiacos_news_model", None) or "gpt-5",
            "input": json.dumps(prompt),
            "text": {"format": {"type": "json_object"}},
        },
    )
    text = extract_openai_response_text(payload)
    try:
        parsed = json.loads(text)
    except Exception as exc:
        raise bad_request("OpenAI did not return valid Olympiacos news JSON.") from exc
    raw_sites = parsed.get("sites") if isinstance(parsed, dict) else parsed
    return [normalize_olympiacos_run_site(site) for site in raw_sites] if isinstance(raw_sites, list) else []


def extract_openai_response_text(payload: dict[str, Any]) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    parts = []
    for item in payload.get("output", []) or []:
        for content in item.get("content", []) or []:
            if isinstance(content.get("text"), str):
                parts.append(content["text"])
    return "\n".join(parts)


def summarize_padelog_performance(matches: list[dict[str, Any]]) -> dict[str, Any]:
    return {"matches": len(matches), "resultBreakdown": count_by(matches, "result"), "clubs": count_by(matches, "club"), "teammates": count_by(matches, "teammate")}


def summarize_betlog_performance(bets: list[dict[str, Any]]) -> dict[str, Any]:
    stake = sum(float(bet.get("stake") or 0) for bet in bets)
    returns = sum(float(bet.get("returnAmount") or 0) for bet in bets)
    return {"rows": len(bets), "stake": stake, "returns": returns, "profit": round(returns - stake, 2), "statusBreakdown": count_by(bets, "status")}


def count_by(rows: list[dict[str, Any]], key: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for row in rows:
        value = str(row.get(key) or "Unknown")
        result[value] = result.get(value, 0) + 1
    return result


def analyze_padelog_performance(matches: list[dict[str, Any]], settings: Settings) -> dict[str, Any]:
    if not matches:
        raise bad_request("Add at least one Padelog match before asking for AI insights.")
    system = "You are a concise padel performance analyst. Return exactly 5 short bullets and use only the provided JSON data."
    user = json.dumps({"generatedAt": now_iso(), "summary": summarize_padelog_performance(matches), "matches": matches}, indent=2)
    insight = fetch_anthropic_message(system, user, settings, max_tokens=360)
    return {"id": str(uuid.uuid4()), "toolId": "padelog", "model": model_names(settings)["chat"], "generatedAt": now_iso(), "sourceRecordCount": len(matches), "insight": insight}


def analyze_betlog_performance(bets: list[dict[str, Any]], settings: Settings) -> dict[str, Any]:
    if not bets:
        raise bad_request("Add at least one Betlog row before asking for AI insights.")
    system = "You are a concise betting performance analyst focused on risk discipline. Return exactly 5 short bullets and do not encourage more betting."
    user = json.dumps({"generatedAt": now_iso(), "summary": summarize_betlog_performance(bets), "bets": bets}, indent=2)
    insight = fetch_anthropic_message(system, user, settings, max_tokens=360)
    return {"id": str(uuid.uuid4()), "toolId": "betlog", "model": model_names(settings)["chat"], "generatedAt": now_iso(), "sourceRecordCount": len(bets), "insight": insight}


def create_backup_archive(values: dict[str, Any]) -> dict[str, Any]:
    buffer = io.BytesIO()
    date = datetime.now(timezone.utc).date().isoformat()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
        for name, value in values.items():
            archive.writestr(f"data/{name}", json.dumps(value, indent=2) + "\n")
    return {"fileName": f"optimus-backup-{date}.zip", "mimeType": "application/zip", "base64": base64.b64encode(buffer.getvalue()).decode("ascii")}


def read_backup_archive(payload: dict[str, Any]) -> dict[str, Any]:
    compact = str(payload.get("base64") or "").strip()
    if not compact:
        raise bad_request("Choose a backup zip file first.")
    try:
        data = base64.b64decode(compact, validate=True)
    except Exception as exc:
        raise bad_request("Backup must be a Base64 zip file.") from exc
    result: dict[str, Any] = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for name in archive.namelist():
            if name.startswith("__MACOSX/") or name.endswith("/"):
                continue
            result[Path(name).name] = json.loads(archive.read(name).decode("utf-8"))
    return result


def create_notelog_pdf(note: dict[str, Any]) -> bytes:
    # Minimal PDF writer for Notelog pages and strokes. Coordinates are mapped from canvas units to page points.
    pages = note.get("pages") if isinstance(note.get("pages"), list) and note.get("pages") else []
    objects: list[bytes] = []
    page_refs = []
    for page_index, page in enumerate(pages):
        width = float(page.get("width") or 1414)
        height = float(page.get("height") or 1000)
        media_w, media_h = 841.89, 595.28
        sx, sy = media_w / width, media_h / height
        commands = ["1 1 1 rg 0 0 841.89 595.28 re f", "0 0 0 RG 1 w"]
        for stroke in page.get("strokes", []) or []:
            points = stroke.get("points") or []
            if len(points) < 2:
                continue
            color = hex_to_rgb(stroke.get("color") or "#111827") if stroke.get("tool") != "eraser" else (1, 1, 1)
            commands.append(f"{color[0]} {color[1]} {color[2]} RG {max(0.5, float(stroke.get('size') or 4) * 0.5)} w")
            first = points[0]
            commands.append(f"{float(first.get('x') or 0)*sx:.2f} {media_h - float(first.get('y') or 0)*sy:.2f} m")
            for point in points[1:]:
                commands.append(f"{float(point.get('x') or 0)*sx:.2f} {media_h - float(point.get('y') or 0)*sy:.2f} l")
            commands.append("S")
        stream = "\n".join(commands).encode("utf-8")
        content_id = len(objects) + 1
        objects.append(b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream")
        page_id = len(objects) + 1
        page_refs.append(page_id)
        objects.append(f"<< /Type /Page /Parent 0 0 R /MediaBox [0 0 841.89 595.28] /Contents {content_id} 0 R >>".encode())
    if not objects:
        return create_notelog_pdf({"pages": [{"strokes": []}]})
    pages_id = len(objects) + 1
    catalog_id = len(objects) + 2
    objects = [obj.replace(b"/Parent 0 0 R", f"/Parent {pages_id} 0 R".encode()) for obj in objects]
    objects.append(f"<< /Type /Pages /Kids [{' '.join(f'{ref} 0 R' for ref in page_refs)}] /Count {len(page_refs)} >>".encode())
    objects.append(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode())
    output = io.BytesIO()
    output.write(b"%PDF-1.4\n")
    offsets = [0]
    for index, obj in enumerate(objects, start=1):
        offsets.append(output.tell())
        output.write(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref_at = output.tell()
    output.write(f"xref\n0 {len(objects)+1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        output.write(f"{offset:010d} 00000 n \n".encode())
    output.write(f"trailer << /Size {len(objects)+1} /Root {catalog_id} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode())
    return output.getvalue()


def hex_to_rgb(value: str) -> tuple[float, float, float]:
    text = str(value or "#111827").lstrip("#")
    if len(text) != 6:
        return (0, 0, 0)
    return tuple(round(int(text[index:index + 2], 16) / 255, 3) for index in (0, 2, 4))  # type: ignore[return-value]
