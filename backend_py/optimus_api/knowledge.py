from __future__ import annotations

import json
import base64
import csv
import html
import io
import re
import urllib.request
import time
import zipfile
from xml.etree import ElementTree
from io import StringIO
from pathlib import Path
from typing import Any

from pypdf import PdfReader

from .config import Settings
from .store import JsonStore
from .utils import bad_request, clean_positive_integer, clean_text, new_id, now_iso

KNOWLEDGE_EXPERT_CHAT_MODEL = "claude-haiku-4-5-20251001"
KNOWLEDGE_EXPERT_EMBED_MODEL = "text-embedding-3-small"
KNOWLEDGE_EXPERT_TOP_K = 5
KNOWLEDGE_EXPERT_ENUMERATIVE_TOP_K = 15
KNOWLEDGE_EXPERT_DECLINE = "I don't see that in the Knowledge Expert knowledge base."
KNOWLEDGE_COVERAGE_GOOD_THRESHOLD = 0.8
KNOWLEDGE_COVERAGE_LOW_THRESHOLD = 0.5


def model_names(settings: Settings) -> dict[str, str]:
    chat_model = getattr(settings, "knowledge_expert_chat_model", None) or getattr(settings, "anthropic_model", None)
    embed_model = getattr(settings, "knowledge_expert_embed_model", None)
    return {
        "chat": chat_model or KNOWLEDGE_EXPERT_CHAT_MODEL,
        "embed": embed_model or KNOWLEDGE_EXPERT_EMBED_MODEL,
    }


def normalize_embedding(value: Any) -> list[float] | None:
    if isinstance(value, str):
        value = value.strip()
        if value.startswith("[") and value.endswith("]"):
            value = [item.strip() for item in value[1:-1].split(",")]
    if not isinstance(value, list):
        return None
    embedding = []
    for item in value:
        try:
            embedding.append(float(item))
        except (TypeError, ValueError):
            continue
    return embedding if embedding else None


def vector_literal(value: list[float] | None) -> str | None:
    if not value or len(value) != 1536:
        return None
    return "[" + ",".join(str(float(item)) for item in value) + "]"


def normalize_knowledge_entry(raw_entry: dict[str, Any] | None = None) -> dict[str, Any]:
    raw_entry = raw_entry or {}
    source_chunk_ids = raw_entry.get("sourceChunkIds") or raw_entry.get("source_chunk_ids") or []
    return {
        "id": clean_text(raw_entry.get("id"), new_id(), 80),
        "category": clean_text(raw_entry.get("category"), "General", 200),
        "question": clean_text(raw_entry.get("question"), "", 500),
        "answer": clean_text(raw_entry.get("answer") or raw_entry.get("answerPreview"), "", 8000),
        "link": clean_text(raw_entry.get("link"), "", 1000),
        "sourceDoc": clean_text(raw_entry.get("sourceDoc") or raw_entry.get("source_doc"), "", 300),
        "sourcePage": raw_entry.get("sourcePage") or raw_entry.get("source_page"),
        "sourceChunkIds": [
            clean_text(chunk_id, "", 80)
            for chunk_id in source_chunk_ids
            if clean_text(chunk_id, "", 80)
        ][:20] if isinstance(source_chunk_ids, list) else [],
        "questionSource": clean_text(raw_entry.get("questionSource") or raw_entry.get("question_source"), "original", 40),
        "sortOrder": clean_positive_integer(raw_entry.get("sortOrder") or raw_entry.get("sort_order"), 1),
        "embedding": normalize_embedding(raw_entry.get("embedding")),
        "createdAt": clean_text(raw_entry.get("createdAt") or raw_entry.get("created_at"), now_iso(), 40),
    }


def normalize_knowledge_upload(raw_upload: dict[str, Any] | None = None) -> dict[str, Any]:
    raw_upload = raw_upload or {}
    return {
        "id": clean_text(raw_upload.get("id"), new_id(), 80),
        "fileName": clean_text(raw_upload.get("fileName") or raw_upload.get("file_name"), "knowledge-base", 300),
        "fileType": clean_text(raw_upload.get("fileType") or raw_upload.get("file_type"), "text", 20),
        "rowCount": clean_positive_integer(raw_upload.get("rowCount") or raw_upload.get("row_count"), 0),
        "chunkCount": clean_positive_integer(raw_upload.get("chunkCount") or raw_upload.get("chunk_count"), 0),
        "uploadedBy": clean_text(raw_upload.get("uploadedBy") or raw_upload.get("uploaded_by"), "", 120),
        "uploadedAt": clean_text(raw_upload.get("uploadedAt") or raw_upload.get("uploaded_at"), now_iso(), 40),
    }


def normalize_knowledge_source_chunk(raw_chunk: dict[str, Any] | None = None) -> dict[str, Any]:
    raw_chunk = raw_chunk or {}
    char_start = raw_chunk.get("charStart") if raw_chunk.get("charStart") is not None else raw_chunk.get("char_start")
    char_end = raw_chunk.get("charEnd") if raw_chunk.get("charEnd") is not None else raw_chunk.get("char_end")
    return {
        "id": clean_text(raw_chunk.get("id"), new_id(), 80),
        "uploadId": clean_text(raw_chunk.get("uploadId") or raw_chunk.get("upload_id"), "", 80),
        "sourceDoc": clean_text(raw_chunk.get("sourceDoc") or raw_chunk.get("source_doc"), "", 300),
        "sourceType": clean_text(raw_chunk.get("sourceType") or raw_chunk.get("source_type"), "text", 40),
        "chunkIndex": clean_positive_integer(raw_chunk.get("chunkIndex") or raw_chunk.get("chunk_index"), 1),
        "locator": clean_text(raw_chunk.get("locator"), "", 200),
        "heading": clean_text(raw_chunk.get("heading"), "", 500),
        "sourcePage": raw_chunk.get("sourcePage") or raw_chunk.get("source_page"),
        "content": clean_text(raw_chunk.get("content") or raw_chunk.get("text"), "", 20000),
        "charStart": int(char_start) if isinstance(char_start, int) and char_start >= 0 else None,
        "charEnd": int(char_end) if isinstance(char_end, int) and char_end >= 0 else None,
        "createdAt": clean_text(raw_chunk.get("createdAt") or raw_chunk.get("created_at"), now_iso(), 40),
    }


def normalize_knowledge_conversation(raw_conversation: dict[str, Any] | None = None) -> dict[str, Any]:
    raw_conversation = raw_conversation or {}
    created_at = clean_text(raw_conversation.get("createdAt") or raw_conversation.get("created_at"), now_iso(), 40)
    return {
        "id": clean_text(raw_conversation.get("id"), new_id(), 80),
        "title": clean_text(raw_conversation.get("title"), "New chat", 120),
        "summary": clean_text(raw_conversation.get("summary"), "", 1800),
        "createdBy": clean_text(raw_conversation.get("createdBy") or raw_conversation.get("created_by"), "", 120),
        "createdAt": created_at,
        "updatedAt": clean_text(raw_conversation.get("updatedAt") or raw_conversation.get("updated_at"), created_at, 40),
    }


def normalize_knowledge_turn(raw_turn: dict[str, Any] | None = None, fallback_conversation_id: str = "default") -> dict[str, Any]:
    raw_turn = raw_turn or {}
    return {
        "id": clean_text(raw_turn.get("id"), new_id(), 80),
        "conversationId": clean_text(raw_turn.get("conversationId") or raw_turn.get("conversation_id"), fallback_conversation_id, 80),
        "userName": clean_text(raw_turn.get("userName") or raw_turn.get("user_name"), "", 120),
        "userMessage": clean_text(raw_turn.get("userMessage") or raw_turn.get("user_message"), "", 4000),
        "assistantResponse": clean_text(raw_turn.get("assistantResponse") or raw_turn.get("assistant_response"), "", 12000),
        "grounded": bool(raw_turn.get("grounded")),
        "error": clean_text(raw_turn.get("error"), "", 1000),
        "citations": raw_turn.get("citations") if isinstance(raw_turn.get("citations"), list) else [],
        "retrievedEntryIds": raw_turn.get("retrievedEntryIds") or raw_turn.get("retrieved_entry_ids") or [],
        "userMessageEmbedding": normalize_embedding(raw_turn.get("userMessageEmbedding") or raw_turn.get("user_message_embedding")),
        "traceEvents": raw_turn.get("traceEvents") or raw_turn.get("trace_events") or [],
        "feedbackRating": int(raw_turn.get("feedbackRating") or raw_turn.get("feedback_rating") or 0),
        "feedbackAt": raw_turn.get("feedbackAt") or raw_turn.get("feedback_at"),
        "createdAt": clean_text(raw_turn.get("createdAt") or raw_turn.get("created_at"), now_iso(), 40),
        "durationMs": clean_positive_integer(raw_turn.get("durationMs") or raw_turn.get("duration_ms"), 0),
        "chatModel": clean_text(raw_turn.get("chatModel") or raw_turn.get("chat_model"), KNOWLEDGE_EXPERT_CHAT_MODEL, 140),
        "embedModel": clean_text(raw_turn.get("embedModel") or raw_turn.get("embed_model"), KNOWLEDGE_EXPERT_EMBED_MODEL, 140),
    }


def default_knowledge_store() -> dict[str, list[Any]]:
    return {"entries": [], "uploads": [], "sourceChunks": [], "conversations": [], "turns": []}


def normalize_knowledge_store(store: dict[str, Any] | None = None) -> dict[str, list[Any]]:
    store = store or {}
    conversations = [normalize_knowledge_conversation(item) for item in store.get("conversations", [])[:100]]
    has_legacy_turns = any(not turn.get("conversationId") for turn in store.get("turns", []) if isinstance(turn, dict))
    if not conversations and has_legacy_turns:
        conversations.append(normalize_knowledge_conversation({"id": "default", "title": "Knowledge chat"}))
    fallback_conversation_id = conversations[0]["id"] if conversations else "default"
    return {
        "entries": [normalize_knowledge_entry(item) for item in store.get("entries", [])],
        "uploads": [normalize_knowledge_upload(item) for item in store.get("uploads", [])],
        "sourceChunks": [
            normalize_knowledge_source_chunk(item)
            for item in (store.get("sourceChunks") or store.get("source_chunks") or [])
        ],
        "conversations": conversations,
        "turns": [normalize_knowledge_turn(item, fallback_conversation_id) for item in store.get("turns", [])[:500]],
    }


class KnowledgeRepository:
    def __init__(self, store: JsonStore, settings: Settings):
        self.store = store
        self.settings = settings

    def ensure_schema(self) -> None:
        sql_path = self.settings.data_dir.parent / "backend_py" / "sql" / "001_init.sql"
        with self.store.pool.connection() as connection:
            connection.execute(sql_path.read_text(encoding="utf-8"))

    def migrate_from_json_store(self) -> dict[str, int]:
        with self.store.pool.connection() as connection:
            existing = connection.execute(
                """
                SELECT
                  (SELECT COUNT(*) FROM knowledge_entries) +
                  (SELECT COUNT(*) FROM knowledge_uploads) +
                  (SELECT COUNT(*) FROM knowledge_source_chunks) +
                  (SELECT COUNT(*) FROM knowledge_conversations) +
                  (SELECT COUNT(*) FROM knowledge_turns) AS count
                """
            ).fetchone()["count"]
            if existing:
                return {"entries": 0, "uploads": 0, "sourceChunks": 0, "conversations": 0, "turns": 0, "existingRows": existing, "skipped": 1}

        legacy = self.store.get("knowledge_expert", default_knowledge_store(), self.settings.data_dir / "knowledge-expert.json")
        normalized = normalize_knowledge_store(legacy if isinstance(legacy, dict) else default_knowledge_store())
        self.replace_all(normalized)
        return {
            "entries": len(normalized["entries"]),
            "uploads": len(normalized["uploads"]),
            "sourceChunks": len(normalized["sourceChunks"]),
            "conversations": len(normalized["conversations"]),
            "turns": len(normalized["turns"]),
            "skipped": 0,
        }

    def replace_all(self, knowledge_store: dict[str, list[Any]]) -> None:
        with self.store.pool.connection() as connection:
            with connection.transaction():
                connection.execute("DELETE FROM knowledge_turns")
                connection.execute("DELETE FROM knowledge_conversations")
                connection.execute("DELETE FROM knowledge_entries")
                connection.execute("DELETE FROM knowledge_uploads")
                for upload in knowledge_store["uploads"]:
                    self.upsert_upload(upload, connection)
                for chunk in knowledge_store.get("sourceChunks", []):
                    if chunk["uploadId"]:
                        self.upsert_source_chunk(chunk, connection)
                for entry in knowledge_store["entries"]:
                    self.upsert_entry(entry, connection)
                for conversation in knowledge_store["conversations"]:
                    self.upsert_conversation(conversation, connection)
                for turn in knowledge_store["turns"]:
                    if not any(conversation["id"] == turn["conversationId"] for conversation in knowledge_store["conversations"]):
                        self.upsert_conversation(normalize_knowledge_conversation({"id": turn["conversationId"], "title": "Knowledge chat"}), connection)
                    self.upsert_turn(turn, connection)

    def replace_dataset(self, payload: dict[str, Any], user_name: str = "") -> dict[str, Any]:
        mode = "append" if payload.get("mode") == "append" else "replace"
        parsed_files = [parse_knowledge_file(file_payload) for file_payload in payload_files(payload)]
        entries = [entry for parsed_file in parsed_files for entry in parsed_file["entries"]]
        existing_count = self.entry_count() if mode == "append" else 0
        texts = [embedding_text(entry) for entry in entries]
        embeddings = embed_texts(texts, self.settings)
        now = now_iso()
        uploads = []
        normalized_chunks = []
        normalized_entries = []
        embedding_index = 0
        for parsed_file in parsed_files:
            upload = normalize_knowledge_upload(
                {
                    "id": new_id(),
                    "fileName": parsed_file["fileName"],
                    "fileType": parsed_file["fileType"],
                    "rowCount": len(parsed_file["entries"]),
                    "chunkCount": len(parsed_file["sourceChunks"]),
                    "uploadedBy": user_name,
                    "uploadedAt": now,
                }
            )
            uploads.append(upload)
            normalized_chunks.extend(
                normalize_knowledge_source_chunk({**chunk, "uploadId": upload["id"], "createdAt": now})
                for chunk in parsed_file["sourceChunks"]
            )
            for entry in parsed_file["entries"]:
                normalized_entries.append(
                    normalize_knowledge_entry(
                        {
                            **entry,
                            "id": new_id(),
                            "sortOrder": existing_count + len(normalized_entries) + 1,
                            "embedding": embeddings[embedding_index],
                            "createdAt": now,
                        }
                    )
                )
                embedding_index += 1

        with self.store.pool.connection() as connection:
            with connection.transaction():
                if mode == "replace":
                    connection.execute("DELETE FROM knowledge_entries")
                    connection.execute("DELETE FROM knowledge_uploads")
                for upload in uploads:
                    self.upsert_upload(upload, connection)
                for chunk in normalized_chunks:
                    self.upsert_source_chunk(chunk, connection)
                for entry in normalized_entries:
                    self.upsert_entry(entry, connection)

        all_entries = self.entries_for_snapshot()
        return {
            "mode": mode,
            "upload": uploads[0] if len(uploads) == 1 else {"fileName": f"{len(uploads)} files", "fileType": "mixed", "rowCount": len(normalized_entries), "uploadedAt": now},
            "fileCount": len(parsed_files),
            "addedEntryCount": len(normalized_entries),
            "addedChunkCount": len(normalized_chunks),
            "entryCount": len(all_entries),
            "embeddedCount": sum(1 for entry in normalized_entries if entry.get("embedding")),
            "entries": all_entries,
        }

    def entry_count(self) -> int:
        with self.store.pool.connection() as connection:
            return connection.execute("SELECT COUNT(*) AS count FROM knowledge_entries").fetchone()["count"]

    def turn_count(self) -> int:
        with self.store.pool.connection() as connection:
            return connection.execute("SELECT COUNT(*) AS count FROM knowledge_turns").fetchone()["count"]

    def upsert_entry(self, entry: dict[str, Any], connection: Any | None = None) -> None:
        owns_connection = connection is None
        connection = connection or self.store.pool.getconn()
        try:
            connection.execute(
                """
                INSERT INTO knowledge_entries
                  (id, category, question, answer, link, source_doc, source_page, source_chunk_ids, question_source, sort_order, embedding, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s::vector, %s)
                ON CONFLICT (id) DO UPDATE SET
                  category = excluded.category,
                  question = excluded.question,
                  answer = excluded.answer,
                  link = excluded.link,
                  source_doc = excluded.source_doc,
                  source_page = excluded.source_page,
                  source_chunk_ids = excluded.source_chunk_ids,
                  question_source = excluded.question_source,
                  sort_order = excluded.sort_order,
                  embedding = excluded.embedding
                """,
                (
                    entry["id"],
                    entry["category"],
                    entry["question"],
                    entry["answer"],
                    entry["link"],
                    entry["sourceDoc"],
                    entry["sourcePage"],
                    json.dumps(entry["sourceChunkIds"]),
                    entry["questionSource"],
                    entry["sortOrder"],
                    vector_literal(entry["embedding"]),
                    entry["createdAt"],
                ),
            )
        finally:
            if owns_connection:
                self.store.pool.putconn(connection)

    def upsert_upload(self, upload: dict[str, Any], connection: Any) -> None:
        connection.execute(
            """
            INSERT INTO knowledge_uploads (id, file_name, file_type, row_count, chunk_count, uploaded_by, uploaded_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              file_name = excluded.file_name,
              file_type = excluded.file_type,
              row_count = excluded.row_count,
              chunk_count = excluded.chunk_count,
              uploaded_by = excluded.uploaded_by
            """,
            (upload["id"], upload["fileName"], upload["fileType"], upload["rowCount"], upload["chunkCount"], upload["uploadedBy"], upload["uploadedAt"]),
        )

    def upsert_source_chunk(self, chunk: dict[str, Any], connection: Any) -> None:
        connection.execute(
            """
            INSERT INTO knowledge_source_chunks
              (id, upload_id, source_doc, source_type, chunk_index, locator, heading, source_page,
               content, char_start, char_end, created_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              upload_id = excluded.upload_id,
              source_doc = excluded.source_doc,
              source_type = excluded.source_type,
              chunk_index = excluded.chunk_index,
              locator = excluded.locator,
              heading = excluded.heading,
              source_page = excluded.source_page,
              content = excluded.content,
              char_start = excluded.char_start,
              char_end = excluded.char_end
            """,
            (
                chunk["id"],
                chunk["uploadId"],
                chunk["sourceDoc"],
                chunk["sourceType"],
                chunk["chunkIndex"],
                chunk["locator"],
                chunk["heading"],
                chunk["sourcePage"],
                chunk["content"],
                chunk["charStart"],
                chunk["charEnd"],
                chunk["createdAt"],
            ),
        )

    def upsert_conversation(self, conversation: dict[str, Any], connection: Any | None = None) -> None:
        owns_connection = connection is None
        connection = connection or self.store.pool.getconn()
        try:
            connection.execute(
                """
                INSERT INTO knowledge_conversations (id, title, summary, created_by, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO UPDATE SET
                  title = excluded.title,
                  summary = excluded.summary,
                  created_by = COALESCE(NULLIF(knowledge_conversations.created_by, ''), excluded.created_by),
                  updated_at = excluded.updated_at
                """,
                (
                    conversation["id"],
                    conversation["title"],
                    conversation["summary"],
                    conversation["createdBy"],
                    conversation["createdAt"],
                    conversation["updatedAt"],
                ),
            )
        finally:
            if owns_connection:
                self.store.pool.putconn(connection)

    def upsert_turn(self, turn: dict[str, Any], connection: Any) -> None:
        connection.execute(
            """
            INSERT INTO knowledge_turns
              (id, conversation_id, user_name, user_message, assistant_response, grounded, error, citations,
               retrieved_entry_ids, user_message_embedding, trace_events, feedback_rating, feedback_at, created_at,
               duration_ms, chat_model, embed_model)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::vector, %s::jsonb, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
              feedback_rating = excluded.feedback_rating,
              feedback_at = excluded.feedback_at
            """,
            (
                turn["id"],
                turn["conversationId"],
                turn["userName"],
                turn["userMessage"],
                turn["assistantResponse"],
                turn["grounded"],
                turn["error"],
                json.dumps(turn["citations"]),
                json.dumps(turn["retrievedEntryIds"]),
                vector_literal(turn["userMessageEmbedding"]),
                json.dumps(turn["traceEvents"]),
                turn["feedbackRating"],
                turn["feedbackAt"],
                turn["createdAt"],
                turn["durationMs"],
                turn["chatModel"],
                turn["embedModel"],
            ),
        )

    def entries_for_snapshot(self) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT id, category, question, answer, link, source_doc, source_page, source_chunk_ids,
                       question_source, sort_order, embedding IS NOT NULL AS has_embedding, created_at
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                LIMIT 1000
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "category": row["category"],
                "question": row["question"],
                "answer": row["answer"],
                "answerPreview": row["answer"][:320],
                "link": row["link"],
                "sourceDoc": row["source_doc"],
                "sourcePage": row["source_page"],
                "sourceChunkIds": row["source_chunk_ids"] or [],
                "questionSource": row["question_source"],
                "sortOrder": row["sort_order"],
                "hasEmbedding": row["has_embedding"],
                "createdAt": row["created_at"].isoformat(),
            }
            for row in rows
        ]

    def entries_for_backup(self) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT id, category, question, answer, link, source_doc, source_page, source_chunk_ids, question_source,
                       sort_order, embedding::text AS embedding, created_at
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "category": row["category"],
                "question": row["question"],
                "answer": row["answer"],
                "link": row["link"],
                "sourceDoc": row["source_doc"],
                "sourcePage": row["source_page"],
                "sourceChunkIds": row["source_chunk_ids"] or [],
                "questionSource": row["question_source"],
                "sortOrder": row["sort_order"],
                "embedding": normalize_embedding(row["embedding"]),
                "createdAt": row["created_at"].isoformat(),
            }
            for row in rows
        ]

    def uploads(self, limit: int = 20) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM knowledge_uploads ORDER BY uploaded_at DESC LIMIT %s",
                (max(1, limit),),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "fileName": row["file_name"],
                "fileType": row["file_type"],
                "rowCount": row["row_count"],
                "chunkCount": row["chunk_count"],
                "uploadedBy": row["uploaded_by"],
                "uploadedAt": row["uploaded_at"].isoformat(),
            }
            for row in rows
        ]

    def source_chunks_for_backup(self) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_source_chunks
                ORDER BY upload_id ASC, chunk_index ASC
                """
            ).fetchall()
        return [
            {
                "id": row["id"],
                "uploadId": row["upload_id"],
                "sourceDoc": row["source_doc"],
                "sourceType": row["source_type"],
                "chunkIndex": row["chunk_index"],
                "locator": row["locator"],
                "heading": row["heading"],
                "sourcePage": row["source_page"],
                "content": row["content"],
                "charStart": row["char_start"],
                "charEnd": row["char_end"],
                "createdAt": row["created_at"].isoformat(),
            }
            for row in rows
        ]

    def conversations(self) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute("SELECT * FROM knowledge_conversations ORDER BY updated_at DESC LIMIT 100").fetchall()
        return [self.conversation_from_row(row) for row in rows]

    def conversation_from_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "title": row["title"],
            "summary": row["summary"],
            "createdBy": row["created_by"],
            "createdAt": row["created_at"].isoformat(),
            "updatedAt": row["updated_at"].isoformat(),
        }

    def active_conversation(self, requested_conversation_id: str = "") -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            row = None
            if requested_conversation_id:
                row = connection.execute(
                    "SELECT * FROM knowledge_conversations WHERE id = %s LIMIT 1",
                    (requested_conversation_id,),
                ).fetchone()
            if not row:
                row = connection.execute("SELECT * FROM knowledge_conversations ORDER BY updated_at DESC LIMIT 1").fetchone()
        if row:
            return self.conversation_from_row(row)
        return normalize_knowledge_conversation({"id": "default", "title": "Knowledge chat"})

    def turns(self, conversation_id: str, limit: int = 30) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_turns
                WHERE conversation_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (conversation_id, limit),
            ).fetchall()
        return [self.turn_from_row(row) for row in rows]

    def turns_for_backup(self) -> list[dict[str, Any]]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_turns
                ORDER BY created_at DESC
                LIMIT 500
                """
            ).fetchall()
        return [self.turn_from_row(row) for row in rows]

    def turn_from_row(self, row: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": row["id"],
            "conversationId": row["conversation_id"],
            "userName": row["user_name"],
            "userMessage": row["user_message"],
            "assistantResponse": row["assistant_response"],
            "grounded": row["grounded"],
            "error": row["error"],
            "citations": row["citations"],
            "retrievedEntryIds": row["retrieved_entry_ids"],
            "traceEvents": row["trace_events"],
            "feedbackRating": row["feedback_rating"],
            "feedbackAt": row["feedback_at"].isoformat() if row["feedback_at"] else "",
            "createdAt": row["created_at"].isoformat(),
            "durationMs": row["duration_ms"],
            "chatModel": row["chat_model"],
            "embedModel": row["embed_model"],
        }

    def snapshot(self, conversation_id: str = "") -> dict[str, Any]:
        conversation = self.active_conversation(conversation_id)
        conversations = self.conversations()
        return {
            "entries": self.entries_for_snapshot(),
            "uploads": self.uploads(),
            "conversations": conversations if conversations else [conversation],
            "activeConversationId": conversation["id"],
            "turns": self.turns(conversation["id"], 30),
            "models": model_names(self.settings),
        }

    def backup_snapshot(self) -> dict[str, Any]:
        return {
            "entries": self.entries_for_backup(),
            "uploads": self.uploads(10000),
            "sourceChunks": self.source_chunks_for_backup(),
            "conversations": self.conversations(),
            "turns": self.turns_for_backup(),
            "models": model_names(self.settings),
        }

    def create_conversation(self, payload: dict[str, Any], user_name: str = "") -> dict[str, Any]:
        conversation = normalize_knowledge_conversation(
            {"id": new_id(), "title": clean_text(payload.get("title"), "New chat", 120), "createdBy": user_name}
        )
        self.upsert_conversation(conversation)
        return {"conversation": conversation}

    def update_conversation(self, payload: dict[str, Any], user_name: str = "") -> dict[str, Any]:
        conversation_id = clean_text(payload.get("conversationId"), "", 80)
        title = clean_text(payload.get("title"), "", 120)
        if not conversation_id or not title:
            raise bad_request("Choose a conversation and enter a title.")
        conversation = self.active_conversation(conversation_id)
        if conversation["id"] != conversation_id:
            raise bad_request("Conversation not found.")
        conversation = {**conversation, "title": title, "createdBy": conversation["createdBy"] or user_name, "updatedAt": now_iso()}
        self.upsert_conversation(conversation)
        return {"conversation": conversation}

    def clear_conversation(self, payload: dict[str, Any]) -> dict[str, bool]:
        conversation_id = clean_text(payload.get("conversationId"), "", 80)
        if not conversation_id:
            raise bad_request("Choose a conversation to clear.")
        with self.store.pool.connection() as connection:
            with connection.transaction():
                connection.execute("DELETE FROM knowledge_turns WHERE conversation_id = %s", (conversation_id,))
                connection.execute(
                    "UPDATE knowledge_conversations SET summary = '', updated_at = now() WHERE id = %s",
                    (conversation_id,),
                )
        return {"ok": True}

    def delete_conversation(self, payload: dict[str, Any]) -> dict[str, Any]:
        conversation_id = clean_text(payload.get("conversationId"), "", 80)
        if not conversation_id:
            raise bad_request("Choose a conversation to delete.")
        with self.store.pool.connection() as connection:
            connection.execute("DELETE FROM knowledge_conversations WHERE id = %s", (conversation_id,))
        conversations = self.conversations()
        return {"ok": True, "activeConversationId": conversations[0]["id"] if conversations else ""}

    def rate_turn(self, payload: dict[str, Any], user_name: str = "") -> dict[str, Any]:
        trace_id = clean_text(payload.get("traceId") or payload.get("id"), "", 80)
        rating = max(-1, min(1, int(payload.get("rating") or 0)))
        if not trace_id:
            raise bad_request("Choose a Knowledge Expert answer to rate.")
        with self.store.pool.connection() as connection:
            row = connection.execute("SELECT * FROM knowledge_turns WHERE id = %s LIMIT 1", (trace_id,)).fetchone()
            if not row:
                raise bad_request("Knowledge Expert answer not found.")
            if row["user_name"] and user_name and row["user_name"] != user_name:
                raise bad_request("You can only rate your own Knowledge Expert answers.")
            connection.execute(
                "UPDATE knowledge_turns SET feedback_rating = %s, feedback_at = now() WHERE id = %s",
                (rating, trace_id),
            )
            updated = connection.execute("SELECT * FROM knowledge_turns WHERE id = %s LIMIT 1", (trace_id,)).fetchone()
        return {"turn": self.turn_from_row(updated)}

    def conversations_report(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_turns
                ORDER BY created_at DESC
                LIMIT 200
                """
            ).fetchall()
        turns = [self.turn_from_row(row) for row in rows]
        return {
            "turns": turns,
            "totals": {
                "turns": self.turn_count(),
                "grounded": sum(1 for turn in turns if turn.get("grounded")),
                "declined": sum(1 for turn in turns if not turn.get("grounded") and not turn.get("error")),
                "errors": sum(1 for turn in turns if turn.get("error")),
            },
        }

    def errors_report(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_turns
                WHERE COALESCE(error, '') <> ''
                   OR trace_events @> '[{"type":"error"}]'::jsonb
                ORDER BY created_at DESC
                LIMIT 200
                """
            ).fetchall()
        return {"turns": [self.turn_from_row(row) for row in rows]}

    def dead_entries_report(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            entry_rows = connection.execute(
                """
                SELECT id, category, question, answer, link, source_doc, source_page, source_chunk_ids,
                       question_source, sort_order, created_at
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                LIMIT 1000
                """
            ).fetchall()
            turn_rows = connection.execute("SELECT citations, retrieved_entry_ids FROM knowledge_turns").fetchall()
        retrieved = {entry_id for row in turn_rows for entry_id in (row["retrieved_entry_ids"] or [])}
        cited = {citation.get("id") for row in turn_rows for citation in (row["citations"] or []) if isinstance(citation, dict)}
        entries = []
        for row in entry_rows:
            entry = {
                "id": row["id"],
                "category": row["category"],
                "question": row["question"],
                "answerPreview": row["answer"][:280],
                "link": row["link"],
                "sourceDoc": row["source_doc"],
                "sourcePage": row["source_page"],
                "sourceChunkIds": row["source_chunk_ids"] or [],
                "questionSource": row["question_source"],
                "sortOrder": row["sort_order"],
                "createdAt": row["created_at"].isoformat(),
                "retrieved": row["id"] in retrieved,
                "cited": row["id"] in cited,
            }
            if not entry["retrieved"] or not entry["cited"]:
                entries.append(entry)
        return {"entries": entries}

    def source_coverage_report(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            chunk_rows = connection.execute(
                """
                SELECT id, upload_id, source_doc, source_type, chunk_index, locator, heading, source_page,
                       content, char_start, char_end, created_at
                FROM knowledge_source_chunks
                ORDER BY source_doc ASC, chunk_index ASC
                """
            ).fetchall()
            entry_rows = connection.execute(
                """
                SELECT id, category, question, answer, source_doc, source_chunk_ids, question_source
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                """
            ).fetchall()
            upload_rows = connection.execute(
                """
                SELECT id, file_name, file_type, row_count, chunk_count, uploaded_at
                FROM knowledge_uploads
                ORDER BY uploaded_at DESC
                """
            ).fetchall()
        return build_source_coverage_report(
            [dict(row) for row in chunk_rows],
            [dict(row) for row in entry_rows],
            [dict(row) for row in upload_rows],
        )

    def knowledge_map(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            upload_rows = connection.execute(
                """
                SELECT id, file_name, file_type, row_count, chunk_count, uploaded_at
                FROM knowledge_uploads
                ORDER BY uploaded_at DESC
                """
            ).fetchall()
            chunk_rows = connection.execute(
                """
                SELECT id, upload_id, source_doc, source_type, chunk_index, locator, heading, source_page, content
                FROM knowledge_source_chunks
                ORDER BY upload_id ASC, chunk_index ASC
                """
            ).fetchall()
            entry_rows = connection.execute(
                """
                SELECT id, category, question, answer, source_doc, source_page, source_chunk_ids,
                       question_source, sort_order
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                """
            ).fetchall()
            turn_rows = connection.execute("SELECT citations, retrieved_entry_ids FROM knowledge_turns").fetchall()
        return build_knowledge_map_graph(
            [dict(row) for row in upload_rows],
            [dict(row) for row in chunk_rows],
            [dict(row) for row in entry_rows],
            [dict(row) for row in turn_rows],
        )

    def gaps_report(self) -> dict[str, Any]:
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT *
                FROM knowledge_turns
                WHERE grounded = false
                  AND COALESCE(error, '') = ''
                  AND COALESCE(user_message, '') <> ''
                ORDER BY created_at DESC
                LIMIT 300
                """
            ).fetchall()
        declined_turns = [self.turn_from_row(row) for row in rows]
        clusters: list[dict[str, Any]] = []
        for turn in declined_turns:
            tokens = set(meaningful_tokens(turn["userMessage"]))
            best_cluster = None
            best_score = 0.0
            for cluster in clusters:
                score = jaccard_similarity(tokens, cluster["tokens"])
                if score > best_score:
                    best_score = score
                    best_cluster = cluster
            if best_cluster and best_score >= 0.35:
                best_cluster["turns"].append(turn)
                best_cluster["tokens"].update(tokens)
            else:
                clusters.append({"id": new_id(), "tokens": tokens, "turns": [turn]})
        return {
            "clusters": sorted(
                [
                    {
                        "id": cluster["id"],
                        "memberCount": len(cluster["turns"]),
                        "centroidQuestion": cluster["turns"][0]["userMessage"],
                        "examples": cluster["turns"][:5],
                    }
                    for cluster in clusters
                ],
                key=lambda cluster: cluster["memberCount"],
                reverse=True,
            )
        }

    def retrieve_by_vector(self, embedding: list[float], top_k: int = KNOWLEDGE_EXPERT_TOP_K) -> list[dict[str, Any]]:
        literal = vector_literal(embedding)
        if not literal:
            return []
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT id, category, question, answer, link, source_doc, source_page, 1 - (embedding <=> %s::vector) AS score
                FROM knowledge_entries
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (literal, literal, top_k),
            ).fetchall()
        return [dict(row) for row in rows]

    def retrieve_by_keywords(self, query: str, top_k: int = KNOWLEDGE_EXPERT_TOP_K) -> list[dict[str, Any]]:
        tokens = meaningful_tokens(query)[:8]
        if not tokens:
            return []
        with self.store.pool.connection() as connection:
            rows = connection.execute(
                """
                SELECT id, category, question, answer, link, source_doc, source_page, sort_order
                FROM knowledge_entries
                ORDER BY sort_order ASC, created_at ASC
                LIMIT 1000
                """
            ).fetchall()
        scored = []
        for row in rows:
            entry = dict(row)
            score = keyword_score(entry, tokens)
            if score > 0:
                scored.append({**entry, "score": score})
        scored.sort(key=lambda entry: (-entry["score"], entry["sort_order"]))
        return scored[:top_k]

    def entry_total(self) -> int:
        with self.store.pool.connection() as connection:
            return connection.execute("SELECT COUNT(*) AS count FROM knowledge_entries").fetchone()["count"]

    def retrieve_entries(self, query: str, query_embedding: list[float] | None, top_k: int) -> dict[str, Any]:
        vector_hits = self.retrieve_by_vector(query_embedding or [], top_k) if query_embedding else []
        keyword_hits = self.retrieve_by_keywords(query, top_k)
        seen = set()
        merged = []
        for entry in [*vector_hits, *keyword_hits]:
            if entry["id"] not in seen:
                seen.add(entry["id"])
                merged.append(entry)
        return {
            "entries": merged[: max(top_k, KNOWLEDGE_EXPERT_TOP_K)],
            "vectorHits": len(vector_hits),
            "keywordHits": len(keyword_hits),
        }

    def citation_for_entry(self, entry: dict[str, Any] | None) -> dict[str, Any] | None:
        if not entry:
            return None
        return {
            "id": entry["id"],
            "label": entry["question"],
            "category": entry["category"],
            "link": entry["link"],
            "sourceDoc": entry["source_doc"],
            "sourcePage": entry["source_page"],
        }

    def persist_turn(
        self,
        *,
        started_at: float,
        conversation_id: str,
        user_name: str,
        user_message: str,
        assistant_response: str,
        grounded: bool,
        citations: list[dict[str, Any]],
        retrieved_entry_ids: list[str],
        trace_events: list[dict[str, Any]],
        user_message_embedding: list[float] | None = None,
        error: str = "",
    ) -> dict[str, Any]:
        now = now_iso()
        conversation = self.active_conversation(conversation_id)
        if conversation["id"] != conversation_id:
            conversation = normalize_knowledge_conversation(
                {
                    "id": conversation_id,
                    "title": conversation_title(user_message),
                    "createdBy": user_name,
                    "createdAt": now,
                    "updatedAt": now,
                }
            )
        should_retitle = not conversation["title"] or conversation["title"] in {"New chat", "Knowledge chat"}
        conversation = {
            **conversation,
            "title": conversation_title(user_message) if should_retitle else conversation["title"],
            "updatedAt": now,
        }
        duration_ms = int((time.time() - started_at) * 1000)
        final_trace = [
            *trace_events,
            {
                "seq": len(trace_events) + 1,
                "type": "done",
                "summary": "Knowledge Expert turn completed.",
                "tsMsOffset": duration_ms,
                "metadata": {},
            },
        ]
        turn = normalize_knowledge_turn(
            {
                "id": new_id(),
                "conversationId": conversation_id,
                "userName": user_name,
                "userMessage": user_message,
                "assistantResponse": assistant_response,
                "grounded": grounded,
                "error": error,
                "citations": citations,
                "retrievedEntryIds": retrieved_entry_ids,
                "userMessageEmbedding": user_message_embedding,
                "traceEvents": final_trace,
                "createdAt": now,
                "durationMs": max(0, duration_ms),
                "chatModel": model_names(self.settings)["chat"],
                "embedModel": model_names(self.settings)["embed"],
            },
            conversation_id,
        )
        with self.store.pool.connection() as connection:
            with connection.transaction():
                self.upsert_conversation(conversation, connection)
                self.upsert_turn(turn, connection)
        return turn

    def chat(
        self,
        payload: dict[str, Any],
        user_name: str = "",
        on_trace: Any | None = None,
        on_text_delta: Any | None = None,
    ) -> dict[str, Any]:
        started_at = time.time()
        trace: list[dict[str, Any]] = []

        def add_trace(event_type: str, summary: str, metadata: dict[str, Any] | None = None) -> None:
            event = {
                "seq": len(trace) + 1,
                "type": event_type,
                "summary": summary,
                "tsMsOffset": int((time.time() - started_at) * 1000),
                "metadata": metadata or {},
            }
            trace.append(event)
            if on_trace:
                on_trace(event)

        user_message = clean_text(payload.get("message"), "", 4000)
        if not user_message:
            raise bad_request("Ask a question first.")
        conversation = self.active_conversation(clean_text(payload.get("conversationId"), "", 80))

        if self.entry_total() == 0:
            add_trace("empty_kb", "No knowledge entries are available.")
            return self.persist_turn(
                started_at=started_at,
                conversation_id=conversation["id"],
                user_name=user_name,
                user_message=user_message,
                assistant_response=KNOWLEDGE_EXPERT_DECLINE,
                grounded=False,
                citations=[],
                retrieved_entry_ids=[],
                trace_events=trace,
            )

        add_trace("embed_query", "Prepared search query.")
        query_embedding = embed_texts([user_message], self.settings)[0]
        top_k = infer_top_k(user_message)
        retrieval = self.retrieve_entries(user_message, query_embedding, top_k)
        retrieved_entries = retrieval["entries"]
        add_trace(
            "retrieve_kb",
            f"Retrieved {len(retrieved_entries)} entries.",
            {"topK": top_k, "vectorHits": retrieval["vectorHits"], "keywordHits": retrieval["keywordHits"]},
        )

        if not retrieved_entries:
            add_trace("decline", "No matching entries found.")
            return self.persist_turn(
                started_at=started_at,
                conversation_id=conversation["id"],
                user_name=user_name,
                user_message=user_message,
                assistant_response=KNOWLEDGE_EXPERT_DECLINE,
                grounded=False,
                citations=[],
                retrieved_entry_ids=[],
                trace_events=trace,
                user_message_embedding=query_embedding,
            )

        if not self.settings.anthropic_api_key:
            raise bad_request("ANTHROPIC_API_KEY is required to answer Knowledge Expert questions.")

        context = "\n\n".join(format_context_entry(entry) for entry in retrieved_entries)
        system = " ".join(
            [
                "You are Knowledge Expert, a citation-enforced Q&A assistant.",
                "Use only the provided knowledge base entries.",
                f"If the entries do not answer the question, reply exactly: {KNOWLEDGE_EXPERT_DECLINE}",
                "Every grounded answer must end with one trailing citation block like [cite:uuid1,uuid2].",
                "Only cite IDs that appear in the provided entries.",
            ]
        )
        user = f"KNOWLEDGE BASE ENTRIES:\n\n{context}\n\nUSER QUESTION:\n{user_message}"
        add_trace("llm_call", "Asked Claude to answer from retrieved entries.")
        raw_answer = fetch_anthropic_message(system, user, self.settings)
        allowed_ids = {entry["id"] for entry in retrieved_entries}
        parsed = parse_citations(raw_answer, allowed_ids)
        grounded = bool(parsed["citations"]) and KNOWLEDGE_EXPERT_DECLINE not in parsed["text"]
        assistant_response = parsed["text"] if grounded else KNOWLEDGE_EXPERT_DECLINE
        entry_by_id = {entry["id"]: entry for entry in retrieved_entries}
        citations = [self.citation_for_entry(entry_by_id.get(entry_id)) for entry_id in parsed["citations"]]
        citations = [citation for citation in citations if citation]
        add_trace("parse_citations", f"Validated {len(citations)} citation(s)." if grounded else "No valid citation found.")

        if on_text_delta:
            for chunk in chunks(assistant_response, 80):
                on_text_delta(chunk)

        return self.persist_turn(
            started_at=started_at,
            conversation_id=conversation["id"],
            user_name=user_name,
            user_message=user_message,
            assistant_response=assistant_response,
            grounded=grounded,
            citations=citations,
            retrieved_entry_ids=[entry["id"] for entry in retrieved_entries],
            trace_events=trace,
            user_message_embedding=query_embedding,
        )


def payload_files(payload: dict[str, Any]) -> list[dict[str, Any]]:
    files = payload.get("files") if isinstance(payload.get("files"), list) and payload.get("files") else None
    files = files or [{"fileName": payload.get("fileName"), "base64": payload.get("base64"), "text": payload.get("text")}]
    if not files or len(files) > 20:
        raise bad_request("Choose between 1 and 20 knowledge-base files.")
    return files


def file_type(file_name: str) -> str:
    extension = Path(str(file_name or "")).suffix.lower()
    if extension == ".csv":
        return "csv"
    if extension in {".html", ".htm"}:
        return "html"
    if extension == ".json":
        return "json"
    if extension in {".md", ".markdown"}:
        return "markdown"
    if extension == ".pdf":
        return "pdf"
    if extension == ".docx":
        return "docx"
    return "text"


def payload_bytes(file_payload: dict[str, Any]) -> bytes:
    compact_base64 = re.sub(r"^data:[^,]+,", "", str(file_payload.get("base64") or "").strip())
    if not compact_base64:
        raise bad_request("Choose a knowledge-base file first.")
    try:
        return base64.b64decode(compact_base64, validate=True)
    except Exception as exc:
        raise bad_request("Could not decode the knowledge-base file.") from exc


def payload_text(file_payload: dict[str, Any]) -> str:
    if isinstance(file_payload.get("text"), str):
        return file_payload["text"]
    try:
        return payload_bytes(file_payload).decode("utf-8")
    except Exception as exc:
        raise bad_request("Could not decode the knowledge-base file as UTF-8 text.") from exc


def parse_knowledge_file(file_payload: dict[str, Any]) -> dict[str, Any]:
    file_name = clean_text(file_payload.get("fileName"), "knowledge-base.txt", 300)
    kind = file_type(file_name)
    if kind == "pdf":
        parsed = parse_pdf_document(payload_bytes(file_payload), file_name)
    elif kind == "docx":
        parsed = parse_docx_document(payload_bytes(file_payload), file_name)
    else:
        parsed = parse_document(payload_text(file_payload), file_name, kind)
    return {"fileName": file_name, "fileType": kind, **parsed}


def parse_entries(raw_text: str, file_name: str, kind: str) -> list[dict[str, Any]]:
    return parse_document(raw_text, file_name, kind)["entries"]


def parse_document(raw_text: str, file_name: str, kind: str) -> dict[str, list[dict[str, Any]]]:
    text = str(raw_text or "").strip()
    if not text:
        raise bad_request("The knowledge base file is empty.")
    if kind == "csv":
        entries, source_chunks = parse_csv_document(text, file_name)
    elif kind == "json":
        entries, source_chunks = parse_json_document(text, file_name)
    elif kind == "html":
        entries, source_chunks = parse_text_document(strip_html(text), file_name, "html")
    else:
        entries, source_chunks = parse_text_document(text, file_name, kind)
    return finalize_parsed_document(entries, source_chunks, file_name)


def finalize_parsed_document(
    entries: list[dict[str, Any]],
    source_chunks: list[dict[str, Any]],
    file_name: str,
) -> dict[str, list[dict[str, Any]]]:
    normalized = [
        normalize_knowledge_entry({**entry, "sortOrder": index + 1, "sourceDoc": entry.get("sourceDoc") or file_name})
        for index, entry in enumerate(entries)
    ]
    valid = [entry for entry in normalized if entry["question"] and entry["answer"]]
    if not valid:
        raise bad_request("No usable knowledge entries were found.")
    return {
        "entries": valid[:1000],
        "sourceChunks": [normalize_knowledge_source_chunk(chunk) for chunk in source_chunks[:5000]],
    }


def parse_pdf_document(pdf_bytes: bytes, file_name: str) -> dict[str, list[dict[str, Any]]]:
    if not pdf_bytes[:1024].lstrip().startswith(b"%PDF-"):
        raise bad_request("Choose a valid PDF file.")
    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
    except Exception as exc:
        raise bad_request("Could not read the PDF file.") from exc
    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                raise bad_request("Password-protected PDF files are not supported.")
        except Exception as exc:
            if getattr(exc, "status_code", None):
                raise
            raise bad_request("Password-protected PDF files are not supported.") from exc
    entries = []
    source_chunks = []
    for page_number, page in enumerate(reader.pages, start=1):
        try:
            page_text = str(page.extract_text() or "").strip()
        except Exception as exc:
            raise bad_request(f"Could not extract text from PDF page {page_number}.") from exc
        if not page_text:
            continue
        page_entries, page_chunks = parse_text_document(
            page_text,
            file_name,
            "pdf",
            source_page=page_number,
            locator_prefix=f"page {page_number} block",
            starting_chunk_index=len(source_chunks),
        )
        entries.extend(page_entries)
        source_chunks.extend(page_chunks)
    if not source_chunks:
        raise bad_request("No extractable text was found in the PDF. Scanned PDFs need OCR before upload.")
    return finalize_parsed_document(entries, source_chunks, file_name)


DOCX_WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
DOCX_RELATIONSHIP_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DOCX_NAMESPACES = {"w": DOCX_WORD_NAMESPACE, "r": DOCX_RELATIONSHIP_NAMESPACE}


def docx_tag(name: str) -> str:
    return f"{{{DOCX_WORD_NAMESPACE}}}{name}"


def docx_text(element: ElementTree.Element) -> str:
    parts = []
    for node in element.iter():
        if node.tag == docx_tag("t"):
            parts.append(node.text or "")
        elif node.tag == docx_tag("tab"):
            parts.append("\t")
        elif node.tag in {docx_tag("br"), docx_tag("cr")}:
            parts.append("\n")
    return re.sub(r"[ \t]+\n", "\n", "".join(parts)).strip()


def docx_paragraph_style(paragraph: ElementTree.Element) -> str:
    style = paragraph.find("./w:pPr/w:pStyle", DOCX_NAMESPACES)
    return str(style.get(docx_tag("val")) or "") if style is not None else ""


def is_docx_heading(style: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]+", "", str(style or "").lower())
    return normalized == "title" or normalized.startswith("heading")


def docx_table_cell_text(cell: ElementTree.Element) -> str:
    paragraphs = [
        docx_text(paragraph)
        for paragraph in cell.findall(".//w:p", DOCX_NAMESPACES)
    ]
    return "\n".join(paragraph for paragraph in paragraphs if paragraph)


def parse_docx_document(docx_bytes: bytes, file_name: str) -> dict[str, list[dict[str, Any]]]:
    try:
        with zipfile.ZipFile(io.BytesIO(docx_bytes)) as archive:
            document_xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile) as exc:
        raise bad_request("Choose a valid DOCX file.") from exc
    try:
        root = ElementTree.fromstring(document_xml)
    except ElementTree.ParseError as exc:
        raise bad_request("Could not parse the DOCX document structure.") from exc
    body = root.find("w:body", DOCX_NAMESPACES)
    if body is None:
        raise bad_request("The DOCX file does not contain a document body.")

    blocks = []
    current_heading = "General"
    paragraph_number = 0
    table_number = 0
    for child in body:
        if child.tag == docx_tag("p"):
            paragraph_number += 1
            text = docx_text(child)
            if not text:
                continue
            style = docx_paragraph_style(child)
            if is_docx_heading(style):
                current_heading = text
                continue
            blocks.append(
                {
                    "text": text,
                    "heading": current_heading,
                    "sourceType": "docx-paragraph",
                    "locator": f"paragraph {paragraph_number}",
                }
            )
        elif child.tag == docx_tag("tbl"):
            table_number += 1
            for row_number, row in enumerate(child.findall("./w:tr", DOCX_NAMESPACES), start=1):
                cells = [docx_table_cell_text(cell) for cell in row.findall("./w:tc", DOCX_NAMESPACES)]
                text = " | ".join(cell for cell in cells if cell)
                if text:
                    blocks.append(
                        {
                            "text": text,
                            "heading": current_heading,
                            "sourceType": "docx-table-row",
                            "locator": f"table {table_number} row {row_number}",
                        }
                    )
    blocks = combine_docx_qa_blocks(blocks)
    entries = []
    source_chunks = []
    for block in blocks:
        chunk, entry = source_chunk_and_entry(
            block["text"],
            file_name,
            block["heading"],
            block["sourceType"],
            len(source_chunks) + 1,
            block["locator"],
        )
        source_chunks.append(chunk)
        entries.append(entry)
    if not source_chunks:
        raise bad_request("No extractable text was found in the DOCX file.")
    return finalize_parsed_document(entries, source_chunks, file_name)


def combine_docx_qa_blocks(blocks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    combined = []
    index = 0
    while index < len(blocks):
        block = blocks[index]
        next_block = blocks[index + 1] if index + 1 < len(blocks) else None
        if (
            next_block
            and block["sourceType"] == "docx-paragraph"
            and next_block["sourceType"] == "docx-paragraph"
            and block["heading"] == next_block["heading"]
            and re.match(r"^q(?:uestion)?[:.)]\s*", block["text"], flags=re.I)
            and re.match(r"^a(?:nswer)?[:.)]\s*", next_block["text"], flags=re.I)
        ):
            combined.append(
                {
                    **block,
                    "text": f"{block['text']}\n{next_block['text']}",
                    "locator": f"{block['locator']} + {next_block['locator']}",
                }
            )
            index += 2
            continue
        combined.append(block)
        index += 1
    return combined


def parse_csv_document(text: str, file_name: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows = list(csv.reader(StringIO(text)))
    if len(rows) < 2:
        raise bad_request("CSV needs a header row and at least one data row.")
    headers = [str(header or "").strip().lower() for header in rows[0]]

    def find_header(*aliases: str) -> int:
        for alias in aliases:
            if alias in headers:
                return headers.index(alias)
        return -1

    category_index = find_header("category", "cat")
    question_index = find_header("question", "q")
    answer_index = find_header("answer", "a", "text")
    link_index = find_header("link", "url", "resource")
    if question_index == -1:
        raise bad_request("CSV needs a question column.")
    entries = []
    source_chunks = []
    for row_index, row in enumerate(rows[1:], start=2):
        chunk_id = new_id()
        row_content = {
            (headers[index] or f"column_{index + 1}"): value
            for index, value in enumerate(row)
        }
        source_chunks.append(
            {
                "id": chunk_id,
                "sourceDoc": file_name,
                "sourceType": "csv-row",
                "chunkIndex": row_index - 1,
                "locator": f"row {row_index}",
                "heading": row[category_index] if category_index >= 0 and category_index < len(row) else "",
                "content": json.dumps(row_content, ensure_ascii=True),
            }
        )
        entries.append({
            "category": row[category_index] if category_index >= 0 and category_index < len(row) else "General",
            "question": row[question_index] if question_index < len(row) else "",
            "answer": row[answer_index] if answer_index >= 0 and answer_index < len(row) else "",
            "link": row[link_index] if link_index >= 0 and link_index < len(row) else "",
            "sourceDoc": file_name,
            "sourceChunkIds": [chunk_id],
            "questionSource": "original",
        })
    return entries, source_chunks


def parse_csv_entries(text: str, file_name: str) -> list[dict[str, Any]]:
    return parse_csv_document(text, file_name)[0]


def parse_json_document(text: str, file_name: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise bad_request("JSON knowledge files must contain valid JSON.") from exc
    rows = parsed if isinstance(parsed, list) else parsed.get("entries", []) if isinstance(parsed, dict) else []
    if not rows:
        raise bad_request("JSON must be an array or an object with an entries array.")
    entries = []
    source_chunks = []
    locator_prefix = "" if isinstance(parsed, list) else "entries"
    for row_index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        chunk_id = new_id()
        locator = f"{locator_prefix}[{row_index}]" if locator_prefix else f"[{row_index}]"
        source_chunks.append(
            {
                "id": chunk_id,
                "sourceDoc": file_name,
                "sourceType": "json-entry",
                "chunkIndex": row_index + 1,
                "locator": locator,
                "heading": row.get("category") or "",
                "content": json.dumps(row, ensure_ascii=True, sort_keys=True),
            }
        )
        entries.append({
            "category": row.get("category") or "General",
            "question": row.get("question") or row.get("q") or row.get("title") or "",
            "answer": row.get("answer") or row.get("a") or row.get("text") or "",
            "link": row.get("link") or row.get("url") or "",
            "sourceDoc": file_name,
            "sourceChunkIds": [chunk_id],
            "questionSource": "original" if row.get("question") or row.get("q") else "heuristic",
        })
    return entries, source_chunks


def parse_json_entries(text: str, file_name: str) -> list[dict[str, Any]]:
    return parse_json_document(text, file_name)[0]


def strip_html(text: str) -> str:
    stripped = re.sub(r"<script[\s\S]*?</script>", " ", text, flags=re.I)
    stripped = re.sub(r"<style[\s\S]*?</style>", " ", stripped, flags=re.I)
    stripped = re.sub(r"<(h[1-4])[^>]*>", "\n\n## ", stripped, flags=re.I)
    stripped = re.sub(r"</h[1-4]>", "\n\n", stripped, flags=re.I)
    stripped = re.sub(r"<br\s*/?>", "\n", stripped, flags=re.I)
    stripped = re.sub(r"</(p|li|tr|div|section|article)>", "\n\n", stripped, flags=re.I)
    stripped = re.sub(r"<[^>]+>", " ", stripped)
    return html.unescape(stripped)


def parse_text_document(
    text: str,
    file_name: str,
    source_type: str = "text",
    source_page: int | str | None = None,
    locator_prefix: str = "block",
    starting_chunk_index: int = 0,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    normalized_text = text.replace("\r\n", "\n")
    entries = []
    source_chunks = []
    current_heading = "General"
    for match in re.finditer(r"\S(?:[\s\S]*?\S)?(?=\n{2,}|$)", normalized_text):
        raw_block = match.group(0)
        block = raw_block.strip()
        if not block:
            continue
        heading = re.sub(r"^#+\s*", "", block).strip()
        if block.startswith("#") or (len(block) <= 120 and not re.search(r"[.!?]", block) and ":" not in block):
            current_heading = heading or current_heading
            continue
        char_start = match.start() + len(raw_block) - len(raw_block.lstrip())
        char_end = char_start + len(block)
        chunk_index = starting_chunk_index + len(source_chunks) + 1
        chunk, entry = source_chunk_and_entry(
            block,
            file_name,
            current_heading,
            f"{source_type}-block",
            chunk_index,
            f"{locator_prefix} {len(source_chunks) + 1}",
            source_page=source_page,
            char_start=char_start,
            char_end=char_end,
        )
        source_chunks.append(chunk)
        entries.append(entry)
    return entries, source_chunks


def source_chunk_and_entry(
    block: str,
    file_name: str,
    heading: str,
    source_type: str,
    chunk_index: int,
    locator: str,
    *,
    source_page: int | str | None = None,
    char_start: int | None = None,
    char_end: int | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    chunk_id = new_id()
    chunk = {
        "id": chunk_id,
        "sourceDoc": file_name,
        "sourceType": source_type,
        "chunkIndex": chunk_index,
        "locator": locator,
        "heading": heading,
        "sourcePage": source_page,
        "content": block,
        "charStart": char_start,
        "charEnd": char_end,
    }
    qa_match = re.match(
        r"^(?:q(?:uestion)?[:.)]\s*)([\s\S]*?)(?:\n|$)(?:a(?:nswer)?[:.)]\s*)([\s\S]*)$",
        block,
        flags=re.I,
    )
    if qa_match:
        question = qa_match.group(1).strip()
        answer = qa_match.group(2).strip()
        question_source = "extracted"
    else:
        lines = block.split("\n")
        first_line = lines[0]
        question = first_line if first_line.endswith("?") or len(first_line) <= 140 else first_sentence(first_line)
        answer = "\n".join(lines[1:]).strip() if len(lines) > 1 else block
        question_source = "heuristic"
    entry = {
        "category": heading,
        "question": question,
        "answer": answer,
        "sourceDoc": file_name,
        "sourcePage": source_page,
        "sourceChunkIds": [chunk_id],
        "questionSource": question_source,
    }
    return chunk, entry


def parse_text_entries(text: str, file_name: str) -> list[dict[str, Any]]:
    return parse_text_document(text, file_name)[0]


def first_sentence(text: str) -> str:
    match = re.match(r"^(.{20,180}?[.!?])\s", str(text or ""))
    return (match.group(1) if match else str(text or "")[:140]).strip()


def embedding_text(entry: dict[str, Any]) -> str:
    return f"{entry.get('category', '')}\n{entry.get('question', '')}\n{entry.get('answer', '')}"


def embed_texts(texts: list[str], settings: Settings) -> list[list[float] | None]:
    if not settings.openai_api_key:
        return [None for _ in texts]
    request = urllib.request.Request(
        "https://api.openai.com/v1/embeddings",
        method="POST",
        headers={"Authorization": f"Bearer {settings.openai_api_key}", "Content-Type": "application/json"},
        data=json.dumps({"model": model_names(settings)["embed"], "input": [text[:12000] for text in texts]}).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise bad_request(f"Could not create embeddings: {exc}") from exc
    by_index = {item["index"]: item.get("embedding") for item in payload.get("data", [])}
    return [normalize_embedding(by_index.get(index)) for index in range(len(texts))]


def meaningful_tokens(text: str) -> list[str]:
    stopwords = {"the", "and", "for", "with", "that", "this", "what", "how", "are", "can", "you", "about", "from", "into", "all"}
    return [
        token
        for token in re.split(r"[^a-z0-9]+", str(text or "").lower())
        if len(token) >= 3 and token not in stopwords
    ]


def token_coverage(source_text: str, compared_text: str) -> dict[str, Any]:
    source_tokens = set(meaningful_tokens(source_text))
    compared_tokens = set(meaningful_tokens(compared_text))
    covered_tokens = source_tokens & compared_tokens
    ratio = len(covered_tokens) / len(source_tokens) if source_tokens else 1.0
    return {
        "ratio": ratio,
        "sourceTokenCount": len(source_tokens),
        "coveredTokenCount": len(covered_tokens),
        "uncoveredTokens": sorted(source_tokens - covered_tokens)[:20],
    }


def percentage(value: float) -> float:
    return round(max(0.0, min(1.0, value)) * 100, 1)


def build_source_coverage_report(
    chunks: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    uploads: list[dict[str, Any]],
) -> dict[str, Any]:
    entries_by_chunk: dict[str, list[dict[str, Any]]] = {}
    traceable_entries = []
    untraceable_entries = []
    for entry in entries:
        chunk_ids = entry.get("source_chunk_ids") or entry.get("sourceChunkIds") or []
        if not isinstance(chunk_ids, list) or not chunk_ids:
            untraceable_entries.append(entry)
            continue
        traceable_entries.append(entry)
        for chunk_id in chunk_ids:
            entries_by_chunk.setdefault(str(chunk_id), []).append(entry)

    analyzed_chunks = []
    total_source_tokens = 0
    total_covered_tokens = 0
    linked_chunks = 0
    for chunk in chunks:
        chunk_entries = entries_by_chunk.get(str(chunk.get("id")), [])
        compared_text = "\n".join(
            f"{entry.get('question', '')}\n{entry.get('answer', '')}"
            for entry in chunk_entries
        )
        coverage = token_coverage(str(chunk.get("content") or ""), compared_text)
        total_source_tokens += coverage["sourceTokenCount"]
        total_covered_tokens += coverage["coveredTokenCount"]
        if chunk_entries:
            linked_chunks += 1
        ratio = coverage["ratio"] if chunk_entries else 0.0
        status = (
            "uncovered"
            if not chunk_entries
            else "covered"
            if ratio >= KNOWLEDGE_COVERAGE_GOOD_THRESHOLD
            else "low"
            if ratio < KNOWLEDGE_COVERAGE_LOW_THRESHOLD
            else "partial"
        )
        analyzed_chunks.append(
            {
                "id": chunk.get("id"),
                "uploadId": chunk.get("upload_id") or chunk.get("uploadId") or "",
                "sourceDoc": chunk.get("source_doc") or chunk.get("sourceDoc") or "",
                "sourceType": chunk.get("source_type") or chunk.get("sourceType") or "",
                "chunkIndex": chunk.get("chunk_index") or chunk.get("chunkIndex") or 0,
                "locator": chunk.get("locator") or "",
                "heading": chunk.get("heading") or "",
                "contentPreview": clean_text(chunk.get("content"), "", 320),
                "entryCount": len(chunk_entries),
                "entryIds": [entry.get("id") for entry in chunk_entries],
                "coveragePercent": percentage(ratio),
                "sourceTokenCount": coverage["sourceTokenCount"],
                "coveredTokenCount": coverage["coveredTokenCount"],
                "status": status,
                "uncoveredTokens": coverage["uncoveredTokens"],
            }
        )

    answer_source_tokens = 0
    answer_supported_tokens = 0
    low_support_entries = []
    chunks_by_id = {str(chunk.get("id")): chunk for chunk in chunks}
    for entry in traceable_entries:
        chunk_ids = entry.get("source_chunk_ids") or entry.get("sourceChunkIds") or []
        source_text = "\n".join(
            str(chunks_by_id.get(str(chunk_id), {}).get("content") or "")
            for chunk_id in chunk_ids
        )
        support = token_coverage(str(entry.get("answer") or ""), source_text)
        answer_source_tokens += support["sourceTokenCount"]
        answer_supported_tokens += support["coveredTokenCount"]
        if support["ratio"] < KNOWLEDGE_COVERAGE_LOW_THRESHOLD:
            low_support_entries.append(
                {
                    "id": entry.get("id"),
                    "sourceDoc": entry.get("source_doc") or entry.get("sourceDoc") or "",
                    "question": entry.get("question") or "",
                    "answerPreview": clean_text(entry.get("answer"), "", 280),
                    "supportPercent": percentage(support["ratio"]),
                    "unsupportedTokens": support["uncoveredTokens"],
                }
            )

    issues = sorted(
        [chunk for chunk in analyzed_chunks if chunk["status"] != "covered"],
        key=lambda chunk: (
            {"uncovered": 0, "low": 1, "partial": 2}.get(chunk["status"], 3),
            chunk["sourceDoc"],
            chunk["chunkIndex"],
        ),
    )
    upload_by_id = {str(upload.get("id")): upload for upload in uploads}
    documents = []
    for upload_id in dict.fromkeys(str(chunk.get("uploadId") or "") for chunk in analyzed_chunks):
        document_chunks = [chunk for chunk in analyzed_chunks if str(chunk.get("uploadId") or "") == upload_id]
        upload = upload_by_id.get(upload_id, {})
        document_tokens = sum(chunk["sourceTokenCount"] for chunk in document_chunks)
        covered_document_tokens = sum(chunk["coveredTokenCount"] for chunk in document_chunks)
        documents.append(
            {
                "uploadId": upload_id,
                "fileName": upload.get("file_name") or upload.get("fileName") or document_chunks[0]["sourceDoc"],
                "fileType": upload.get("file_type") or upload.get("fileType") or "",
                "chunkCount": len(document_chunks),
                "linkedChunkCount": sum(1 for chunk in document_chunks if chunk["entryCount"]),
                "coveredChunkCount": sum(1 for chunk in document_chunks if chunk["status"] == "covered"),
                "coveragePercent": percentage(covered_document_tokens / document_tokens) if document_tokens else 100.0,
            }
        )

    total_chunks = len(analyzed_chunks)
    covered_chunks = sum(1 for chunk in analyzed_chunks if chunk["status"] == "covered")
    return {
        "totals": {
            "chunks": total_chunks,
            "linkedChunks": linked_chunks,
            "coveredChunks": covered_chunks,
            "uncoveredChunks": sum(1 for chunk in analyzed_chunks if chunk["status"] == "uncovered"),
            "partialChunks": sum(1 for chunk in analyzed_chunks if chunk["status"] in {"partial", "low"}),
            "traceabilityPercent": percentage(linked_chunks / total_chunks) if total_chunks else 0.0,
            "lexicalCoveragePercent": percentage(total_covered_tokens / total_source_tokens) if total_source_tokens else 0.0,
            "answerSupportPercent": percentage(answer_supported_tokens / answer_source_tokens) if answer_source_tokens else 0.0,
            "entries": len(entries),
            "traceableEntries": len(traceable_entries),
            "untraceableEntries": len(untraceable_entries),
        },
        "documents": documents,
        "issues": issues[:200],
        "lowSupportEntries": low_support_entries[:100],
        "limitations": [
            "Lexical coverage measures shared normalized words, not semantic equivalence.",
            "Answer support can flag wording absent from the source, but it does not prove a contradiction.",
            "Legacy entries uploaded before source traceability are counted as untraceable.",
        ],
    }


def build_knowledge_map_graph(
    uploads: list[dict[str, Any]],
    chunks: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    turns: list[dict[str, Any]],
    max_nodes: int = 900,
) -> dict[str, Any]:
    coverage = build_source_coverage_report(chunks, entries, uploads)
    entries_by_chunk: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        for chunk_id in entry.get("source_chunk_ids") or entry.get("sourceChunkIds") or []:
            entries_by_chunk.setdefault(str(chunk_id), []).append(entry)
    retrieved_counts: dict[str, int] = {}
    cited_counts: dict[str, int] = {}
    for turn in turns:
        for entry_id in turn.get("retrieved_entry_ids") or turn.get("retrievedEntryIds") or []:
            key = str(entry_id)
            retrieved_counts[key] = retrieved_counts.get(key, 0) + 1
        for citation in turn.get("citations") or []:
            if isinstance(citation, dict) and citation.get("id"):
                key = str(citation["id"])
                cited_counts[key] = cited_counts.get(key, 0) + 1

    selected_uploads = uploads[:max_nodes]
    selected_upload_ids = {str(upload.get("id")) for upload in selected_uploads}
    upload_nodes = [
        {
            "id": f"document:{upload['id']}",
            "entityId": str(upload["id"]),
            "type": "document",
            "label": upload.get("file_name") or upload.get("fileName") or "Knowledge document",
            "fileType": upload.get("file_type") or upload.get("fileType") or "",
            "entryCount": upload.get("row_count") or upload.get("rowCount") or 0,
            "chunkCount": upload.get("chunk_count") or upload.get("chunkCount") or 0,
        }
        for upload in selected_uploads
    ]
    available_slots = max(0, max_nodes - len(upload_nodes))
    chunk_slots = min(len(chunks), max(0, round(available_slots * 0.55)))
    selected_chunks = [
        chunk
        for chunk in chunks
        if str(chunk.get("upload_id") or chunk.get("uploadId") or "") in selected_upload_ids
    ][:chunk_slots]
    available_slots -= len(selected_chunks)
    selected_chunk_ids = {str(chunk.get("id")) for chunk in selected_chunks}
    selected_entries = [
        entry
        for entry in entries
        if any(
            str(chunk_id) in selected_chunk_ids
            for chunk_id in (entry.get("source_chunk_ids") or entry.get("sourceChunkIds") or [])
        )
    ][:available_slots]
    selected_entry_ids = {str(entry.get("id")) for entry in selected_entries}

    chunk_nodes = []
    for chunk in selected_chunks:
        chunk_id = str(chunk.get("id"))
        chunk_entries = entries_by_chunk.get(chunk_id, [])
        compared_text = "\n".join(
            f"{entry.get('question', '')}\n{entry.get('answer', '')}"
            for entry in chunk_entries
        )
        chunk_coverage = token_coverage(str(chunk.get("content") or ""), compared_text)
        ratio = chunk_coverage["ratio"] if chunk_entries else 0.0
        coverage_status = (
            "uncovered"
            if not chunk_entries
            else "covered"
            if ratio >= KNOWLEDGE_COVERAGE_GOOD_THRESHOLD
            else "low"
            if ratio < KNOWLEDGE_COVERAGE_LOW_THRESHOLD
            else "partial"
        )
        chunk_nodes.append(
            {
                "id": f"chunk:{chunk_id}",
                "entityId": chunk_id,
                "type": "chunk",
                "label": chunk.get("heading") or chunk.get("locator") or f"Chunk {chunk.get('chunk_index') or ''}",
                "sourceDoc": chunk.get("source_doc") or chunk.get("sourceDoc") or "",
                "sourceType": chunk.get("source_type") or chunk.get("sourceType") or "",
                "locator": chunk.get("locator") or "",
                "sourcePage": chunk.get("source_page") or chunk.get("sourcePage"),
                "preview": clean_text(chunk.get("content"), "", 360),
                "coverageStatus": coverage_status,
                "coveragePercent": percentage(ratio),
                "uploadId": str(chunk.get("upload_id") or chunk.get("uploadId") or ""),
            }
        )

    entry_nodes = []
    for entry in selected_entries:
        entry_id = str(entry.get("id"))
        entry_nodes.append(
            {
                "id": f"entry:{entry_id}",
                "entityId": entry_id,
                "type": "entry",
                "label": entry.get("question") or "Knowledge entry",
                "category": entry.get("category") or "General",
                "answerPreview": clean_text(entry.get("answer"), "", 360),
                "sourceDoc": entry.get("source_doc") or entry.get("sourceDoc") or "",
                "sourcePage": entry.get("source_page") or entry.get("sourcePage"),
                "questionSource": entry.get("question_source") or entry.get("questionSource") or "",
                "retrievedCount": retrieved_counts.get(entry_id, 0),
                "citedCount": cited_counts.get(entry_id, 0),
            }
        )

    edges = []
    for chunk in selected_chunks:
        chunk_id = str(chunk.get("id"))
        upload_id = str(chunk.get("upload_id") or chunk.get("uploadId") or "")
        edges.append(
            {
                "id": f"document:{upload_id}->chunk:{chunk_id}",
                "source": f"document:{upload_id}",
                "target": f"chunk:{chunk_id}",
                "type": "contains",
            }
        )
    for entry in selected_entries:
        entry_id = str(entry.get("id"))
        for chunk_id in entry.get("source_chunk_ids") or entry.get("sourceChunkIds") or []:
            chunk_id = str(chunk_id)
            if chunk_id in selected_chunk_ids and entry_id in selected_entry_ids:
                edges.append(
                    {
                        "id": f"chunk:{chunk_id}->entry:{entry_id}",
                        "source": f"chunk:{chunk_id}",
                        "target": f"entry:{entry_id}",
                        "type": "supports",
                    }
                )

    nodes = [*upload_nodes, *chunk_nodes, *entry_nodes]
    return {
        "nodes": nodes,
        "edges": edges,
        "totals": {
            "documents": len(uploads),
            "chunks": len(chunks),
            "entries": len(entries),
            "retrievals": sum(retrieved_counts.values()),
            "citations": sum(cited_counts.values()),
            "displayedNodes": len(nodes),
        },
        "truncated": len(nodes) < len(uploads) + len(chunks) + len(entries),
        "coverage": coverage["totals"],
    }


def keyword_score(entry: dict[str, Any], tokens: list[str]) -> int:
    haystack = f"{entry.get('category', '')} {entry.get('question', '')} {entry.get('answer', '')}".lower()
    return sum(1 for token in tokens if token in haystack)


def jaccard_similarity(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def infer_top_k(query: str) -> int:
    text = str(query or "").lower()
    number_match = re.search(r"\b(?:list|show|give me|tell me)?\s*(\d{1,2})\b", text)
    requested = int(number_match.group(1)) + 3 if number_match else 0
    enumerative = bool(re.search(r"\b(how many|what are|list of|tell me all|give me all|all|list|every|each|many)\b", text))
    return min(25, max(KNOWLEDGE_EXPERT_TOP_K, requested, KNOWLEDGE_EXPERT_ENUMERATIVE_TOP_K if enumerative else 0))


def conversation_title(message: str) -> str:
    text = re.sub(r"\s+", " ", clean_text(message, "New chat", 90)).strip()
    return text if len(text) <= 46 else f"{text[:43].strip()}..."


def format_context_entry(entry: dict[str, Any]) -> str:
    return "\n".join(
        item
        for item in [
            f"ID: {entry['id']}",
            f"Category: {entry['category']}",
            f"Question: {entry['question']}",
            f"Answer: {entry['answer']}",
            f"Link: {entry['link']}" if entry.get("link") else "",
            f"Source: {entry['source_doc']}{' page ' + str(entry['source_page']) if entry.get('source_page') else ''}"
            if entry.get("source_doc")
            else "",
        ]
        if item
    )


def parse_citations(answer: str, allowed_ids: set[str]) -> dict[str, Any]:
    cite_match = re.search(r"\[cite:\s*([0-9a-fA-F,\-\s]+)\]\s*$", str(answer or ""))
    text = re.sub(r"\s*\[cite:\s*([0-9a-fA-F,\-\s]+)\]\s*$", "", str(answer or "")).strip()
    citations = []
    if cite_match:
        citations = [entry_id.strip() for entry_id in cite_match.group(1).split(",") if entry_id.strip() in allowed_ids]
    return {"text": text, "citations": list(dict.fromkeys(citations))}


def fetch_anthropic_message(system: str, user: str, settings: Settings, max_tokens: int = 1600) -> str:
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        method="POST",
        headers={
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": settings.anthropic_api_key or "",
        },
        data=json.dumps(
            {
                "model": model_names(settings)["chat"],
                "max_tokens": max_tokens,
                "temperature": 0,
                "system": system,
                "messages": [{"role": "user", "content": user}],
            }
        ).encode("utf-8"),
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as exc:
        raise bad_request(f"Could not answer with Knowledge Expert: {exc}") from exc
    text = extract_anthropic_text(payload).strip()
    if not text:
        raise bad_request("Anthropic returned an empty Knowledge Expert response.")
    return text


def extract_anthropic_text(payload: dict[str, Any]) -> str:
    content = payload.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        part.get("text", "")
        for part in content
        if isinstance(part, dict) and (part.get("type") == "text" or isinstance(part.get("text"), str))
    )


def chunks(text: str, size: int) -> list[str]:
    return [text[index : index + size] for index in range(0, len(text), size)] or [""]
