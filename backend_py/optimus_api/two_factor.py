"""Single-installation TOTP authentication, serialized across backend workers."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import secrets
import time

import pyotp
import qrcode
import qrcode.image.svg
from cryptography.fernet import Fernet, InvalidToken
from fastapi import HTTPException

STORE_KEY = "auth_security"


class TwoFactor:
    def __init__(self, store, key_path):
        self.store = store
        self.key_path = key_path

    def cipher(self, create=False):
        try:
            key = self.key_path.read_bytes()
        except FileNotFoundError:
            if not create:
                raise HTTPException(503, "Authentication is locked: restore data/.auth.key")
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            key = Fernet.generate_key()
            try:
                fd = os.open(self.key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                return self.cipher()
            with os.fdopen(fd, "wb") as handle:
                handle.write(key)
                handle.flush()
                os.fsync(handle.fileno())
        try:
            return Fernet(key)
        except ValueError:
            raise HTTPException(503, "Invalid authentication encryption key")

    @staticmethod
    def digest(value):
        return hashlib.sha256(value.encode()).hexdigest()

    @staticmethod
    def verify(state, code, now):
        code = str(code or "").strip().replace(" ", "").replace("-", "")
        if len(code) == 6 and code.isascii() and code.isdigit():
            totp = pyotp.TOTP(state["secret"])
            step = int(now // 30)
            for counter in (step, step - 1, step + 1):
                if counter > state.get("lastStep", -1) and secrets.compare_digest(totp.at(counter * 30), code):
                    state["lastStep"] = counter
                    return True
        hashed = TwoFactor.digest(code.lower())
        for saved in state.get("recovery", []):
            if secrets.compare_digest(saved, hashed):
                state["recovery"].remove(saved)
                return True
        return False

    def run(self, action, *, password_ok=False, code="", owner="", name_ok=True):
        error = None
        result = None
        with self.store.pool.connection() as connection, connection.transaction():
            connection.execute("SELECT pg_advisory_xact_lock(731448222)")
            row = connection.execute("SELECT value FROM app_data WHERE key = %s", (STORE_KEY,)).fetchone()
            cipher = self.cipher(create=row is None)
            try:
                state = json.loads(cipher.decrypt(row["value"]["encrypted"].encode())) if row else {}
            except (InvalidToken, KeyError, ValueError, TypeError):
                raise HTTPException(503, "Cannot unlock authentication settings; restore the original data/.auth.key")
            now = time.time()
            enabled = bool(state.get("secret"))
            if action == "status":
                return {"enabled": enabled, "recoveryCodesRemaining": len(state.get("recovery", []))}
            if now - state.get("failureStart", 0) >= 300:
                state.update(failureStart=now, failures=0)
            if state.get("failures", 0) >= 10:
                raise HTTPException(429, "Too many authentication attempts. Try again in five minutes.")
            if not password_ok or not name_ok:
                error = HTTPException(401, "Invalid credentials")
            elif action == "login":
                if enabled and not code:
                    result = {"requiresTwoFactor": True}
                elif enabled and not self.verify(state, code, now):
                    error = HTTPException(401, "Invalid or already used authentication code")
                else:
                    result = {"requiresTwoFactor": False}
            elif action == "setup":
                if enabled:
                    error = HTTPException(409, "Two-factor authentication is already enabled")
                else:
                    secret = pyotp.random_base32()
                    state["pending"] = {"secret": secret, "expiresAt": now + 600, "owner": self.digest(owner)}
                    uri = pyotp.TOTP(secret).provisioning_uri(name="Owner", issuer_name="Optimus")
                    svg = io.BytesIO()
                    qrcode.make(uri, image_factory=qrcode.image.svg.SvgPathImage).save(svg)
                    result = {"secret": secret, "qrCode": "data:image/svg+xml;base64," + base64.b64encode(svg.getvalue()).decode()}
            elif action == "enable":
                pending = state.get("pending", {})
                if enabled or pending.get("expiresAt", 0) <= now or pending.get("owner") != self.digest(owner):
                    error = HTTPException(409, "Setup expired or changed. Start setup again.")
                else:
                    candidate = {"secret": pending["secret"]}
                    if not self.verify(candidate, code, now):
                        error = HTTPException(401, "Invalid authentication code")
                    else:
                        codes = [secrets.token_hex(8) for _ in range(10)]
                        state.update(candidate, recovery=[self.digest(c) for c in codes])
                        state.pop("pending", None)
                        result = {"enabled": True, "recoveryCodes": codes}
            elif action == "disable":
                if not enabled or not self.verify(state, code, now):
                    error = HTTPException(401, "Invalid or already used authentication code")
                else:
                    state = {}
                    result = {"enabled": False}
            else:
                raise ValueError("Unknown authentication operation")
            if error:
                state["failures"] = state.get("failures", 0) + 1
            elif result and not result.get("requiresTwoFactor"):
                state.update(failures=0, failureStart=now)
            envelope = {"version": 1, "encrypted": cipher.encrypt(json.dumps(state).encode()).decode()}
            connection.execute("INSERT INTO app_data (key, value) VALUES (%s, %s::jsonb) "
                               "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()",
                               (STORE_KEY, json.dumps(envelope)))
        # Raise after commit so failed-attempt counters survive the error response.
        if error:
            raise error
        return result
