from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from psycopg import OperationalError
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import Settings


class JsonStore:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.pool = ConnectionPool(settings.database_url, open=False, kwargs={"autocommit": True, "row_factory": dict_row})

    def open(self) -> None:
        self.pool.open()
        try:
            with self.pool.connection(timeout=5) as connection:
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS app_data (
                      key TEXT PRIMARY KEY,
                      value JSONB NOT NULL,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )
                    """
            )
        except OperationalError as exc:
            raise RuntimeError(
                "Could not connect to native Optimus Postgres. Confirm Postgres is running, the optimus role/database "
                f"exist, and DATABASE_URL is correct. Current DATABASE_URL: {self.settings.database_url}"
            ) from exc

    def close(self) -> None:
        self.pool.close()

    def get(self, key: str, fallback: Any, legacy_path: Path | None = None) -> Any:
        with self.pool.connection() as connection:
            row = connection.execute("SELECT value FROM app_data WHERE key = %s LIMIT 1", (key,)).fetchone()
            if row:
                return row["value"]

        if legacy_path:
            try:
                value = json.loads(legacy_path.read_text(encoding="utf-8"))
            except FileNotFoundError:
                return fallback
            self.set(key, value)
            return value
        return fallback

    def set(self, key: str, value: Any) -> None:
        with self.pool.connection() as connection:
            connection.execute(
                """
                INSERT INTO app_data (key, value, updated_at)
                VALUES (%s, %s::jsonb, now())
                ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (key, json.dumps(value)),
            )
