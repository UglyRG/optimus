# Knowledge Expert

Knowledge Expert lets the user upload a curated knowledge base and ask grounded questions with source citations.

## Uploads

Supported upload types:

- CSV
- HTML
- TXT
- Markdown
- JSON
- PDF
- DOCX

CSV headers support:

- `category`
- `question`
- `answer`
- `link`

JSON can be an array of entries or an object with an `entries` array.

Uploads can append to the active dataset or replace the dataset atomically.

The backend accepts between 1 and 20 files in one upload. Each parsed file contributes at most 1,000 usable knowledge entries and 5,000 retained source chunks.

Structured CSV and JSON Q&A fields are preserved directly. Text-like prose is split into blocks and converted into Q&A entries with deterministic heuristics. A short first line or first sentence becomes the question; the remaining block becomes the answer. Explicit `Question:` and `Answer:` content is extracted directly.

## Source Traceability

Ingestion retains the source material used to derive each Q&A:

- text, Markdown, and HTML retain content blocks, headings, and character offsets
- CSV retains each data row with its row number
- JSON retains each entry with its array locator
- PDF retains extracted text blocks with page numbers and page/block locators
- DOCX retains paragraphs and table rows with section headings and structural locators
- each knowledge entry stores the IDs of its supporting source chunks

Source chunks are included in backup and restore snapshots and feed the Source coverage admin report.

The Source coverage admin report calculates:

- traceability: source chunks linked to at least one knowledge entry
- lexical coverage: normalized Unicode source words represented in linked questions and answers
- answer support: normalized answer words also present in linked source chunks
- uncovered and partially covered source chunks
- legacy entries that have no source links

These are deterministic lexical checks, not semantic proof. Paraphrases can score lower than their meaning warrants, and a high answer-support score does not detect contradictions.

For structured CSV and JSON Q&A, lexical coverage compares the recognized question and answer values rather than serialized field names or metadata such as category and link. The complete original row or object remains retained as the traceable source chunk.

## Knowledge Map

The Knowledge Map opens from the Knowledge Expert page header and visualizes:

- uploaded documents
- retained source chunks
- Q&A entries supported by each chunk
- chunk coverage status
- Q&A retrieval and citation activity
- semantic similarity between embedded Q&A entries

The map provides search, node-type filters, zoom controls, and a selected-node details panel. Documents appear in the inner layer, chunks in the middle, and Q&A entries in the outer layer. Large datasets are bounded for browser performance and the modal reports when nodes have been omitted from the display.

Semantic links are hidden by default to keep the graph readable. The toggle displays up to three nearest neighbors per embedded Q&A entry when cosine similarity is at least `0.82`. These links use embeddings already stored in Postgres; opening the map does not call an AI provider. Entries without embeddings remain in the structural map but do not receive semantic links.

## PDF and DOCX Extraction

PDF text is extracted page by page. Password-protected PDFs are rejected. Image-only or scanned PDFs require OCR before upload.

DOCX extraction reads headings, paragraphs, and table rows. Word pagination is not stable in the document format, so DOCX citations use paragraph and table-row locators rather than page numbers. Adjacent `Question:` and `Answer:` paragraphs are combined into one entry.

PDF and DOCX extraction is local and does not call an AI provider.

## Retrieval

Knowledge Expert uses `OPENAI_API_KEY` with `KNOWLEDGE_EXPERT_EMBED_MODEL` or `text-embedding-3-small` for embeddings.

If no OpenAI key is configured, entries are still stored and retrieval falls back to keyword matching.

Each question is retrieved independently from its current message. Conversations persist and organize turns, but previous turns are not currently added to the retrieval query.

## Answers

Answers use `ANTHROPIC_API_KEY` with:

1. `KNOWLEDGE_EXPERT_CHAT_MODEL`
2. `ANTHROPIC_MODEL`

If neither model setting is configured, the backend uses its built-in Knowledge Expert default.

The assistant should decline when retrieved context does not support an answer.

Grounded answers must return citation IDs belonging to the retrieved entries. Invalid or missing citation IDs cause the answer to be replaced with the standard Knowledge Expert decline response.

## Admin and Traces

The tool includes:

- streaming chat responses
- citation chips
- feedback
- trace events
- conversation reports
- error reports
- dead-entry reports
- source-coverage reports
- interactive Knowledge Map
- knowledge-gap reports
