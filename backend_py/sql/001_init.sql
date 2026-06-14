CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS app_data (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
  id text PRIMARY KEY,
  category text NOT NULL DEFAULT 'General',
  question text NOT NULL DEFAULT '',
  answer text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  source_doc text NOT NULL DEFAULT '',
  source_page text,
  source_chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  question_source text NOT NULL DEFAULT 'original',
  sort_order integer NOT NULL DEFAULT 1,
  embedding vector(1536),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE knowledge_entries
ADD COLUMN IF NOT EXISTS source_chunk_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS knowledge_entries_embedding_hnsw
ON knowledge_entries
USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS knowledge_uploads (
  id text PRIMARY KEY,
  file_name text NOT NULL DEFAULT 'knowledge-base',
  file_type text NOT NULL DEFAULT 'text',
  row_count integer NOT NULL DEFAULT 0,
  chunk_count integer NOT NULL DEFAULT 0,
  uploaded_by text NOT NULL DEFAULT '',
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE knowledge_uploads
ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS knowledge_source_chunks (
  id text PRIMARY KEY,
  upload_id text NOT NULL REFERENCES knowledge_uploads(id) ON DELETE CASCADE,
  source_doc text NOT NULL DEFAULT '',
  source_type text NOT NULL DEFAULT 'text',
  chunk_index integer NOT NULL DEFAULT 1,
  locator text NOT NULL DEFAULT '',
  heading text NOT NULL DEFAULT '',
  source_page text,
  content text NOT NULL DEFAULT '',
  char_start integer,
  char_end integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS knowledge_source_chunks_upload_idx
ON knowledge_source_chunks (upload_id, chunk_index);

CREATE TABLE IF NOT EXISTS knowledge_conversations (
  id text PRIMARY KEY,
  title text NOT NULL DEFAULT 'New chat',
  summary text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_turns (
  id text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES knowledge_conversations(id) ON DELETE CASCADE,
  user_name text NOT NULL DEFAULT '',
  user_message text NOT NULL DEFAULT '',
  assistant_response text NOT NULL DEFAULT '',
  grounded boolean NOT NULL DEFAULT false,
  error text NOT NULL DEFAULT '',
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  retrieved_entry_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  user_message_embedding vector(1536),
  trace_events jsonb NOT NULL DEFAULT '[]'::jsonb,
  feedback_rating integer NOT NULL DEFAULT 0,
  feedback_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer NOT NULL DEFAULT 0,
  chat_model text NOT NULL DEFAULT '',
  embed_model text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS knowledge_turns_conversation_created_idx
ON knowledge_turns (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_turns_user_message_embedding_hnsw
ON knowledge_turns
USING hnsw (user_message_embedding vector_cosine_ops);
