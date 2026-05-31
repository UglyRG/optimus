# Configuration

Optimus reads private configuration from a root `.env` file. The file is ignored by Git.

## Core Settings

```env
DATABASE_URL=postgresql://optimus:optimus@localhost:5432/optimus
OPTIMUS_ACCESS_KEY=your-login-password
OPTIMUS_PUBLIC_API_KEY=your-public-api-key
OPTIMUS_API_KEY=legacy-or-shared-api-key
FRONTEND_ORIGIN=http://localhost:5173
SESSION_TTL_SECONDS=43200
```

`OPTIMUS_ACCESS_KEY` defaults to `optimus` in local development.

Public API authentication uses the first configured value from:

1. `OPTIMUS_PUBLIC_API_KEY`
2. `OPTIMUS_API_KEY`
3. `OPTIMUS_ACCESS_KEY`

## AI Provider Keys

```env
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=your-default-anthropic-model
OPENAI_API_KEY=your-openai-api-key
```

Provider keys are optional until a tool needs them.

## Knowledge Expert

```env
KNOWLEDGE_EXPERT_CHAT_MODEL=your-chat-model
KNOWLEDGE_EXPERT_EMBED_MODEL=text-embedding-3-small
```

Knowledge Expert stores entries even without an OpenAI key. Without embeddings, retrieval falls back to keyword matching.

## Usage Reports

```env
ANTHROPIC_ADMIN_KEY=your-anthropic-admin-api-key
OPENAI_ADMIN_KEY=your-openai-admin-api-key
```

The token usage tool uses admin/reporting keys, not normal model-call keys.

Keep optional integration keys documented here when new integrations are added.
