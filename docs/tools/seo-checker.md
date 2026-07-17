# SEO Checker

SEO Checker performs a stateless, page-level audit of a public HTTP or HTTPS URL. It measures readiness for conventional search discovery; it does not predict or guarantee indexing, ranking, traffic, or rich results.

## Inputs

- **Page URL** is required and must resolve to a public HTML page.
- **Target topic** is recommended. Without it, target-topic alignment is marked `not_applicable` and removed from the denominator.
- **Locale** is optional context and is returned with the audit. Framework v1.0 does not change weights by locale.

Private, loopback, link-local, and reserved network destinations are rejected. Redirect destinations receive the same validation. Page content is not persisted.

## Framework v1.0

| Category | Weight |
| --- | ---: |
| Crawlability and indexability | 25% |
| On-page relevance | 20% |
| Content quality | 20% |
| Structure and semantics | 15% |
| Performance and mobile UX | 15% |
| Security and hygiene | 5% |

Each applicable check is a `pass`, `warning`, or `fail`, earning full, half, or zero points. A `not_applicable` check is removed from its category denominator. Category scores are combined with the weights above.

Critical conditions cap the weighted result:

- `noindex`: maximum 20
- Canonical URL on another host: maximum 45

Cross-domain canonicals can be legitimate, but the cap makes the page's own search eligibility explicit.

## Rating bands

| Score | Rating |
| ---: | --- |
| 90–100 | Excellent |
| 75–89 | Good |
| 50–74 | Needs work |
| 25–49 | Poor |
| 0–24 | Blocked or critical |

## Limitations

The deterministic fetch checks returned HTML and headers. It does not execute JavaScript, measure backlinks or site-wide duplication, inspect Search Console, or collect browser field data. Core Web Vitals are therefore marked not assessed. They should be measured separately using field data where available; browser lab data must be labeled as lab data.

