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

## Retrieval

Knowledge Expert uses `OPENAI_API_KEY` with `KNOWLEDGE_EXPERT_EMBED_MODEL` or `text-embedding-3-small` for embeddings.

If no OpenAI key is configured, entries are still stored and retrieval falls back to keyword matching.

## Answers

Answers use `ANTHROPIC_API_KEY` with:

1. `KNOWLEDGE_EXPERT_CHAT_MODEL`
2. `ANTHROPIC_MODEL`

If neither model setting is configured, the backend uses its built-in Knowledge Expert default.

The assistant should decline when retrieved context does not support an answer.

## Admin and Traces

The tool includes:

- streaming chat responses
- citation chips
- feedback
- trace events
- conversation reports
- error reports
- dead-entry reports
- knowledge-gap reports
