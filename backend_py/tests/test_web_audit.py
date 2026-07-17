from optimus_api import web_audit


HTML = """<!doctype html>
<html lang="en"><head>
<title>Practical Local SEO Consulting Guide for Small Businesses</title>
<meta name="description" content="A practical, evidence-led guide to local SEO consulting, measurement, implementation, and common limitations for small businesses.">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="author" content="Example Research Team">
<link rel="canonical" href="https://example.com/local-seo">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","author":{"@type":"Organization","name":"Example"}}</script>
</head><body><main><article><h1>Local SEO consulting</h1>
<h2>What local SEO consulting includes</h2>
<p>Local SEO consulting helps a business improve its visibility for location-specific searches. It starts with accurate business information and useful pages.</p>
<h2>Evidence and method</h2>
<p>According to the Example 2026 study, 72% of a sample of 500 customers checked a business profile before visiting. The method covered three cities and has a limited sample.</p>
<ul><li>Audit business details</li><li>Improve service pages</li></ul>
<table><tr><th>Measure</th><th>Target</th></tr><tr><td>Accuracy</td><td>100%</td></tr></table>
<p>Use direct statements and cite primary evidence. Measure results over 90 days, because visibility changes over time and no single check guarantees ranking.</p>
<p>Original analysis should explain its scope, method, inputs, and limitations. This makes claims easier for readers to verify and reuse responsibly.</p>
<p>Clear headings help readers navigate the page. Concise paragraphs also create passages that retain their meaning when quoted outside the page.</p>
<p>Businesses should keep names, addresses, services, and opening hours consistent. They should correct outdated information whenever operations change.</p>
<p>A useful consultant connects recommendations to business goals. Reports should distinguish observations, assumptions, experiments, and measured outcomes.</p>
<p>Local relevance comes from genuine service information and firsthand knowledge. Repeating keywords without adding value does not help the reader.</p>
<a href="/services">Services</a><a href="https://developers.google.com/search/docs/essentials">Google guidance</a><a href="https://schema.org/Article">Schema reference</a>
<time datetime="2026-07-17">17 July 2026</time><img src="chart.png" alt="Local search visibility chart">
</article></main></body></html>"""


def fake_fetch(url, max_bytes=web_audit.MAX_PAGE_BYTES):
    return {"url": "https://example.com/local-seo", "status": 200, "contentType": "text/html", "headers": {}, "text": HTML}


def test_seo_audit_returns_weighted_explainable_result(monkeypatch):
    monkeypatch.setattr(web_audit, "_fetch", fake_fetch)
    result = web_audit.audit_page({"url": "https://example.com/local-seo", "topic": "local SEO consulting"}, "seo")
    assert result["frameworkVersion"] == "1.0"
    assert result["title"] == "SEO Score"
    assert 0 <= result["score"] <= 100
    assert sum(category["weight"] for category in result["categories"]) == 100
    assert any(check["id"] == "vitals" and check["status"] == "not_applicable" for category in result["categories"] for check in category["checks"])


def test_geo_audit_is_readiness_and_topic_aware(monkeypatch):
    monkeypatch.setattr(web_audit, "_fetch", fake_fetch)
    result = web_audit.audit_page({"url": "https://example.com/local-seo", "topic": "local SEO consulting"}, "geo")
    assert result["title"] == "GEO Readiness Score"
    assert result["topic"] == "local SEO consulting"
    assert sum(category["weight"] for category in result["categories"]) == 100
    assert "not a prediction" in result["limitations"][0]


def test_noindex_caps_both_scores(monkeypatch):
    def noindex_fetch(url, max_bytes=web_audit.MAX_PAGE_BYTES):
        fetched = fake_fetch(url, max_bytes)
        fetched["text"] = fetched["text"].replace('<meta name="author"', '<meta name="robots" content="noindex"><meta name="author"')
        return fetched

    monkeypatch.setattr(web_audit, "_fetch", noindex_fetch)
    for mode in ("seo", "geo"):
        result = web_audit.audit_page({"url": "https://example.com/local-seo", "topic": "local SEO consulting"}, mode)
        assert result["score"] <= 20
        assert result["caps"][0]["maximum"] == 20


def test_missing_topic_is_not_assessed(monkeypatch):
    monkeypatch.setattr(web_audit, "_fetch", fake_fetch)
    result = web_audit.audit_page({"url": "https://example.com/local-seo"}, "geo")
    topic_check = next(check for category in result["categories"] for check in category["checks"] if check["id"] == "topic-fit")
    assert topic_check["status"] == "not_applicable"
    assert topic_check["pointsEarned"] == 0
