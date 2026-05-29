from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clean_text(value: Any, fallback: str, max_length: int) -> str:
    text = str(value if value is not None else "").strip()
    if not text:
        text = fallback
    return text[:max_length]


def clean_positive_integer(value: Any, fallback: int) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError):
        return fallback
    return number if number >= 1 else fallback


def clean_bounded_number(value: Any, fallback: float, min_value: float, max_value: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return min(max_value, max(min_value, round(number, 3)))


def new_id() -> str:
    return str(uuid.uuid4())


def bad_request(message: str) -> HTTPException:
    return HTTPException(status_code=400, detail=message)


def clean_date(value: Any) -> str:
    text = str(value or "").strip()
    iso_match = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", text)
    if iso_match:
        year, month, day = iso_match.groups()
        return valid_date_parts(year, month, day)

    slash_match = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2}|\d{4})$", text)
    if slash_match:
        day, month, raw_year = slash_match.groups()
        year = f"20{raw_year}" if len(raw_year) == 2 else raw_year
        return valid_date_parts(year, month, day)

    raise bad_request("Date must use YYYY-MM-DD or D/M/YY")


def valid_date_parts(year: str, month: str, day: str) -> str:
    normalized = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    try:
        parsed = datetime.strptime(normalized, "%Y-%m-%d")
    except ValueError as exc:
        raise bad_request("Date is not a valid calendar date") from exc
    if parsed.year != int(year) or parsed.month != int(month) or parsed.day != int(day):
        raise bad_request("Date is not a valid calendar date")
    return normalized
