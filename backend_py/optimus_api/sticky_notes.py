"""Encrypted sticky-note documents with serialized writes and optimistic concurrency."""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

from .utils import now_iso

STORE_KEY = "sticky_notes"
AAD = b"optimus:sticky-notes:v1"
COLORS = {"yellow", "pink", "blue", "green", "orange"}


def normalize_note(raw: dict) -> dict:
    if not isinstance(raw, dict) or not isinstance(raw.get("text", ""), str):
        raise HTTPException(400, "Note text must be a string")
    if len(raw.get("text", "")) > 20000:
        raise HTTPException(400, "Notes support up to 20,000 characters")
    color, size = raw.get("color", "yellow"), raw.get("size", "small")
    if not isinstance(color, str) or not isinstance(size, str) or color not in COLORS or size not in {"small", "large"}:
        raise HTTPException(400, "Invalid note color or size")
    order = raw.get("order", 0)
    if isinstance(order, bool) or not isinstance(order, int) or abs(order) > 1000000:
        raise HTTPException(400, "Invalid note order")
    if not isinstance(raw.get("showOnHome", True), bool):
        raise HTTPException(400, "Invalid homepage visibility")
    return {"text": raw.get("text", ""), "color": raw.get("color", "yellow"),
            "size": raw.get("size", "small"), "showOnHome": raw.get("showOnHome", True), "order": order}


class StickyNotes:
    def __init__(self, store, key_path: Path):
        self.store = store
        self.key_path = key_path

    def key(self, create=False) -> bytes:
        try:
            key = self.key_path.read_bytes()
        except FileNotFoundError:
            if not create:
                raise HTTPException(503, "Sticky notes are locked: restore the original encryption key file")
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            key = AESGCM.generate_key(bit_length=256)
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return self.key()
            with os.fdopen(fd, "wb") as handle:
                handle.write(key)
                handle.flush()
                os.fsync(handle.fileno())
        if len(key) != 32:
            raise HTTPException(503, "Sticky notes encryption key must contain exactly 32 bytes")
        return key

    def decode(self, envelope) -> list[dict]:
        if envelope is None:
            return []
        if not isinstance(envelope, dict):
            raise HTTPException(400, "Invalid encrypted sticky notes document")
        try:
            if envelope["version"] != 1 or envelope["algorithm"] != "AES-256-GCM":
                raise ValueError()
            key = self.key()
            nonce = base64.b64decode(envelope["nonce"], validate=True)
            ciphertext = base64.b64decode(envelope["ciphertext"], validate=True)
            notes = json.loads(AESGCM(key).decrypt(nonce, ciphertext, AAD))
            if not isinstance(notes, list) or len(notes) > 500:
                raise ValueError()
            ids = set()
            for note in notes:
                normalize_note(note)
                if not all(isinstance(note.get(k), str) and note[k] for k in ("id", "revision", "createdAt", "updatedAt")):
                    raise ValueError()
                if note["id"] in ids:
                    raise ValueError()
                ids.add(note["id"])
            return notes
        except (InvalidTag, ValueError, KeyError, TypeError):
            raise HTTPException(400, "Cannot unlock sticky notes: incorrect key, damaged data, or unsupported format")

    def encode(self, notes, create=False):
        key = self.key(create=create)
        nonce = os.urandom(12)
        return {"version": 1, "algorithm": "AES-256-GCM", "keyId": hashlib.sha256(key).hexdigest()[:16],
                "nonce": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(AESGCM(key).encrypt(nonce, json.dumps(notes).encode(), AAD)).decode()}

    def list(self):
        return sorted(self.decode(self.store.get(STORE_KEY, None)), key=lambda n: (n["order"], n["createdAt"]))

    def update(self, payload, delete=False):
        with self.store.pool.connection() as connection, connection.transaction():
            # Also locks the initially absent document, across workers.
            connection.execute("SELECT pg_advisory_xact_lock(731448221)")
            row = connection.execute("SELECT value FROM app_data WHERE key = %s", (STORE_KEY,)).fetchone()
            notes = self.decode(row["value"] if row else None)
            note_id = payload.get("id")
            previous = next((n for n in notes if n["id"] == note_id), None)
            if note_id and not previous:
                raise HTTPException(409, "This note was deleted. Reload notes before editing again.")
            if previous and payload.get("revision") != previous["revision"]:
                raise HTTPException(409, "This note changed elsewhere. Copy your text, then reload notes.")
            if delete and not previous:
                raise HTTPException(400, "Choose a note to delete")
            if not previous and len(notes) >= 500:
                raise HTTPException(400, "The board supports up to 500 notes")
            result = None
            if not delete:
                result = {**normalize_note(payload), "id": previous["id"] if previous else str(uuid4()),
                          "revision": str(uuid4()), "createdAt": previous["createdAt"] if previous else now_iso(),
                          "updatedAt": now_iso()}
            notes = [n for n in notes if n["id"] != note_id]
            if result:
                notes.append(result)
            envelope = self.encode(notes, create=row is None)
            connection.execute("INSERT INTO app_data (key, value) VALUES (%s, %s::jsonb) "
                               "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()",
                               (STORE_KEY, json.dumps(envelope)))
            return {"note": result}

    def restore(self, envelope):
        notes = self.decode(envelope)
        for note in notes:
            note["revision"] = str(uuid4())
        with self.store.pool.connection() as connection, connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(731448221)")
            connection.execute("INSERT INTO app_data (key, value) VALUES (%s, %s::jsonb) "
                               "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()",
                               (STORE_KEY, json.dumps(self.encode(notes))))
