import base64
import copy
import json
from contextlib import nullcontext

import pytest
from fastapi import HTTPException

from optimus_api.sticky_notes import StickyNotes, STORE_KEY, normalize_note
from optimus_api.tools import create_backup_archive, read_backup_archive


class MemoryStore:
    """Exercise document behavior without reading the user's database."""
    def __init__(self):
        self.value = None
        self.pool = self
        self.statements = []

    def get(self, key, fallback):
        return copy.deepcopy(self.value) if self.value is not None else fallback

    def connection(self):
        return nullcontext(self)

    def transaction(self):
        return nullcontext()

    def execute(self, sql, params=None):
        self.statements.append(sql)
        if sql.startswith("INSERT"):
            assert params[0] == STORE_KEY
            self.value = json.loads(params[1])
        return self

    def fetchone(self):
        return {"value": copy.deepcopy(self.value)} if self.value is not None else None


@pytest.fixture
def service(tmp_path):
    return StickyNotes(MemoryStore(), tmp_path / ".sticky-notes.key")


def test_roundtrip_encryption_and_nonce(service):
    assert service.list() == []
    assert not service.key_path.exists()
    note = service.update({"text": "Private Ελληνικά\nsecond line", "color": "blue", "size": "large"})["note"]
    first = copy.deepcopy(service.store.value)
    assert "Private" not in json.dumps(first)
    assert "blue" not in json.dumps(first)
    assert service.key_path.stat().st_mode & 0o777 == 0o600
    assert service.list() == [note]
    changed = service.update({**note, "text": "Updated"})["note"]
    assert first["nonce"] != service.store.value["nonce"]
    assert changed["revision"] != note["revision"]
    assert any("pg_advisory_xact_lock" in sql for sql in service.store.statements)


def test_conflicts_and_delete(service):
    note = service.update({"text": "First"})["note"]
    fresh = service.update({**note, "text": "Newer"})["note"]
    before = copy.deepcopy(service.store.value)
    for delete in (False, True):
        with pytest.raises(HTTPException) as exc:
            service.update({**note, "text": "Stale"}, delete=delete)
        assert exc.value.status_code == 409
        assert service.store.value == before
    service.update(fresh, delete=True)
    assert service.list() == []
    with pytest.raises(HTTPException) as exc:
        service.update(fresh)
    assert exc.value.status_code == 409


def test_missing_wrong_and_tampered_keys_fail_closed(service):
    service.update({"text": "Secret"})
    before = copy.deepcopy(service.store.value)
    original_key = service.key_path.read_bytes()
    service.key_path.unlink()
    with pytest.raises(HTTPException) as exc:
        service.update({"text": "Replacement"})
    assert exc.value.status_code == 503
    assert not service.key_path.exists()
    service.key_path.write_bytes(b"x" * 32)
    with pytest.raises(HTTPException):
        service.list()
    assert service.store.value == before
    service.key_path.write_bytes(original_key)
    damaged = copy.deepcopy(before)
    data = bytearray(base64.b64decode(damaged["ciphertext"]))
    data[-1] ^= 1
    damaged["ciphertext"] = base64.b64encode(data).decode()
    with pytest.raises(HTTPException):
        service.decode(damaged)


def test_encrypted_zip_restore_preserves_properties_invalidates_open_tabs(service):
    note = service.update({"text": "Backup secret", "order": 42, "size": "large", "color": "pink", "showOnHome": False})["note"]
    backup = create_backup_archive({"sticky-notes.json": service.store.value})
    assert b"Backup secret" not in base64.b64decode(backup["base64"])
    files = read_backup_archive(backup)
    service.update({**note, "text": "Later"})
    service.restore(files["sticky-notes.json"])
    restored = service.list()[0]
    assert restored == {**note, "revision": restored["revision"]}
    assert restored["revision"] != note["revision"]
    with pytest.raises(HTTPException):
        service.update(note)


@pytest.mark.parametrize("payload", [{"text": []}, {"text": "a" * 20001}, {"color": "red"}, {"color": []}, {"size": {}}, {"size": "huge"}, {"order": True}, {"order": 0.5}, {"showOnHome": "yes"}])
def test_backend_rejects_invalid_notes(payload):
    with pytest.raises(HTTPException):
        normalize_note(payload)


def test_restore_validates_notes_before_any_store_is_replaced(service, monkeypatch):
    from optimus_api import main
    service.update({"text": "Original"})
    envelope = copy.deepcopy(service.store.value)
    envelope["ciphertext"] = "AAAA"
    monkeypatch.setattr(main, "sticky_notes", service)
    store = MemoryStore()
    monkeypatch.setattr(main, "store", store)
    archive = create_backup_archive({"sticky-notes.json": envelope})
    with pytest.raises(HTTPException):
        main.post_admin_restore(archive, {})
    assert store.statements == []


def test_older_backup_preserves_existing_sticky_notes(service, monkeypatch):
    from optimus_api import main
    service.update({"text": "Keep this"})
    before = copy.deepcopy(service.store.value)
    monkeypatch.setattr(main, "sticky_notes", service)
    monkeypatch.setattr(main.store, "set", lambda *args: None)
    monkeypatch.setattr(main, "load_tool_catalog_config", lambda: {})
    for name in ("save_padelog_matches", "save_betlog_bets", "save_notelog_notes", "save_performance_insights", "save_web_audit_history"):
        monkeypatch.setattr(main, name, lambda *args: None)
    result = main.post_admin_restore(create_backup_archive({}), {})
    assert result["restored"]["stickyNotes"] == 0
    assert service.store.value == before


def test_routes_require_session():
    from fastapi.testclient import TestClient
    from optimus_api.main import app
    client = TestClient(app)
    assert client.get("/api/tools/sticky-notes/notes").status_code == 401
    for route in ("notes", "delete"):
        assert client.post(f"/api/tools/sticky-notes/{route}", json={}).status_code == 401


def test_authenticated_routes_crud_and_cache_headers(service, monkeypatch):
    from fastapi.testclient import TestClient
    from optimus_api import main
    monkeypatch.setattr(main, "sticky_notes", service)
    main.app.dependency_overrides[main.require_session] = lambda: {"name": "test"}
    try:
        client = TestClient(main.app)
        response = client.post("/api/tools/sticky-notes/notes", json={"text": "Route secret"})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        note = response.json()["note"]
        response = client.get("/api/tools/sticky-notes/notes")
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["notes"] == [note]
        response = client.post("/api/tools/sticky-notes/notes", json={**note, "text": "Updated"})
        assert response.status_code == 200
        fresh = response.json()["note"]
        assert client.post("/api/tools/sticky-notes/delete", json=note).status_code == 409
        assert client.post("/api/tools/sticky-notes/delete", json=fresh).status_code == 200
        assert client.get("/api/tools/sticky-notes/notes").json() == {"notes": []}
    finally:
        main.app.dependency_overrides.pop(main.require_session, None)
