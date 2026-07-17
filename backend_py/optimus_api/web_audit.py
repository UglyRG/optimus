from __future__ import annotations

import ipaddress
import json
import re
import socket
from io import BytesIO
from collections import Counter
from html.parser import HTMLParser
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener
from xml.sax.saxutils import escape

from .utils import bad_request

USER_AGENT = "Optimus-Web-Audit/1.0"
MAX_PAGE_BYTES = 2_000_000


def _validate_public_url(value: Any) -> str:
    url = str(value or "").strip()
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise bad_request("Enter a public HTTP or HTTPS URL")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise bad_request("The URL hostname could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise bad_request("Private, loopback, link-local, and reserved network addresses cannot be audited")
    return url


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return super().redirect_request(req, fp, code, msg, headers, _validate_public_url(newurl))


def _fetch(url: str, max_bytes: int = MAX_PAGE_BYTES) -> dict[str, Any]:
    safe_url = _validate_public_url(url)
    request = Request(safe_url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1"})
    try:
        with build_opener(SafeRedirectHandler()).open(request, timeout=12) as response:
            final_url = _validate_public_url(response.geturl())
            content_type = response.headers.get_content_type()
            charset = response.headers.get_content_charset() or "utf-8"
            body = response.read(max_bytes + 1)
            if len(body) > max_bytes:
                raise bad_request("The page is larger than the 2 MB audit limit")
            return {
                "url": final_url,
                "status": response.status,
                "contentType": content_type,
                "headers": {key.lower(): value for key, value in response.headers.items()},
                "text": body.decode(charset, errors="replace"),
            }
    except HTTPError as exc:
        raise bad_request(f"The page returned HTTP {exc.code}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise bad_request(f"The page could not be fetched: {getattr(exc, 'reason', exc)}") from exc


class AuditParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.meta: dict[str, str] = {}
        self.headings: list[tuple[str, str]] = []
        self.links: list[dict[str, str]] = []
        self.images: list[dict[str, str]] = []
        self.json_ld: list[Any] = []
        self.text_parts: list[str] = []
        self._capture: str | None = None
        self._buffer: list[str] = []
        self.has_main = False
        self.has_article = False
        self.list_count = 0
        self.table_count = 0
        self.time_count = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        tag = tag.lower()
        if tag in {"title", "h1", "h2", "h3"}:
            self._capture, self._buffer = tag, []
        elif tag == "script" and values.get("type", "").lower() == "application/ld+json":
            self._capture, self._buffer = "jsonld", []
        if tag == "meta":
            key = (values.get("name") or values.get("property") or values.get("http-equiv") or "").lower()
            if key:
                self.meta[key] = values.get("content", "").strip()
        elif tag == "link":
            self.links.append({"rel": values.get("rel", "").lower(), "href": values.get("href", "")})
        elif tag == "a":
            self.links.append({"rel": values.get("rel", "").lower(), "href": values.get("href", "")})
        elif tag == "img":
            self.images.append({"src": values.get("src", ""), "alt": values.get("alt", "")})
        elif tag == "main":
            self.has_main = True
        elif tag == "article":
            self.has_article = True
        elif tag in {"ul", "ol"}:
            self.list_count += 1
        elif tag == "table":
            self.table_count += 1
        elif tag == "time":
            self.time_count += 1

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self._capture != tag and not (tag == "script" and self._capture == "jsonld"):
            return
        value = " ".join("".join(self._buffer).split())
        if self._capture == "title":
            self.title = value
        elif self._capture in {"h1", "h2", "h3"}:
            self.headings.append((self._capture, value))
        elif self._capture == "jsonld" and value:
            try:
                self.json_ld.append(json.loads(value))
            except json.JSONDecodeError:
                self.json_ld.append(None)
        self._capture, self._buffer = None, []

    def handle_data(self, data: str) -> None:
        if self._capture:
            self._buffer.append(data)
        if self._capture != "jsonld" and data.strip():
            self.text_parts.append(data.strip())

    @property
    def text(self) -> str:
        return " ".join(" ".join(self.text_parts).split())


def _finding(check_id: str, label: str, points: int, status: str, evidence: str, recommendation: str = "", severity: str = "medium") -> dict[str, Any]:
    earned = points if status == "pass" else round(points * 0.5, 2) if status == "warning" else 0
    return {"id": check_id, "label": label, "status": status, "severity": severity, "pointsEarned": earned, "pointsAvailable": points, "confidence": "high", "evidence": evidence, "recommendation": recommendation}


def _category(category_id: str, label: str, weight: int, checks: list[dict[str, Any]]) -> dict[str, Any]:
    applicable = [check for check in checks if check["status"] != "not_applicable"]
    available = sum(check["pointsAvailable"] for check in applicable)
    score = round(sum(check["pointsEarned"] for check in applicable) / available * 100) if available else None
    return {"id": category_id, "label": label, "weight": weight, "score": score, "checks": checks}


def _overall(categories: list[dict[str, Any]]) -> int:
    applicable = [category for category in categories if category["score"] is not None]
    weights = sum(category["weight"] for category in applicable)
    return round(sum(category["score"] * category["weight"] for category in applicable) / weights) if weights else 0


def _label(score: int) -> str:
    if score >= 90:
        return "Excellent"
    if score >= 75:
        return "Good"
    if score >= 50:
        return "Needs work"
    if score >= 25:
        return "Poor"
    return "Blocked or critical"


def _topic_overlap(topic: str, text: str) -> float:
    tokens = {token for token in re.findall(r"[\w'-]{3,}", topic.lower(), re.UNICODE)}
    if not tokens:
        return 0
    text_tokens = set(re.findall(r"[\w'-]{3,}", text.lower(), re.UNICODE))
    return len(tokens & text_tokens) / len(tokens)


def _schema_types(items: list[Any]) -> list[str]:
    types: list[str] = []
    def visit(value: Any) -> None:
        if isinstance(value, dict):
            raw_type = value.get("@type")
            if isinstance(raw_type, list):
                types.extend(str(item) for item in raw_type)
            elif raw_type:
                types.append(str(raw_type))
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    visit(items)
    return sorted(set(types))


def audit_page(payload: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode not in {"seo", "geo"}:
        raise bad_request("Unknown audit mode")
    fetched = _fetch(payload.get("url"))
    if fetched["contentType"] not in {"text/html", "application/xhtml+xml"}:
        raise bad_request("The URL must return an HTML page")
    parser = AuditParser()
    parser.feed(fetched["text"])
    topic = str(payload.get("topic") or "").strip()[:240]
    locale = str(payload.get("locale") or "").strip()[:40]
    return _seo_result(fetched, parser, topic, locale) if mode == "seo" else _geo_result(fetched, parser, topic, locale)


def _shared(fetched: dict[str, Any], parser: AuditParser) -> dict[str, Any]:
    robots = " ".join(filter(None, [parser.meta.get("robots"), fetched["headers"].get("x-robots-tag")])).lower()
    canonical = next((urljoin(fetched["url"], link["href"]) for link in parser.links if "canonical" in link["rel"].split() and link["href"]), "")
    words = re.findall(r"\b[\w'-]+\b", parser.text, re.UNICODE)
    internal_links = [link for link in parser.links if link["href"] and urlparse(urljoin(fetched["url"], link["href"])).netloc == urlparse(fetched["url"]).netloc]
    return {"robots": robots, "canonical": canonical, "words": words, "internalLinks": internal_links, "schemaTypes": _schema_types(parser.json_ld)}


def _seo_result(fetched: dict[str, Any], parser: AuditParser, topic: str, locale: str) -> dict[str, Any]:
    data = _shared(fetched, parser)
    h1s = [text for tag, text in parser.headings if tag == "h1"]
    description = parser.meta.get("description", "")
    noindex = "noindex" in data["robots"] or "none" in data["robots"].split(",")
    canonical_host = urlparse(data["canonical"]).netloc if data["canonical"] else ""
    page_host = urlparse(fetched["url"]).netloc
    images_with_src = [image for image in parser.images if image["src"]]
    missing_alt = [image for image in images_with_src if not image["alt"].strip()]
    topic_overlap = _topic_overlap(topic, " ".join([parser.title, *h1s, parser.text[:2000]])) if topic else 0

    categories = [
        _category("crawlability", "Crawlability & indexability", 25, [
            _finding("http-status", "Successful HTTP response", 5, "pass", f"HTTP {fetched['status']}"),
            _finding("indexable", "Indexing directives", 7, "fail" if noindex else "pass", data["robots"] or "No blocking robots directive found", "Remove noindex if this page should appear in search.", "critical"),
            _finding("canonical", "Canonical URL", 5, "pass" if data["canonical"] else "warning", data["canonical"] or "No canonical link found", "Add a self-referencing canonical URL."),
            _finding("canonical-host", "Canonical consistency", 4, "fail" if canonical_host and canonical_host != page_host else "pass", "Canonical host matches" if not canonical_host or canonical_host == page_host else f"Canonical points to {canonical_host}", "Verify that the cross-domain canonical is intentional.", "high"),
            _finding("internal-links", "Crawlable internal links", 4, "pass" if data["internalLinks"] else "warning", f"Found {len(data['internalLinks'])} internal links", "Add descriptive internal links to related pages."),
        ]),
        _category("on-page", "On-page relevance", 20, [
            _finding("title", "Page title", 6, "pass" if 15 <= len(parser.title) <= 65 else "warning" if parser.title else "fail", f"{len(parser.title)} characters: {parser.title or 'missing'}", "Write a unique, descriptive title of roughly 15–65 characters."),
            _finding("description", "Meta description", 4, "pass" if 50 <= len(description) <= 170 else "warning" if description else "fail", f"{len(description)} characters", "Add a useful summary of roughly 50–170 characters."),
            _finding("h1", "Primary heading", 5, "pass" if len(h1s) == 1 else "warning" if h1s else "fail", f"Found {len(h1s)} H1 headings", "Use one clear primary heading."),
            _finding("topic", "Target-topic alignment", 5, "pass" if topic_overlap >= 0.75 else "warning" if topic_overlap >= 0.4 else "fail", f"{round(topic_overlap * 100)}% target-term coverage" if topic else "No target topic supplied", "Use the target topic naturally in the title, heading, and main copy.", "high") if topic else _finding("topic", "Target-topic alignment", 5, "not_applicable", "Supply a target topic to assess relevance."),
        ]),
        _category("content", "Content quality", 20, [
            _finding("content-depth", "Substantial visible text", 8, "pass" if len(data["words"]) >= 300 else "warning" if len(data["words"]) >= 120 else "fail", f"Approximately {len(data['words'])} visible words", "Add useful, original information that satisfies the page purpose."),
            _finding("content-structure", "Descriptive content structure", 5, "pass" if len(parser.headings) >= 3 else "warning" if parser.headings else "fail", f"Found {len(parser.headings)} H1–H3 headings", "Break content into descriptive sections."),
            _finding("authorship", "Author or publisher transparency", 4, "pass" if parser.meta.get("author") or any(value in data["schemaTypes"] for value in ["Person", "Organization"]) else "warning", parser.meta.get("author") or ", ".join(data["schemaTypes"]) or "No author or organization signal found", "Identify the responsible author or organization."),
            _finding("freshness", "Date transparency", 3, "pass" if parser.time_count or any("date" in value.lower() for value in data["schemaTypes"]) else "warning", f"Found {parser.time_count} time elements", "Show publication or update dates where freshness matters."),
        ]),
        _category("semantics", "Structure & semantics", 15, [
            _finding("main", "Semantic main content", 4, "pass" if parser.has_main or parser.has_article else "warning", "Main/article element found" if parser.has_main or parser.has_article else "No main or article element found", "Wrap primary content in a main or article element."),
            _finding("schema", "Structured data", 5, "pass" if data["schemaTypes"] else "warning", ", ".join(data["schemaTypes"]) or "No JSON-LD types found", "Add valid, page-appropriate structured data when applicable."),
            _finding("image-alt", "Image alternatives", 3, "pass" if not missing_alt else "warning", f"{len(missing_alt)} of {len(images_with_src)} images lack alt text", "Add meaningful alt text; use empty alt only for decorative images."),
            _finding("heading-order", "Heading hierarchy", 3, "pass" if h1s and parser.headings else "warning", "Heading hierarchy is present" if parser.headings else "No headings found", "Use headings to express the document outline."),
        ]),
        _category("performance", "Performance & mobile UX", 15, [
            _finding("viewport", "Mobile viewport", 6, "pass" if "width=device-width" in parser.meta.get("viewport", "").lower() else "fail", parser.meta.get("viewport") or "Missing viewport", "Add a responsive viewport meta tag."),
            _finding("payload", "HTML payload", 4, "pass" if len(fetched["text"].encode()) <= 500_000 else "warning", f"{round(len(fetched['text'].encode()) / 1024)} KB HTML", "Reduce excessive HTML payload."),
            _finding("vitals", "Core Web Vitals", 5, "not_applicable", "Field and browser lab data are not collected by this deterministic fetch."),
        ]),
        _category("security", "Security & hygiene", 5, [
            _finding("https", "HTTPS", 3, "pass" if urlparse(fetched["url"]).scheme == "https" else "fail", urlparse(fetched["url"]).scheme.upper(), "Serve the page over HTTPS.", "high"),
            _finding("language", "Language declaration", 2, "pass" if re.search(r"<html[^>]+lang=[\"']?[^\s>\"']+", fetched["text"], re.I) else "warning", "HTML language declared" if re.search(r"<html[^>]+lang=", fetched["text"], re.I) else "No HTML lang attribute found", "Declare the page language on the html element."),
        ]),
    ]
    raw_score = _overall(categories)
    caps = []
    if noindex:
        caps.append({"maximum": 20, "reason": "The page has a noindex directive."})
    if canonical_host and canonical_host != page_host:
        caps.append({"maximum": 45, "reason": "The canonical points to another host."})
    score = min([raw_score, *[cap["maximum"] for cap in caps]])
    return _response("seo", "SEO Score", fetched, topic, locale, score, raw_score, categories, caps, data)


def _geo_result(fetched: dict[str, Any], parser: AuditParser, topic: str, locale: str) -> dict[str, Any]:
    data = _shared(fetched, parser)
    noindex = "noindex" in data["robots"]
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", parser.text) if len(part.split()) >= 5]
    concise = [sentence for sentence in sentences if 8 <= len(sentence.split()) <= 35]
    numbers = re.findall(r"\b\d+(?:[.,]\d+)?%?\b", parser.text)
    external_links = [link for link in parser.links if link["href"].startswith(("http://", "https://")) and urlparse(link["href"]).netloc != urlparse(fetched["url"]).netloc]
    schema = data["schemaTypes"]
    entity_schema = any(value in schema for value in ["Organization", "Person", "Product", "LocalBusiness", "WebSite"])
    overlap = _topic_overlap(topic, " ".join([parser.title, *[text for _, text in parser.headings], parser.text[:3000]])) if topic else 0
    repeated = Counter(word.lower() for word in data["words"] if len(word) > 5).most_common(1)

    categories = [
        _category("access", "AI accessibility & retrievability", 20, [
            _finding("fetchable", "Publicly fetchable HTML", 7, "pass", f"HTTP {fetched['status']} HTML response"),
            _finding("indexable", "Retrieval directives", 5, "fail" if noindex else "pass", data["robots"] or "No noindex directive found", "Remove noindex if this content should be discoverable.", "critical"),
            _finding("visible-text", "Machine-readable text", 5, "pass" if len(data["words"]) >= 200 else "warning" if len(data["words"]) >= 80 else "fail", f"Approximately {len(data['words'])} visible words", "Provide substantive content as accessible HTML text."),
            _finding("stable-url", "Stable canonical identity", 3, "pass" if data["canonical"] else "warning", data["canonical"] or "No canonical URL found", "Add a stable canonical URL."),
        ]),
        _category("extractability", "Answer extractability", 25, [
            _finding("topic-fit", "Target-topic alignment", 7, "pass" if overlap >= 0.75 else "warning" if overlap >= 0.4 else "fail", f"{round(overlap * 100)}% target-term coverage" if topic else "No target topic supplied", "State the target topic explicitly and answer it directly.", "high") if topic else _finding("topic-fit", "Target-topic alignment", 7, "not_applicable", "Supply a target topic to assess answer suitability."),
            _finding("direct-passages", "Concise, self-contained passages", 7, "pass" if len(concise) >= 4 else "warning" if concise else "fail", f"Found {len(concise)} concise answer-sized sentences", "Add concise statements that make sense when quoted independently."),
            _finding("headings", "Descriptive sections", 5, "pass" if len(parser.headings) >= 3 else "warning" if parser.headings else "fail", f"Found {len(parser.headings)} H1–H3 headings", "Organize answers under descriptive headings."),
            _finding("formats", "Extractable lists or tables", 3, "pass" if parser.list_count + parser.table_count >= 2 else "warning", f"Found {parser.list_count} lists and {parser.table_count} tables", "Use lists or tables where they clarify comparisons or steps."),
            _finding("focus", "Topical focus", 3, "pass" if repeated and repeated[0][1] >= 3 else "warning", f"Most repeated substantive term: {repeated[0][0] if repeated else 'none'}", "Keep the page focused on a clear subject."),
        ]),
        _category("evidence", "Evidence & citability", 20, [
            _finding("sources", "External supporting sources", 7, "pass" if len(external_links) >= 2 else "warning" if external_links else "fail", f"Found {len(external_links)} external links", "Link claims to relevant primary or authoritative sources."),
            _finding("statistics", "Specific facts and statistics", 5, "pass" if len(numbers) >= 3 else "warning" if numbers else "fail", f"Found {len(numbers)} numeric facts", "Use verifiable numbers where they genuinely support the answer."),
            _finding("source-language", "Attribution language", 4, "pass" if re.search(r"\b(according to|source|study|research|report|data from)\b", parser.text, re.I) else "warning", "Attribution language found" if re.search(r"\b(according to|source|study|research|report|data from)\b", parser.text, re.I) else "No clear attribution language found", "Tie important claims explicitly to their sources."),
            _finding("method", "Method or limitations", 4, "pass" if re.search(r"\b(method|methodology|limitation|scope|sample)\b", parser.text, re.I) else "warning", "Method or limitation language found" if re.search(r"\b(method|methodology|limitation|scope|sample)\b", parser.text, re.I) else "No method or limitation language found", "Explain methodology and limitations when presenting original analysis."),
        ]),
        _category("entity", "Entity clarity", 15, [
            _finding("entity-schema", "Machine-readable entity", 6, "pass" if entity_schema else "warning", ", ".join(schema) or "No entity schema found", "Identify the responsible organization, person, product, or site with appropriate schema."),
            _finding("title-identity", "Clear page identity", 5, "pass" if parser.title and any(tag == "h1" for tag, _ in parser.headings) else "fail", f"Title: {parser.title or 'missing'}", "Use a clear title and primary heading."),
            _finding("publisher", "Publisher transparency", 4, "pass" if parser.meta.get("author") or entity_schema else "warning", parser.meta.get("author") or "Entity schema present" if entity_schema else "No author or publisher signal found", "Identify who created and maintains the content."),
        ]),
        _category("semantic", "Semantic structure", 10, [
            _finding("main", "Semantic main content", 4, "pass" if parser.has_main or parser.has_article else "warning", "Main/article element found" if parser.has_main or parser.has_article else "No main or article element found", "Use semantic main or article markup."),
            _finding("schema", "Page-appropriate JSON-LD", 4, "pass" if schema else "warning", ", ".join(schema) or "No JSON-LD types found", "Add accurate structured data that matches visible content."),
            _finding("dates", "Machine-readable dates", 2, "pass" if parser.time_count or any(value in schema for value in ["Article", "NewsArticle", "BlogPosting"]) else "warning", f"Found {parser.time_count} time elements", "Expose publication and modification dates where relevant."),
        ]),
        _category("trust", "Originality & trust", 10, [
            _finding("depth", "Useful content depth", 4, "pass" if len(data["words"]) >= 400 else "warning" if len(data["words"]) >= 150 else "fail", f"Approximately {len(data['words'])} visible words", "Add original experience, analysis, or detail that serves the topic."),
            _finding("author", "Author credentials or responsibility", 3, "pass" if parser.meta.get("author") or entity_schema else "warning", parser.meta.get("author") or "Entity schema present" if entity_schema else "No responsibility signal found", "Show who is responsible and why they are credible."),
            _finding("freshness", "Freshness transparency", 3, "pass" if parser.time_count else "warning", f"Found {parser.time_count} time elements", "Show when time-sensitive content was published or updated."),
        ]),
    ]
    raw_score = _overall(categories)
    caps = []
    if noindex:
        caps.append({"maximum": 20, "reason": "The page has a noindex directive."})
    if len(data["words"]) < 80:
        caps.append({"maximum": 35, "reason": "The fetch exposed too little machine-readable main content."})
    if topic and overlap < 0.4:
        caps.append({"maximum": 40, "reason": "The target topic is substantially absent from the page."})
    score = min([raw_score, *[cap["maximum"] for cap in caps]])
    return _response("geo", "GEO Readiness Score", fetched, topic, locale, score, raw_score, categories, caps, data)


def _response(mode: str, title: str, fetched: dict[str, Any], topic: str, locale: str, score: int, raw_score: int, categories: list[dict[str, Any]], caps: list[dict[str, Any]], data: dict[str, Any]) -> dict[str, Any]:
    checks = [check for category in categories for check in category["checks"]]
    return {
        "frameworkVersion": "1.0",
        "mode": mode,
        "title": title,
        "url": fetched["url"],
        "topic": topic,
        "locale": locale,
        "score": score,
        "rawScore": raw_score,
        "rating": _label(score),
        "caps": caps,
        "categories": categories,
        "summary": {
            "passed": sum(check["status"] == "pass" for check in checks),
            "warnings": sum(check["status"] == "warning" for check in checks),
            "failed": sum(check["status"] == "fail" for check in checks),
            "notApplicable": sum(check["status"] == "not_applicable" for check in checks),
            "visibleWords": len(data["words"]),
            "schemaTypes": data["schemaTypes"],
        },
        "limitations": [
            "This is a deterministic page-level readiness audit, not a prediction or guarantee of ranking, indexing, citation, or traffic.",
            "Checks that require field data, a rendered browser, backlinks, or repeated live engine observations are reported separately or marked not assessed.",
        ],
    }


def create_audit_pdf(record: dict[str, Any]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    import reportlab
    from pathlib import Path

    result = record.get("result") if isinstance(record.get("result"), dict) else {}
    buffer = BytesIO()
    font_path = Path(reportlab.__file__).parent / "fonts" / "Vera.ttf"
    bold_font_path = Path(reportlab.__file__).parent / "fonts" / "VeraBd.ttf"
    body_font, bold_font = "Helvetica", "Helvetica-Bold"
    if font_path.exists() and bold_font_path.exists():
        pdfmetrics.registerFont(TTFont("OptimusVera", str(font_path)))
        pdfmetrics.registerFont(TTFont("OptimusVeraBold", str(bold_font_path)))
        body_font, bold_font = "OptimusVera", "OptimusVeraBold"

    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=16 * mm,
        leftMargin=16 * mm,
        topMargin=18 * mm,
        bottomMargin=18 * mm,
        title=str(result.get("title") or "Optimus web audit"),
        author="Optimus",
    )
    base = getSampleStyleSheet()
    title_style = ParagraphStyle("AuditTitle", parent=base["Title"], fontName=bold_font, fontSize=20, leading=24, textColor=colors.HexColor("#173766"), spaceAfter=8)
    heading_style = ParagraphStyle("AuditHeading", parent=base["Heading2"], fontName=bold_font, fontSize=12, leading=15, textColor=colors.HexColor("#173766"), spaceBefore=10, spaceAfter=6)
    body_style = ParagraphStyle("AuditBody", parent=base["BodyText"], fontName=body_font, fontSize=8.5, leading=12, textColor=colors.HexColor("#28384f"), spaceAfter=4)
    small_style = ParagraphStyle("AuditSmall", parent=body_style, fontSize=7.5, leading=10, textColor=colors.HexColor("#64748b"))
    score_style = ParagraphStyle("AuditScore", parent=body_style, fontName=bold_font, fontSize=26, leading=30, alignment=TA_CENTER, textColor=colors.HexColor("#173766"))

    story = [
        Paragraph(escape(str(result.get("title") or "Web Audit Report")), title_style),
        Paragraph(f"Framework v{escape(str(result.get('frameworkVersion') or '1.0'))} | Created {escape(str(record.get('createdAt') or ''))}", small_style),
        Spacer(1, 4 * mm),
    ]
    score_table = Table([
        [Paragraph(f"{int(result.get('score') or 0)}<br/><font size='9'>/ 100</font>", score_style), Paragraph(f"<b>{escape(str(result.get('rating') or ''))}</b><br/>{escape(str(result.get('url') or record.get('url') or ''))}<br/>Topic: {escape(str(result.get('topic') or 'General readiness'))}<br/>Locale: {escape(str(result.get('locale') or 'Not supplied'))}", body_style)],
    ], colWidths=[38 * mm, 132 * mm])
    score_table.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.75, colors.HexColor("#cbd5e1")), ("INNERGRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")), ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 8), ("BOTTOMPADDING", (0, 0), (-1, -1), 8)]))
    story.extend([score_table, Spacer(1, 4 * mm)])

    caps = result.get("caps") if isinstance(result.get("caps"), list) else []
    if caps:
        story.append(Paragraph("Score caps", heading_style))
        for cap in caps:
            story.append(Paragraph(f"Maximum {escape(str(cap.get('maximum')))}: {escape(str(cap.get('reason') or ''))}", body_style))

    for category in result.get("categories") or []:
        story.append(KeepTogether([
            Paragraph(f"{escape(str(category.get('label') or 'Category'))} - {escape(str(category.get('score') if category.get('score') is not None else 'Not assessed'))}/100 ({escape(str(category.get('weight') or 0))}% weight)", heading_style),
        ]))
        rows = [[Paragraph("Status", small_style), Paragraph("Check and evidence", small_style), Paragraph("Points", small_style)]]
        for check in category.get("checks") or []:
            status = str(check.get("status") or "").replace("_", " ").title()
            detail = f"<b>{escape(str(check.get('label') or ''))}</b><br/>{escape(str(check.get('evidence') or ''))}"
            if check.get("recommendation") and check.get("status") != "pass":
                detail += f"<br/><font color='#64748b'>Recommendation: {escape(str(check.get('recommendation')))}</font>"
            points = "-" if check.get("status") == "not_applicable" else f"{check.get('pointsEarned', 0)}/{check.get('pointsAvailable', 0)}"
            rows.append([Paragraph(escape(status), small_style), Paragraph(detail, body_style), Paragraph(escape(points), small_style)])
        table = Table(rows, colWidths=[25 * mm, 125 * mm, 20 * mm], repeatRows=1)
        table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9eff8")), ("GRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story.extend([table, Spacer(1, 2 * mm)])

    story.extend([Spacer(1, 3 * mm), Paragraph("How to read this report", heading_style)])
    for limitation in result.get("limitations") or []:
        story.append(Paragraph(escape(str(limitation)), body_style))
    story.append(Paragraph("This PDF is a snapshot of the saved audit result. Re-run the audit to evaluate later page changes.", body_style))

    def footer(canvas, doc):  # noqa: ANN001
        canvas.saveState()
        canvas.setFont(body_font, 7)
        canvas.setFillColor(colors.HexColor("#64748b"))
        canvas.drawString(16 * mm, 10 * mm, "Optimus web audit")
        canvas.drawRightString(A4[0] - 16 * mm, 10 * mm, f"Page {doc.page}")
        canvas.restoreState()

    document.build(story, onFirstPage=footer, onLaterPages=footer)
    return buffer.getvalue()
