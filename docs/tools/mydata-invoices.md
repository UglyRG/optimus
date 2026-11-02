# myDATA Purchases

Hosted tool ID: `mydata-invoices`. Open **myDATA Purchases** from the Optimus tool dashboard.

## Current release: read-only intake

This is a local monthly purchase-review workspace for up to three represented companies. It supports supplier invoices, retail receipts, credit notes and other purchase documents. Accountant participation is optional. There is no accountant role or approval requirement in the preparation workflow.

1. Open **Settings**, enter the actual company names and optionally their Greek ΑΦΜ, and save each company.
2. Choose a company and review month (defaults to the previous calendar month). Optionally configure its AADE read connection in Settings and use **Sync from AADE**.
3. Add PDF/JPEG/PNG originals or enter a purchase manually.
4. Extraction is queued automatically for new uploads. The visible QR-lookup option controls whether supported provider links are checked online. Open **Review**, inspect evidence, choose suggestions to apply, enter/correct facts, and save drafts. Classification notes and line allocations are optional; use the official code dropdowns described below.
5. **Mark details reviewed** or **Reviewed and next** after checking the facts. Save draft clears prior review. Required facts and basic amount reconciliation are checked on the backend.
6. Export a saved draft as preparation JSON, or download an encrypted module backup from Settings.

“Details reviewed” records a check of purchase facts, not accounting approval, valid tax treatment, AADE acceptance or filing completion. New classification selections are checked against the pinned code lists and available workbook pairings. This is not tax-treatment or submission validation. The session display name recorded in history is self-entered; it is not a verified legal identity.

## Scope and limits

- Authenticated AADE `RequestDocs` reads are implemented; official tax rules, approval, submission XML generation and tax submission are not. Recognised provider QR links can retrieve existing invoice XML without credentials. Extraction runs locally by default. Optional AI assistance uses existing private Anthropic configuration only after per-extraction text-sharing consent.
- All documents start as drafts. New AADE imports seed editable drafts from structured evidence; later syncs preserve your saved fields. Extraction produces separate suggestions and never overwrites purchase fields automatically. A printed MARK remains unverified and does not establish a remote match.
- **Catch up older purchases** selects an inclusive range of review months. It does not transmit old records or establish whether late reporting is allowed. Review month and actual issue date are separate; moving a draft to another review month does not change its issue date.
- One purchase per file. Split combined files before upload. Up to 50 sequential files per batch, 25 MB per file, 30 PDF pages, 30 megapixels per image. Password-protected, corrupt and mismatched files are rejected.
- Exact SHA-256 duplicates are linked to the existing company record even if it is in a different review month. Business-identity/MARK matching is available against synced AADE evidence; duplicate local uploads with different file bytes are not automatically merged. The same original can exist independently in different companies.
- Lists are paginated at 100 records. Review filters apply on the server; company progress covers the whole selected period. “Reviewed and next” advances through the current page.
- Monetary values use decimal strings with up to two decimal places. Decimal comma is accepted; thousands separators and ambiguous amounts are rejected. This is a EUR-oriented preparation format, not the final AADE precision contract. Foreign-currency tax treatment is not implemented.
- Missing company ΑΦΜ is allowed during preparation; entered Greek company numbers receive structural/checksum validation. That does not establish identity or representation authority.
- Normal saves use revision preconditions. Conflicts retain the local editor; copy unsaved edits before reloading. Navigation warns about unsaved edits; uploads and saves block navigation while active.

## Storage, audit and recovery

Dedicated tables are initialized idempotently from `backend_py/sql/002_mydata.sql`: companies, documents, invoice drafts, extraction jobs/results, remote AADE records, sync jobs and append-only application audit events. Draft fields, extracted page text/evidence and audit snapshots are Postgres JSONB. Originals are AES-256-GCM encrypted under `data/mydata/` with random internal filenames; no originals are put in Outputs. Preview requires the Optimus session and matching company/document scope. No public-key API routes are provided.

The module creates `data/.mydata.key` on first company creation (0600). Original files are 0600; the private directory is created as 0700. Keep that key separately in secure storage. It is excluded from Git and every application backup. A missing/wrong key locks originals and backup recovery; there is no key recovery bypass. Database drafts are not encrypted at rest; protect the installation and database accordingly.

Settings provides an encrypted module-only JSON backup/restore. The general **Manage tools** ZIP includes the same encrypted snapshot as `mydata-invoices.json` whenever companies exist. Snapshots include all companies, originals, drafts, extraction results/jobs, remote records, encrypted read responses, sync jobs and audit history, not API secrets or the encryption key. Backups are generated in memory; large archives will require a streaming implementation before substantial historical imports.

Restore on another installation requires the original `data/.mydata.key` first. Restore authenticates and validates originals/checksums before replacement, then replaces module records in one database transaction. It retains history, refreshes revisions and clears review markers. No tax-submission queue exists. Restored queued/running extraction and sync jobs are cancelled; completed evidence is retained, but restored revisions prevent applying old results. Older version-1 archives without extraction records remain supported. Older general archives without the module entry preserve module data. The general multi-tool restore is not one transaction; module-only restore is available for isolated recovery. Encrypted files superseded by restore remain privately stored; orphan cleanup and retention controls are future work.


## Extraction and review

New uploads queue local QR decoding and text/OCR extraction. **Look up recognised invoice QR links** is enabled by default in the UI with an explicit disclosure, and its on/off preference is remembered in this browser for all three companies. Turn it off for offline processing. The API defaults `lookupQr` to false when it is omitted. AI assistance remains a separate opt-in, off by default. Existing uploads can use **Extract information** in the Review workspace; nothing is reprocessed merely by opening an existing record. New uploads that match an existing hash do not queue duplicate work.

- Embedded PDF text is extracted with pypdf in visual layout mode, page by page; the original content-stream text is retained separately. Aligned column headings and values are read together, including document numbers/dates and footer totals. Pages with little usable text and JPEG/PNG documents use Tesseract with `ell+eng`. Small, non-square header images in otherwise digital PDFs can also be read locally for supplier branding. A logo-derived name is an unselected guess requiring verification; customer names and bank beneficiaries cannot establish the supplier name. Scanned PDF pages are rendered locally with pypdfium2; temporary image data travels through private process pipes.
- The local parser proposes explicitly labelled supplier, tax ID, invoice number, issue date, currency, MARK and totals. A supplier inferred from the header is clearly labelled a guess. Simple tables with explicit description/net/VAT-amount columns can produce lines. Greek tables with a bare ΦΠΑ column are retained as printed evidence rather than treating rates as line VAT amounts; their descriptions can still be proposed. Unsupported allocations remain manual. No line amounts, missing totals, accounting treatment or business purpose are invented.
- Conflicting candidates are left unresolved. Greek-labelled day/month dates use Greek ordering; ambiguous English numeric dates are left for manual entry. Decimal commas and validated thousands grouping are normalized with decimal arithmetic; identifiers stay strings.
- Suggestions retain raw evidence, page/text spans and OCR line bounding boxes where available. OCR word confidence is not classification confidence. Results retain parser version, source SHA-256 and OCR engine/language-file hashes. Evidence links select the source PDF page; images open as a single page. The original panel renders PDF pages locally with page navigation and zoom controls, so it works without a browser PDF plugin.
- Save unsaved edits before extraction or applying suggestions. Select the fields you want to apply; existing values are shown alongside suggestions. Applying updates the saved draft, records an audit event and clears review. Any later fact/company revision makes the old result inapplicable.
- Jobs are persisted in `mydata_extractions`; the backend starts a single worker thread per process with database locking/leases. UI progress polls every three seconds. Parsing/OCR runs in a credential-free subprocess with a five-minute job budget, 40-second OCR page timeout, 60,000-character text budget and image pixel limits. The document-parsing subprocess has no network-fetching tools or credentials. Recognised provider retrieval runs separately under the QR policy below; models have no tool access.
- Cancel stops queued work and kills local processing on its next heartbeat. An AI request already in flight may finish, but cancelled results cannot update the draft. Interrupted/expired jobs fail for explicit retry; they are never replayed automatically. Restore cancels pending extraction jobs.

### Optional AI assistance

Configure the existing `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` in private `.env`, then restart the backend. No new provider keys or browser secret fields are introduced. Local extraction does not require any model key.

**Use AI assistance for this extraction** is off by default and resets for each request. Enabling it discloses that extracted invoice text (including names, tax IDs and amounts) is sent to Anthropic using the displayed configured model. Original files, the company profile, business-purpose answers and credentials are not sent in the model prompt. Queued jobs record actor, provider, model and consent. No customer invoice text is sent as part of automated tests.

AI suggestions must quote a real source page or identified local header-image OCR region; whitespace-only differences are allowed while exact source offsets are retained. Partial numbers cannot match inside larger amounts/identifiers, and Greek-labelled dates retain Greek day/month ordering. Type/date/decimal and recipient-role checks apply. The model has no credentials in its prompt, tools or submission access. It cannot create business-use or tax-classification suggestions in this extraction step. Strong deterministic fields are preserved. AI may propose one of the already observed conflicting values for explicit review; customer/beneficiary supplier suggestions and invalid headings are discarded with a visible warning. Conflicts with deterministic fields stay warnings; a provider failure leaves local results and manual editing available. Provider diagnostic bodies are not exposed or persisted.

### OCR setup

On macOS, the supported package installation is:

```bash
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install tesseract tesseract-lang
tesseract --list-langs
```

Both `ell` (modern Greek) and `eng` must be listed. Alternatively, install only `tesseract` and add the official `ell.traineddata` from [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) to its language-data directory. This installation uses that smaller alternative. Missing OCR disables scanned-page processing only; PDF text extraction and manual editing remain usable.

Python dependencies include pypdfium2; reinstall the backend package after dependency changes. Optional backend-only `MYDATA_TESSERACT_PATH` and `MYDATA_TESSDATA_DIR` override binary/data lookup. Leave them unset for standard installations. Restart after installing/updating language data; capability detection is cached per backend process.

Version `local-invoice-v4` retains the layout/role and provider-retrieval fixes and adds original-resolution embedded-image QR scanning plus Epsilon Digital verification-link recognition. Old saved results remain in history, but must be regenerated with **Extract again** before applying; reviewed purchase facts are never silently rewritten.


## QR references and provider retrieval

QR decoding uses zxing-cpp locally before text/OCR interpretation. PDFs are checked both through original-resolution embedded images (important for photographed receipts placed on a larger PDF page) and bounded page renders for vector QR codes. JPEG/PNG inputs are checked at their original resolution. Native image scans are limited to eight images per page, 30 megapixels per image and 60 megapixels per page; failing/oversized images do not disable page-render fallback. Duplicate payloads are merged, retaining source image dimensions, page and native-image/PDF bounds. It records page, bounding box, payload hash and reference type. At most 16 codes per page are retained; identical references across pages are deduplicated. Unsupported, payment and marketing QR codes stay inert. No invoice bytes or Optimus/AADE/provider credentials are sent during QR lookup.

Current supported paths:

| Reference | Behaviour |
|---|---|
| Impact / Entersoftone public invoice portal (`einvoice.impact.gr`, `einvoice.s1ecos.gr`) | Recognised `/p/EL…/…/…` references use the documented `/mydata` detailed XML download; the Impact adapter has been checked against the user-supplied example. |
| Epsilon Digital `epsilondigital-3rd.epsilonnet.gr/fd/<32-hex-token>:<number>` | Recognised provider verification link only; no automatic fetch or invented XML route. Local extraction remains available. |
| AADE `mydatapi.aade.gr/myDATA/TimologioQR/QRInfo?q=…` | Recognised verification link only. Authenticated company import/matching uses the separate RequestDocs connector; verification links themselves are not fetched. |
| AADE receipt verification `www1.aade.gr/tameiakes/myweb/q1.php` / `q18.php` with supported SIG encoding | Recognised verification link; a decoded total can be shown as an **unverified**, unselected hint. No full receipt API, Appodixi scraping or report submission is implemented. |
| Other destinations | Show unsupported status and continue local extraction. No automatic fetch or arbitrary external link. |

For multiple distinct invoice/receipt references, no provider is contacted until the reviewer selects a detected QR and extracts again. Browser requests pass only its payload hash (`qrChoice`), never a browser-supplied URL. Invalid choices are rejected against the freshly decoded original. Duplicate original uploads do not trigger a second lookup.

The provider reader accepts a single namespaced `InvoicesDoc`/`invoice`, checks issuer against the QR reference, preserves MARKs/identifiers as strings, checks dates/decimal precision and reconciles detailed net/VAT amounts with summary totals. It retains original XML, SHA-256, retrieval time, source field paths and remote line references. It does not claim full XSD/tax validation, retrieve classification rights, or infer tax classifications. Invoice copies can be grouped differently from remote lines; retrieved provider lines are evidence for review, not positional matches to PDF rows.

A configured company ΑΦΜ is compared with the returned recipient when present. Printed identity, currency, MARK and totals are compared with local extraction. Any mismatch shows both values and prevents substitution by provider suggestions. Missing company/recipient identity and partially readable documents are disclosed. Withholding, fees, stamp duty or other adjustments stay review-only. Missing line descriptions are not invented. Supplier names absent from XML continue to use local evidence; logo-derived names remain unselected guesses.

Successful retrieval is labelled **Data retrieved from provider**, never “Accepted by AADE”. Every field remains a proposal; applying selected fields uses the existing immutable extraction/revision checks and clears review. Local extraction remains usable on network failure, unsupported formats or unsafe XML. Optional AI cannot replace provider-derived fields.

### Network and storage policy

Only HTTPS on port 443 to the exact two provider hosts and validated public invoice-download paths is fetched. Every redirect must retain the original invoice path and remain on an allowlisted host. Resolved private/loopback/link-local/multicast addresses, mixed DNS answers and changed destinations are rejected; the validated IP is pinned while TLS verifies the original hostname. The client uses no environment proxies, cookies or authentication headers. Reads are bounded (2 MiB response, three attempts including redirects, approximately 20 seconds plus a socket timeout); compression, unsafe entities/DTDs and non-invoice/login HTML are rejected. Cancellation is checked before and after lookup; an already in-flight read may finish but cannot change a cancelled job or draft.

QR URLs may grant access to private invoice data. Full payloads and downloaded XML stay in the session-protected extraction evidence and encrypted module backups, not logs or redacted audit summaries. They are excluded from the AI request except where an invoice itself prints a URL in its text. Restore cancels queued/running lookup jobs and requires a new extraction before applying old results. No new database tables, external credentials or `.env` keys are needed for public provider retrieval.

Contract references: [AADE download-format guidance](https://www.aade.gr/ekdosi-v1012), [provider download-route documentation](https://developers.s1ecos.com/changelog-1116726m0), [provider production hosts](https://developers.s1ecos.com/offline-qr-code-implementation-8-6-1220975m0), and [AADE receipt QR specification](https://www.aade.gr/sites/default/files/2023-09/a1135_2023fek.pdf). These read-only contracts do not establish current tax submission eligibility. Recheck contracts when adding providers or enabling AADE writes.

## Monthly AADE intake

Configure the fixed private `.env` [connection slots](../configuration.md#read-only-aade-connections), choose a slot and access type in each company profile, and save. No accountant profile or approval is required. Local uploads remain available without AADE configuration.

**Test connection** performs one authenticated RequestDocs page read for the selected range's first month. It does not import purchases and does not establish complete coverage or write authority. **Sync from AADE** queues the selected company and inclusive month range (up to 120 months). Historical periods are split into calendar months. Every month starts at MARK `0`, uses issue-date boundaries, and follows both server continuation keys. This intentionally refreshes old classifications/cancellations rather than treating the highest invoice MARK as a complete change cursor. It is a period refresh, not a global incremental change feed.

The worker commits each response, parsed records and the next continuation checkpoint together. Repeated invoice MARKs are upserted within company/environment scope. Cancelling retains already committed pages; an in-flight response cannot commit after cancellation or restore. Interrupted leases fail for explicit retry. A new sync safely re-reads/deduplicates prior pages. Repeated tokens, invalid/unsafe XML, date-filter violations, oversized responses and unsupported data shapes fail visibly without advancing that page. Partial results are available but must not be mistaken for a completed sync. Limit: 1,000 pages and 64 MiB of raw response evidence per job, 8 MiB per response and 500 lines per invoice. Broaden historical imports in smaller ranges if these limits are reached.

Only invoices with a returned counterpart ΑΦΜ matching the selected company enter purchase intake; other or missing recipient identities are counted as excluded. New records create unreviewed editable drafts, using the issue month as the initial review month. Exact unique MARK matches with no contradictory known identity/amounts can link existing drafts. Supplier ΑΦΜ/date/number candidates and conflicting or multiple MARK candidates require explicit review in **AADE records and matching**. Matching never copies remote fields into a local draft. Conflicts must be resolved before linking; a reviewer can instead create a separate draft. The module does not claim that an unlinked upload is absent from AADE: a range can be incomplete, not synced, or missing a confirmed recipient. No fuzzy auto-match, positional line match or taxpayer-directory lookup is performed.

Open **Review** to compare saved fields with the linked AADE evidence. Select fields under **Compare and use AADE fields** to copy them explicitly, or edit manually. Both purchase and remote revision preconditions apply. Existing classification codes, summary/line references and observed classification events remain separate read-only evidence. They are never copied into proposed tax classifications; the event history is not represented as a reconstructed current tax ledger. Cancellations are recognised both from `cancelledByMark` and cancellation events. Classification-only/cancellation events that arrive before their invoice are retained and joined when that invoice is later read. Missing records on a later date-range response are not treated as cancellation/deletion.

Remote changes clear the linked draft's review marker and refresh its revision while preserving edited fields. Applying selected AADE fields also clears review. Remote amounts retain exact decimal strings; values beyond editable precision stay in evidence and require manual review rather than rounding. Credit signs and special taxes are preserved without inferring accounting treatment. Unsupported document types are marked Other. AADE may omit supplier names/descriptions; these remain empty for the reviewer. A new imported draft can use **Attach original** to add its PDF/photo without creating another purchase. If the same original already belongs to another local draft, that duplicate is reported rather than silently merging records.

Test records are visibly labelled, scoped independently from production MARKs, and cannot match imported production drafts. Local drafts can have separate links per environment; this does not establish production acceptance. A successful read proves only the response received, not fiscal correctness, current classification authority or permission to submit.

Original remote invoice XML and each full RequestedDoc response are encrypted using the module key with record/job-specific authenticated contexts. Parsed remote facts/event history are JSONB and are not encrypted at rest. They are session-protected and included only in the encrypted module backup. Credentials are excluded. Old version-1 snapshots without remote/sync tables restore with empty new tables; pending reads are cancelled on restore and restored revisions change. No sync starts automatically after restore, setup or opening the tool. A last-completed timestamp refers to the recorded connection/range job, not all historical periods or a fresh live authority check.

The RequestDocs response structure is pinned to AADE v2.0.2. `backend_py/optimus_api/mydata/contracts/manifest.json` records the official release/package URL and SHA-256 plus all package member hashes; the requested-document XSD is vendored for inspection. The reader accepts direct RequestedDoc XML and the production Microsoft serialization `string` wrapper containing escaped RequestedDoc XML. It unwraps that exact namespace once, applies the same size/DTD/entity protections to both layers, and retains the original wire response for encrypted evidence and checksum. Other or nested wrappers fail without cursor advancement. The reader performs bounded structural/namespace checks, not comprehensive XSD or tax validation. The official combination workbook now supplies preparation dropdowns; complete tax rules and submission validation remain future work. Production and sandbox read URLs/authentication follow the [official ERP documentation](https://www.aade.gr/sites/default/files/2026-09/myDATA%20API%20Documentation%20v2.0.2_official_erp_1.pdf), sections 4.1.2, 4.2.6 and 6.2.

## Delete a local upload

The purchase list's **Action** column shows **Delete** beside **Review** for manually uploaded purchases. The confirmation identifies the purchase and company and explains the removal. Imported AADE drafts, including imports with an attached original, cannot be deleted through this action. Pure manual entries without an uploaded document are outside this deletion action.

Deletion requires the current saved revision and company scope. It removes the local purchase, document record and extraction jobs/results in one transaction, then removes the encrypted original file after commit. A failed transaction keeps the original; an operating-system file cleanup failure is reported explicitly. Active extraction results cannot recreate a deleted purchase. Existing audit history and encrypted backups are retained; recovery requires an earlier backup. The same original can be uploaded again after deletion.

A local upload already linked to AADE can be deleted while retaining and unlinking the remote evidence, with a new remote revision. The AADE record remains available for matching and a later sync may create a new AADE-origin draft for it. This action never calls an upstream cancellation/deletion method. Deleting locally is not a privacy-erasure operation: audit facts and previous backups remain.

## Classification dropdowns

Open **Review → Classification notes and line allocations**. The document-level expense category, E3 code and VAT classification code are dropdowns showing the official code and Greek label. Each allocation line has the same choices; VAT notes remain free text. Document choices and line choices are independent and are never copied across automatically.

For linked AADE purchases, the remote invoice type determines the category/E3 choices. For local drafts, choose the **myDATA document type** in the same section. Changing the broad document kind (supplier invoice/receipt/credit) does not guess an official type. Expense categories are filtered by that type where the official workbook lists explicit combinations; E3 choices then depend on the category. Until a type is known, general category pairings are shown with a notice. VAT classification codes (`VAT_361`–`VAT_366`, `NOT_VAT_295`) have a separate dropdown; they are not E3 codes or VAT rates, and the UI does not infer deduction rights or category/VAT compatibility.

The catalogue uses the official v2.0.2 combination workbook, code enums from the matching expense XSD, and Greek descriptions from API appendices 8.9–8.11. `contracts/classification-catalogue.json` contains source URLs/hashes, description pages, per-type/category choices, source rows, conditional notes and source discrepancies. The original public workbook is retained as `contracts/classification-combinations-v2.0.2.xlsx`. `scripts/import_mydata_classifications.py` regenerates this read-only import using bundled Python with openpyxl/pypdf; neither is a new runtime requirement. The catalogue is shipped locally and requires no AADE or model credentials.

The workbook/PDF mention `E3_585_017`, which is absent from the pinned expense XSD enum. It is documented but excluded from selectable values. The four `E3_881_…` codes in the expense enum use the official descriptions in appendix 8.9. Related-document types (such as 5.1) and prior/next-year categories retain explicit review notices; the dropdown filter does not claim to resolve their extra conditions. Categories marked as not updating E3 offer a blank E3 choice.

New unknown codes and newly incompatible category/E3 pairs are rejected on save by the backend. Partial optional classifications can be saved as drafts, with review notes about missing selections. Existing typed values and existing incompatible combinations remain visible as saved values requiring review; they are not silently cleared or relabelled as official codes. Choosing a different category/type preserves the old dependent value on screen until the reviewer changes or clears it. Revision checks still apply and saves clear previous detail review.

Drafts add optional `mydataInvoiceType`, document/line `vatClassification`, and server-generated `classificationCheck` (catalogue version, effective invoice type, scope and warnings). These values are included in exports and encrypted backups. Old snapshots without them remain supported; the application ships the source catalogue separately. No data is migrated or automatically classified. These lists are preparation aids, not proof of business purpose, correct VAT deduction, historical rule applicability, full allocation reconciliation or readiness to submit. No AADE write endpoint is enabled.

## Next delivery stages

1. Complete a representative monthly review for each company, including local uploads, missing/ambiguous facts, matching conflicts and an encrypted backup/restore exercise. Production RequestDocs and its serialized XML response have been exercised on this installation; each additional connection/environment still needs its own read check.
2. Extend the pinned dropdown catalogue into period-aware classification proposals and VAT/line-allocation validation. Require business-use answers where facts alone cannot establish treatment; resolve related-invoice conditions and official source discrepancies. Historical periods must retain their applicable rule evidence.
3. Add controlled classification submissions against existing MARKs: immutable reviewer-approved snapshots, exact validated XML, an outbox, internal idempotency and reconciliation of unknown outcomes. Validate contracts in the sandbox before enabling supported production writes. Production remains disabled in v8.
4. Add separately validated receipt/recipient-reported purchase transmission, including missing supplier records only under verified reporting conditions. This expands the original classification-only specification; it does not introduce sales invoice issuance.

All stages must support the three companies and historical periods. Credentials remain backend-only in private `.env`; accountant involvement remains optional in the Optimus workflow. Representation/connection authority and applicable actor/tax requirements must be verified before writes. No unattended production submissions.

## Validation

```bash
PYTHONPATH=.:backend_py backend_py/.venv/bin/pytest -q backend_py/tests
npm run build:react
```

Database integration tests run only when `MYDATA_TEST_DATABASE_URL` points to an explicitly selected test database. They create/drop isolated random schemas and never use the configured application database automatically. Tests cover company scoping, three-company limits, concurrent revision checks, duplicate uploads, authenticated preview, origin rejection, QR/XML safety, read pagination/cancellation, wrapped production responses, classification choices, local-upload deletion and encrypted backup/restore. Every automated upstream read/provider call is mocked; production credentials are never used by the tests.
