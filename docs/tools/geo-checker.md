# GEO Checker

GEO Checker calculates a **GEO Readiness Score** for a public page. Readiness means the page can be retrieved, understood, verified, and cited; it is not a prediction or guarantee that a generative engine will mention or cite it.

This distinction is intentional. Actual AI visibility varies by engine, prompt, locale, time, retrieval index, and repeated run. Live visibility measurements belong in a separate future report and must not be folded into the deterministic readiness score.

## Inputs

- **Page URL** is required and must resolve to a public HTML page.
- **Target topic** is recommended because generative visibility is query-dependent. Without it, alignment is marked `not_applicable`.
- **Locale** is optional context and does not change framework v1.0 weights.

Private, loopback, link-local, and reserved network destinations are rejected. Redirect destinations receive the same validation.

## Saved audit history

Every successful audit is saved in Postgres. A record contains the submitted URL, target topic and locale, creator and timestamp, and the complete readiness result including framework version, category results, individual checks, evidence, recommendations, caps, summary, and limitations. Raw downloaded HTML is not retained.

Past results are available on the tool page. A saved result can be reopened, deleted, or exported as a PDF snapshot. Deletion is permanent after confirmation.

## Framework v1.0

| Category | Weight |
| --- | ---: |
| AI accessibility and retrievability | 20% |
| Answer extractability | 25% |
| Evidence and citability | 20% |
| Entity clarity | 15% |
| Semantic structure | 10% |
| Originality and trust | 10% |

Checks use the same explainable calculation as SEO Checker: pass earns full points, warning earns half, fail earns zero, and not-applicable checks are removed from the denominator.

Critical conditions cap the result:

- `noindex`: maximum 20
- Fewer than 80 exposed visible words: maximum 35
- Less than 40% coverage of the supplied target-topic terms: maximum 40

Term coverage is a deterministic diagnostic, not semantic proof. Natural paraphrases can score lower than their meaning warrants.

## What the categories test

- **Accessibility** covers public fetchability, retrieval directives, machine-readable HTML text, and canonical identity.
- **Extractability** covers target fit, concise self-contained passages, descriptive headings, lists or tables, and topical focus.
- **Evidence** covers supporting external sources, specific facts, explicit attribution, and methodology or limitations.
- **Entity clarity** covers page identity, publisher responsibility, and machine-readable organization, person, product, or site signals.
- **Semantic structure** covers semantic main content, page-appropriate JSON-LD, and dates.
- **Originality and trust** covers useful depth, accountable authorship, and freshness transparency.

Including statistics or citations does not automatically make content trustworthy. The checker reports structural evidence signals and does not validate whether a claim or source is true.

## Future live visibility report

A provider-backed visibility feature should be reported separately with repeated observations. Suitable measures include mention rate, citation rate, citation prominence, representation accuracy, and engine coverage. Results should include the tested prompts, engines, locale, run count, and observation dates.
