from __future__ import annotations

import re
from typing import Any

from .catalog import DEFAULT_TOOL_CATALOG_CONFIG, HOSTED_TOOLS
from .utils import bad_request, clean_bounded_number, clean_date, clean_positive_integer, clean_text, new_id, now_iso

NOTELOG_PAGE_WIDTH = 1414
NOTELOG_PAGE_HEIGHT = 1000


def unique_catalog_id(value: Any, seen_ids: set[str]) -> str:
    base_id = re.sub(r"[^\w-]+", "-", str(value or "group").lower()).strip("-")[:60] or "group"
    candidate = base_id
    suffix = 2
    while candidate in seen_ids:
        candidate = f"{base_id}-{suffix}"
        suffix += 1
    seen_ids.add(candidate)
    return candidate


def normalize_tool_groups(groups: Any) -> list[dict[str, Any]]:
    source = groups if isinstance(groups, list) and groups else DEFAULT_TOOL_CATALOG_CONFIG["groups"]
    seen_ids: set[str] = set()
    normalized = []
    for index, raw_group in enumerate(source[:20]):
        group = raw_group if isinstance(raw_group, dict) else {}
        normalized.append(
            {
                "id": unique_catalog_id(group.get("id") or group.get("name") or f"group-{index + 1}", seen_ids),
                "name": clean_text(group.get("name"), f"Group {index + 1}", 80),
                "displayOrder": clean_positive_integer(group.get("displayOrder"), index + 1),
            }
        )
    return normalized


def normalize_tool_catalog_config(config: Any, strict: bool = False) -> dict[str, Any]:
    config = config if isinstance(config, dict) else {}
    groups = normalize_tool_groups(config.get("groups"))
    group_ids = {group["id"] for group in groups}
    default_group_id = groups[0]["id"]
    raw_tools = config.get("tools") if isinstance(config.get("tools"), list) else []
    tool_by_id = {str(tool.get("id", "")): tool for tool in raw_tools if isinstance(tool, dict)}

    tools = []
    for index, hosted_tool in enumerate(HOSTED_TOOLS):
        fallback = next(
            (tool for tool in DEFAULT_TOOL_CATALOG_CONFIG["tools"] if tool["id"] == hosted_tool["id"]),
            {},
        )
        tool = tool_by_id.get(hosted_tool["id"], fallback)
        group_id = str(tool.get("groupId") or fallback.get("groupId") or default_group_id)
        if strict and group_id not in group_ids:
            raise bad_request(f"{hosted_tool['title']} must belong to an existing group")
        tools.append(
            {
                "id": hosted_tool["id"],
                "groupId": group_id if group_id in group_ids else default_group_id,
                "displayOrder": clean_positive_integer(tool.get("displayOrder"), index + 1),
                "enabled": tool.get("enabled") is not False,
            }
        )

    return {"groups": groups, "tools": tools}


def sorted_tool_catalog(catalog: dict[str, Any]) -> list[dict[str, Any]]:
    catalog = normalize_tool_catalog_config(catalog)
    groups_by_id = {group["id"]: group for group in catalog["groups"]}
    tool_config_by_id = {tool["id"]: tool for tool in catalog["tools"]}
    tools = []
    for hosted_tool in HOSTED_TOOLS:
        config = tool_config_by_id.get(hosted_tool["id"], {})
        if config.get("enabled") is False:
            continue
        group = groups_by_id.get(config.get("groupId")) or catalog["groups"][0]
        tools.append({**hosted_tool, **config, "groupName": group["name"], "groupDisplayOrder": group["displayOrder"]})
    return sorted(tools, key=lambda tool: (tool["groupDisplayOrder"], tool["displayOrder"], tool["title"]))


def admin_tool_catalog(catalog: dict[str, Any]) -> dict[str, Any]:
    catalog = normalize_tool_catalog_config(catalog)
    tool_config_by_id = {tool["id"]: tool for tool in catalog["tools"]}
    return {
        "groups": catalog["groups"],
        "tools": [{**tool, **tool_config_by_id.get(tool["id"], {})} for tool in HOSTED_TOOLS],
    }


def clean_padelog_set_score(value: Any) -> str:
    score = re.sub(r"\s+", "", str(value or "").strip())
    if not re.match(r"^\d+-\d+$", score):
        raise bad_request("Sets must be a set score such as 1-0, 2-1, 1-1, or 2-2")
    return score[:12]


def normalize_padelog_match(raw_match: Any) -> dict[str, Any]:
    raw_match = raw_match if isinstance(raw_match, dict) else {}
    result_input = clean_text(raw_match.get("result") or raw_match.get("Result"), "", 12).lower()
    result = result_input[:1].upper() + result_input[1:] if result_input else ""
    if result not in {"Won", "Lost", "Draw"}:
        raise bad_request("Result must be Won, Lost, or Draw")
    return {
        "id": clean_text(raw_match.get("id"), new_id(), 80),
        "club": clean_text(raw_match.get("club") or raw_match.get("padelClub") or raw_match.get("Padel Club"), "Padel Club", 120),
        "date": clean_date(raw_match.get("date") or raw_match.get("Date")),
        "teammate": clean_text(
            raw_match.get("teammate") or raw_match.get("teamate") or raw_match.get("Teamate") or raw_match.get("Teammate"),
            "Teammate",
            120,
        ),
        "opponents": clean_text(raw_match.get("opponents") or raw_match.get("Opponents"), "Opponents", 200),
        "result": result,
        "sets": clean_padelog_set_score(raw_match.get("sets") or raw_match.get("Sets")),
        "createdAt": clean_text(raw_match.get("createdAt"), now_iso(), 40),
    }


def sort_padelog_matches(matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(matches, key=lambda match: (match.get("date", ""), match.get("createdAt", "")), reverse=True)


def clean_betlog_time(value: Any) -> str:
    match = re.match(r"^(\d{1,2}):(\d{2})(?::\d{2})?$", str(value or "").strip())
    if not match:
        raise bad_request("Bet time must use HH:MM")
    hour = int(match.group(1))
    minute = int(match.group(2))
    if hour > 23 or minute > 59:
        raise bad_request("Bet time is not valid")
    return f"{hour:02d}:{minute:02d}"


def clean_money(value: Any, fallback: Any = None) -> float:
    raw_text = "" if value is None else str(value).strip()
    raw_value = fallback if raw_text == "" and fallback is not None else value
    try:
        number = float(str(raw_value if raw_value is not None else "").strip().replace(",", "."))
    except ValueError as exc:
        raise bad_request("Stake and return amount must be non-negative numbers") from exc
    if number < 0:
        raise bad_request("Stake and return amount must be non-negative numbers")
    return round(number, 2)


def clean_positive_decimal(value: Any, message: str) -> float:
    try:
        number = float(str(value if value is not None else "").strip().replace(",", "."))
    except ValueError as exc:
        raise bad_request(message) from exc
    if number <= 0:
        raise bad_request(message)
    return round(number, 4)


def clean_boolean(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value if value is not None else "").strip().lower() in {"true", "1", "yes", "y", "free", "ναι"}


def normalize_betlog_bet(raw_bet: Any) -> dict[str, Any]:
    raw_bet = raw_bet if isinstance(raw_bet, dict) else {}
    return {
        "id": clean_text(raw_bet.get("id"), new_id(), 80),
        "date": clean_date(raw_bet.get("date") or raw_bet.get("Date")),
        "time": clean_betlog_time(raw_bet.get("time") or raw_bet.get("Time")),
        "betId": clean_text(raw_bet.get("bet_id") or raw_bet.get("betId") or raw_bet.get("Bet ID"), "Bet ID", 80),
        "betType": clean_text(raw_bet.get("bet_type") or raw_bet.get("betType") or raw_bet.get("Bet Type"), "Single", 80),
        "stake": clean_money(first_present(raw_bet, "stake", "Stake")),
        "freeBet": clean_boolean(first_present(raw_bet, "free_bet", "freeBet", "Free Bet")),
        "status": clean_text(raw_bet.get("status") or raw_bet.get("Status"), "Open", 80),
        "returnAmount": clean_money(
            first_present(raw_bet, "return_amount", "returnAmount", "Return", "Return Amount"),
            0,
        ),
        "selection": clean_text(raw_bet.get("selection") or raw_bet.get("Selection"), "Selection", 200),
        "odds": clean_positive_decimal(first_present(raw_bet, "odds", "Odds"), "Odds must be a positive number"),
        "market": clean_text(raw_bet.get("market") or raw_bet.get("Market"), "Market", 180),
        "match": clean_text(raw_bet.get("match") or raw_bet.get("Match"), "Match", 220),
        "score": clean_text(first_present(raw_bet, "score", "Score"), "", 80),
        "outcomeType": clean_text(
            raw_bet.get("outcome_type") or raw_bet.get("outcomeType") or raw_bet.get("Outcome Type"),
            "single",
            80,
        ),
        "legs": clean_positive_integer(first_present(raw_bet, "legs", "Legs"), 1),
        "createdAt": clean_text(raw_bet.get("createdAt"), now_iso(), 40),
    }


def first_present(source: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in source:
            return source[key]
    return None


def sort_betlog_bets(bets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(bets, key=lambda bet: (bet.get("date", ""), bet.get("time", ""), bet.get("createdAt", "")), reverse=True)


def default_notelog_page() -> dict[str, Any]:
    return {"id": new_id(), "width": NOTELOG_PAGE_WIDTH, "height": NOTELOG_PAGE_HEIGHT, "background": "grid", "strokes": []}


def safe_hex_color(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    return text if re.match(r"^#[0-9a-fA-F]{6}$", text) else fallback


def normalize_notelog_point(raw_point: Any, scale_x: float = 1, scale_y: float = 1) -> dict[str, Any]:
    raw_point = raw_point if isinstance(raw_point, dict) else {}
    x = clean_bounded_number(raw_point.get("x"), 0, -10000, 10000) * scale_x
    y = clean_bounded_number(raw_point.get("y"), 0, -10000, 10000) * scale_y
    return {
        "x": clean_bounded_number(x, 0, -10000, 10000),
        "y": clean_bounded_number(y, 0, -10000, 10000),
        "pressure": clean_bounded_number(raw_point.get("pressure"), 0.5, 0, 1),
    }


def normalize_notelog_stroke(raw_stroke: Any, scale_x: float = 1, scale_y: float = 1) -> dict[str, Any]:
    raw_stroke = raw_stroke if isinstance(raw_stroke, dict) else {}
    points = raw_stroke.get("points") if isinstance(raw_stroke.get("points"), list) else []
    return {
        "tool": "eraser" if raw_stroke.get("tool") == "eraser" else "pen",
        "color": safe_hex_color(raw_stroke.get("color"), "#111827"),
        "size": clean_bounded_number(raw_stroke.get("size"), 4, 1, 80),
        "points": [normalize_notelog_point(point, scale_x, scale_y) for point in points[:3000]],
    }


def normalize_notelog_page(raw_page: Any) -> dict[str, Any]:
    raw_page = raw_page if isinstance(raw_page, dict) else {}
    raw_width = clean_bounded_number(raw_page.get("width"), NOTELOG_PAGE_WIDTH, 300, 3000)
    raw_height = clean_bounded_number(raw_page.get("height"), NOTELOG_PAGE_HEIGHT, 300, 5000)
    is_portrait = raw_height > raw_width
    width = NOTELOG_PAGE_WIDTH if is_portrait else raw_width
    height = NOTELOG_PAGE_HEIGHT if is_portrait else raw_height
    scale_x = width / raw_width
    scale_y = height / raw_height
    background = raw_page.get("background") if raw_page.get("background") in {"blank", "ruled", "grid", "dots", "cornell", "meeting"} else "grid"
    strokes = raw_page.get("strokes") if isinstance(raw_page.get("strokes"), list) else []
    return {
        "id": clean_text(raw_page.get("id"), new_id(), 80),
        "width": width,
        "height": height,
        "background": background,
        "strokes": [normalize_notelog_stroke(stroke, scale_x, scale_y) for stroke in strokes[:15000]],
    }


def normalize_notelog_note(raw_note: Any) -> dict[str, Any]:
    raw_note = raw_note if isinstance(raw_note, dict) else {}
    created_at = clean_text(raw_note.get("createdAt"), now_iso(), 40)
    pages = raw_note.get("pages") if isinstance(raw_note.get("pages"), list) and raw_note.get("pages") else [default_notelog_page()]
    return {
        "id": clean_text(raw_note.get("id"), new_id(), 80),
        "title": clean_text(raw_note.get("title"), "Untitled note", 120),
        "createdAt": created_at,
        "updatedAt": clean_text(raw_note.get("updatedAt"), created_at, 40),
        "pages": [normalize_notelog_page(page) for page in pages[:120]],
        "exportedFileName": clean_text(raw_note.get("exportedFileName"), "", 180),
        "exportedAt": clean_text(raw_note.get("exportedAt"), "", 40),
    }


def sort_notelog_notes(notes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(notes, key=lambda note: note.get("updatedAt", ""), reverse=True)
