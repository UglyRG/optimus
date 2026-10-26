import copy
import json
from contextlib import nullcontext

import pyotp
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from optimus_api.two_factor import STORE_KEY, TwoFactor


class MemoryStore:
    def __init__(self):
        self.value = None
        self.pool = self

    def connection(self):
        return nullcontext(self)

    def transaction(self):
        return nullcontext()

    def execute(self, sql, params=None):
        if sql.startswith("INSERT"):
            assert params[0] == STORE_KEY
            self.value = json.loads(params[1])
        return self

    def fetchone(self):
        return {"value": copy.deepcopy(self.value)} if self.value is not None else None


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setattr("optimus_api.two_factor.time.time", lambda: 1800000000)
    return TwoFactor(MemoryStore(), tmp_path / ".auth.key")


def enroll(service):
    setup = service.run("setup", password_ok=True, owner="session")
    result = service.run("enable", password_ok=True, owner="session", code=pyotp.TOTP(setup["secret"]).at(1800000000))
    return setup, result


def test_enrollment_encryption_replay_and_recovery(service, monkeypatch):
    assert service.run("status")["enabled"] is False
    setup, result = enroll(service)
    assert setup["qrCode"].startswith("data:image/svg+xml;base64,")
    assert setup["secret"] not in json.dumps(service.store.value)
    assert result["recoveryCodes"][0] not in json.dumps(service.store.value)
    assert service.key_path.stat().st_mode & 0o777 == 0o600
    assert service.run("login", password_ok=True) == {"requiresTwoFactor": True}
    with pytest.raises(HTTPException):
        service.run("login", password_ok=True, code=pyotp.TOTP(setup["secret"]).at(1800000000))
    monkeypatch.setattr("optimus_api.two_factor.time.time", lambda: 1800000030)
    code = pyotp.TOTP(setup["secret"]).at(1800000030)
    assert service.run("login", password_ok=True, code=code) == {"requiresTwoFactor": False}
    with pytest.raises(HTTPException):
        service.run("login", password_ok=True, code=code)
    recovery = result["recoveryCodes"][0]
    with pytest.raises(HTTPException):
        service.run("login", password_ok=False, code=recovery)
    assert service.run("login", password_ok=True, code=recovery)["requiresTwoFactor"] is False
    with pytest.raises(HTTPException):
        service.run("login", password_ok=True, code=recovery)
    assert service.run("status")["recoveryCodesRemaining"] == 9
    service.run("disable", password_ok=True, code=result["recoveryCodes"][1])
    assert not service.run("status")["enabled"]


def test_pending_setup_is_bound_to_session_and_expires(service, monkeypatch):
    setup = service.run("setup", password_ok=True, owner="session")
    code = pyotp.TOTP(setup["secret"]).at(1800000000)
    assert not service.run("status")["enabled"]
    with pytest.raises(HTTPException) as exc:
        service.run("enable", password_ok=True, owner="other", code=code)
    assert exc.value.status_code == 409
    monkeypatch.setattr("optimus_api.two_factor.time.time", lambda: 1800000601)
    with pytest.raises(HTTPException):
        service.run("enable", password_ok=True, owner="session", code=code)
    assert not service.run("status")["enabled"]


def test_rate_limit_persists_across_instances_and_expires(service, monkeypatch):
    for _ in range(10):
        with pytest.raises(HTTPException) as exc:
            service.run("login")
        assert exc.value.status_code == 401
    other_worker = TwoFactor(service.store, service.key_path)
    with pytest.raises(HTTPException) as exc:
        other_worker.run("login", password_ok=True)
    assert exc.value.status_code == 429
    monkeypatch.setattr("optimus_api.two_factor.time.time", lambda: 1800000301)
    assert other_worker.run("login", password_ok=True)["requiresTwoFactor"] is False


def test_missing_wrong_and_tampered_key_fail_closed(service):
    enroll(service)
    original = service.key_path.read_bytes()
    service.key_path.unlink()
    with pytest.raises(HTTPException) as exc:
        service.run("login", password_ok=True)
    assert exc.value.status_code == 503
    assert not service.key_path.exists()
    from cryptography.fernet import Fernet
    service.key_path.write_bytes(Fernet.generate_key())
    with pytest.raises(HTTPException):
        service.run("status")
    service.key_path.write_bytes(original)
    service.store.value["encrypted"] = "broken"
    with pytest.raises(HTTPException):
        service.run("login", password_ok=True)


def test_routes_enforce_second_factor_and_invalidate_other_sessions(service, monkeypatch):
    from optimus_api import main
    monkeypatch.setattr(main, "two_factor", service)
    monkeypatch.setattr(main, "sessions", {})
    client = TestClient(main.app)
    assert client.get("/api/auth/2fa").status_code == 401
    for action in ("setup", "enable", "disable"):
        assert client.post(f"/api/auth/2fa/{action}", json={}).status_code == 401
    credentials = {"name": "Owner", "accessKey": main.settings.optimus_access_key}
    assert client.post("/api/auth/login", json=credentials).status_code == 200
    other = TestClient(main.app)
    other.post("/api/auth/login", json=credentials)
    assert len(main.sessions) == 2
    setup = client.post("/api/auth/2fa/setup", json=credentials)
    assert setup.headers["cache-control"] == "no-store"
    secret = setup.json()["secret"]
    enabled = client.post("/api/auth/2fa/enable", json={**credentials, "code": pyotp.TOTP(secret).at(1800000000)})
    assert enabled.status_code == 200
    assert len(main.sessions) == 1
    assert other.get("/api/auth/me").status_code == 401
    challenge = other.post("/api/auth/login", json=credentials)
    assert challenge.json() == {"requiresTwoFactor": True}
    assert "set-cookie" not in challenge.headers
    assert other.get("/api/auth/me").status_code == 401
    assert other.post("/api/auth/login", json={**credentials, "code": "000000"}).status_code == 401
    recovery = enabled.json()["recoveryCodes"][0]
    assert other.post("/api/auth/login", json={**credentials, "code": recovery}).json()["user"]["name"] == "Owner"
    assert other.get("/api/auth/me").status_code == 200
