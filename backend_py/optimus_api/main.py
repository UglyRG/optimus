from __future__ import annotations

import base64
import io
import mimetypes
import os
import secrets
import subprocess
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response as FastAPIResponse, StreamingResponse

from .catalog import DEFAULT_TOOL_CATALOG_CONFIG
from .config import Settings, get_settings
from .domain import (
    admin_tool_catalog,
    normalize_betlog_bet,
    normalize_notelog_note,
    normalize_padelog_match,
    normalize_tool_catalog_config,
    sort_betlog_bets,
    sort_notelog_notes,
    sort_padelog_matches,
    sorted_tool_catalog,
)
from .knowledge import KnowledgeRepository, normalize_knowledge_store
from .store import JsonStore
from .tools import (
    analyze_betlog_performance,
    analyze_padelog_performance,
    check_token_usage,
    combine_pdf_documents,
    create_backup_archive,
    create_notelog_pdf,
    list_iframe_source_files,
    read_backup_archive,
    save_csv_json_rows,
    save_csv_qa_markdown,
    save_demo_builder_template,
    save_iframe_source,
    save_pdf_iframe_source,
    save_presentation_suite,
)
from .utils import bad_request, now_iso

DATA_STORES = {
    "toolCatalog": "tool_catalog",
    "padelogMatches": "padelog_matches",
    "betlogBets": "betlog_bets",
    "notelogNotes": "notelog_notes",
    "performanceInsights": "performance_insights",
    "knowledgeExpert": "knowledge_expert",
}

SESSION_COOKIE = "optimus_session"
sessions: dict[str, dict[str, Any]] = {}

settings = get_settings()
store = JsonStore(settings)
knowledge_repo = KnowledgeRepository(store, settings)

app = FastAPI(title="Optimus API", version="6.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)


@app.exception_handler(HTTPException)
async def http_error_handler(_: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


@app.on_event("startup")
def startup() -> None:
    store.open()
    knowledge_repo.ensure_schema()
    knowledge_repo.migrate_from_json_store()


@app.on_event("shutdown")
def shutdown() -> None:
    store.close()


def app_version() -> str:
    env_version = os.getenv("OPTIMUS_VERSION", "").strip()
    if env_version:
        return env_version
    try:
        result = subprocess.run(
            ["git", "describe", "--tags", "--always", "--dirty"],
            cwd=settings.data_dir.parent,
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
        return result.stdout.strip() or "unknown"
    except Exception:
        try:
            return (settings.data_dir.parent / "VERSION").read_text(encoding="utf-8").strip() or "unknown"
        except Exception:
            return "unknown"


def clean_expired_sessions() -> None:
    now = time.time()
    for token, session in list(sessions.items()):
        if session["expiresAt"] <= now:
            sessions.pop(token, None)


def session_cookie(response: Response, token: str, expires_at: float) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=max(0, int(expires_at - time.time())),
        path="/",
    )


def expire_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


def require_session(request: Request) -> dict[str, Any]:
    clean_expired_sessions()
    token = request.cookies.get(SESSION_COOKIE, "")
    session = sessions.get(token)
    if not session:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return {"token": token, **session}


def optional_session(request: Request) -> dict[str, Any] | None:
    clean_expired_sessions()
    token = request.cookies.get(SESSION_COOKIE, "")
    session = sessions.get(token)
    if not session:
        return None
    return {"token": token, **session}


def require_public_api_key(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
    app_settings: Settings = Depends(get_settings),
) -> None:
    token = ""
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization[7:].strip()
    token = token or (x_api_key or "").strip()
    if not token or not secrets.compare_digest(token, app_settings.public_api_key):
        raise HTTPException(status_code=401, detail="Invalid public API key")


def legacy_path(file_name: str):
    return settings.data_dir / file_name


def load_tool_catalog_config() -> dict[str, Any]:
    value = store.get(DATA_STORES["toolCatalog"], DEFAULT_TOOL_CATALOG_CONFIG, legacy_path("tool-catalog.json"))
    return normalize_tool_catalog_config(value)


def save_tool_catalog_config(payload: dict[str, Any]) -> dict[str, Any]:
    catalog = normalize_tool_catalog_config(payload, strict=True)
    store.set(DATA_STORES["toolCatalog"], catalog)
    return admin_tool_catalog(load_tool_catalog_config())


def load_padelog_matches() -> list[dict[str, Any]]:
    parsed = store.get(DATA_STORES["padelogMatches"], {"matches": []}, legacy_path("padelog-matches.json"))
    rows = parsed.get("matches") if isinstance(parsed, dict) else parsed
    rows = rows if isinstance(rows, list) else []
    return sort_padelog_matches([normalize_padelog_match(row) for row in rows])


def save_padelog_matches(matches: list[dict[str, Any]]) -> None:
    store.set(DATA_STORES["padelogMatches"], {"matches": sort_padelog_matches(matches)})


def add_padelog_matches(payload: dict[str, Any]) -> dict[str, Any]:
    incoming = payload.get("matches") if isinstance(payload.get("matches"), list) else [payload.get("match") or payload]
    if not incoming:
        raise bad_request("Add at least one match")
    existing = load_padelog_matches()
    created = [normalize_padelog_match(row) for row in incoming]
    matches = sort_padelog_matches([*created, *existing])
    save_padelog_matches(matches)
    return {"imported": len(created), "created": created, "matches": matches}


def update_padelog_match(payload: dict[str, Any]) -> dict[str, Any]:
    match_id = str(payload.get("id") or (payload.get("match") or {}).get("id") or "").strip()
    if not match_id:
        raise bad_request("Choose a match to edit")
    matches = load_padelog_matches()
    for index, match in enumerate(matches):
        if match["id"] == match_id:
            matches[index] = normalize_padelog_match({**match, **(payload.get("match") or payload), "id": match_id, "createdAt": match["createdAt"]})
            sorted_matches = sort_padelog_matches(matches)
            save_padelog_matches(sorted_matches)
            return {"matches": sorted_matches}
    raise bad_request("Match not found")


def delete_padelog_match(match_id: str) -> dict[str, Any]:
    if not match_id:
        raise bad_request("Choose a match to delete")
    matches = load_padelog_matches()
    next_matches = [match for match in matches if match["id"] != match_id]
    if len(next_matches) == len(matches):
        raise bad_request("Match not found")
    save_padelog_matches(next_matches)
    return {"matches": next_matches}


def load_betlog_bets() -> list[dict[str, Any]]:
    parsed = store.get(DATA_STORES["betlogBets"], {"bets": []}, legacy_path("betlog-bets.json"))
    rows = parsed.get("bets") if isinstance(parsed, dict) else parsed
    rows = rows if isinstance(rows, list) else []
    return sort_betlog_bets([normalize_betlog_bet(row) for row in rows])


def save_betlog_bets(bets: list[dict[str, Any]]) -> None:
    store.set(DATA_STORES["betlogBets"], {"bets": sort_betlog_bets(bets)})


def add_betlog_bets(payload: dict[str, Any]) -> dict[str, Any]:
    incoming = payload.get("bets") if isinstance(payload.get("bets"), list) else [payload.get("bet") or payload]
    if not incoming:
        raise bad_request("Add at least one bet")
    existing = load_betlog_bets()
    created = [normalize_betlog_bet(row) for row in incoming]
    bets = sort_betlog_bets([*created, *existing])
    save_betlog_bets(bets)
    return {"imported": len(created), "created": created, "bets": bets}


def update_betlog_bet(payload: dict[str, Any]) -> dict[str, Any]:
    bet_id = str(payload.get("id") or (payload.get("bet") or {}).get("id") or "").strip()
    if not bet_id:
        raise bad_request("Choose a bet to edit")
    bets = load_betlog_bets()
    for index, bet in enumerate(bets):
        if bet["id"] == bet_id:
            bets[index] = normalize_betlog_bet({**bet, **(payload.get("bet") or payload), "id": bet_id, "createdAt": bet["createdAt"]})
            sorted_bets = sort_betlog_bets(bets)
            save_betlog_bets(sorted_bets)
            return {"bets": sorted_bets}
    raise bad_request("Bet not found")


def delete_betlog_bet(bet_id: str) -> dict[str, Any]:
    if not bet_id:
        raise bad_request("Choose a bet row to delete")
    bets = load_betlog_bets()
    next_bets = [bet for bet in bets if bet["id"] != bet_id]
    if len(next_bets) == len(bets):
        raise bad_request("Bet not found")
    save_betlog_bets(next_bets)
    return {"bets": next_bets}


def load_notelog_notes() -> list[dict[str, Any]]:
    parsed = store.get(DATA_STORES["notelogNotes"], {"notes": []}, legacy_path("notelog-notes.json"))
    rows = parsed.get("notes") if isinstance(parsed, dict) else parsed
    rows = rows if isinstance(rows, list) else []
    return sort_notelog_notes([normalize_notelog_note(row) for row in rows])


def save_notelog_notes(notes: list[dict[str, Any]]) -> None:
    store.set(DATA_STORES["notelogNotes"], {"notes": sort_notelog_notes(notes)})


def upsert_notelog_note(payload: dict[str, Any]) -> dict[str, Any]:
    note = normalize_notelog_note({**(payload.get("note") or payload), "updatedAt": now_iso()})
    notes = load_notelog_notes()
    for index, existing_note in enumerate(notes):
        if existing_note["id"] == note["id"]:
            note["createdAt"] = existing_note["createdAt"]
            note["exportedFileName"] = existing_note.get("exportedFileName", "")
            note["exportedAt"] = existing_note.get("exportedAt", "")
            notes[index] = note
            break
    else:
        notes.insert(0, note)
    sorted_notes = sort_notelog_notes(notes)
    save_notelog_notes(sorted_notes)
    return {"note": note, "notes": sorted_notes}


def delete_notelog_note(note_id: str) -> dict[str, Any]:
    if not note_id:
        raise bad_request("Choose a note to delete")
    notes = load_notelog_notes()
    next_notes = [note for note in notes if note["id"] != note_id]
    if len(next_notes) == len(notes):
        raise bad_request("Note not found")
    save_notelog_notes(next_notes)
    return {"notes": next_notes}


def load_performance_insights() -> list[dict[str, Any]]:
    parsed = store.get(DATA_STORES["performanceInsights"], {"insights": []}, legacy_path("performance-insights.json"))
    rows = parsed.get("insights") if isinstance(parsed, dict) else parsed
    return rows if isinstance(rows, list) else []


def save_performance_insights(insights: list[dict[str, Any]]) -> None:
    store.set(DATA_STORES["performanceInsights"], {"insights": sorted(insights, key=lambda item: str(item.get("generatedAt", "")), reverse=True)})


def save_performance_insight(insight: dict[str, Any]) -> dict[str, Any]:
    insights = load_performance_insights()
    save_performance_insights([insight, *insights])
    return insight


def export_notelog_note(note_id: str) -> dict[str, Any]:
    notes = load_notelog_notes()
    note = next((item for item in notes if item["id"] == note_id), None)
    if not note:
        raise bad_request("Note not found")
    settings.outputs_dir.joinpath("Notes").mkdir(parents=True, exist_ok=True)
    file_name = f"{note.get('title') or 'notelog'}-{note['id'][:8]}.pdf"
    safe_file_name = "".join(ch if ch.isalnum() or ch in "._-" else "-" for ch in file_name)[:180]
    pdf_bytes = create_notelog_pdf(note)
    output_path = settings.outputs_dir / "Notes" / safe_file_name
    output_path.write_bytes(pdf_bytes)
    note["exportedFileName"] = safe_file_name
    note["exportedAt"] = now_iso()
    save_notelog_notes(notes)
    return {"fileName": safe_file_name, "previewUrl": f"/api/outputs/notes/{safe_file_name}", "notes": sort_notelog_notes(notes)}


@app.get("/api/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/api/version")
def version() -> dict[str, str]:
    return {"version": app_version()}


@app.post("/api/auth/login")
def login(payload: dict[str, Any], response: Response, app_settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()
    access_key = str(payload.get("accessKey") or "")
    if not name or not access_key or not secrets.compare_digest(access_key, app_settings.optimus_access_key):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    clean_expired_sessions()
    token = secrets.token_urlsafe(32)
    expires_at = time.time() + app_settings.session_ttl_seconds
    sessions[token] = {"name": name, "expiresAt": expires_at}
    session_cookie(response, token, expires_at)
    return {"user": {"name": name}, "expiresAt": int(expires_at * 1000)}


@app.get("/api/auth/me")
def me(session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"user": {"name": session["name"]}, "expiresAt": int(session["expiresAt"] * 1000)}


@app.get("/api/auth/session")
def auth_session(request: Request) -> dict[str, Any]:
    session = optional_session(request)
    if not session:
        return {"authenticated": False}
    return {"authenticated": True, "user": {"name": session["name"]}, "expiresAt": int(session["expiresAt"] * 1000)}


@app.post("/api/auth/logout")
def logout(response: Response, request: Request) -> dict[str, bool]:
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        sessions.pop(token, None)
    expire_session_cookie(response)
    return {"ok": True}


@app.get("/api/tools")
def tools(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"tools": sorted_tool_catalog(load_tool_catalog_config())}


@app.get("/api/admin/tool-catalog")
def get_admin_tool_catalog(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return admin_tool_catalog(load_tool_catalog_config())


@app.post("/api/admin/tool-catalog")
def post_admin_tool_catalog(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_tool_catalog_config(payload)


@app.get("/api/admin/backup")
def get_admin_backup(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return create_backup_archive(
        {
            "tool-catalog.json": load_tool_catalog_config(),
            "padelog-matches.json": {"matches": load_padelog_matches()},
            "betlog-bets.json": {"bets": load_betlog_bets()},
            "notelog-notes.json": {"notes": load_notelog_notes()},
            "performance-insights.json": {"insights": load_performance_insights()},
            "knowledge-expert.json": knowledge_repo.backup_snapshot(),
        }
    )


@app.post("/api/admin/restore")
def post_admin_restore(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    files = read_backup_archive(payload)
    catalog = normalize_tool_catalog_config(files.get("tool-catalog.json"), strict=True)
    padelog = files.get("padelog-matches.json", {}).get("matches", [])
    betlog = files.get("betlog-bets.json", {}).get("bets", [])
    notelog = files.get("notelog-notes.json", {}).get("notes", [])
    insights = files.get("performance-insights.json", {}).get("insights", [])
    knowledge = files.get("knowledge-expert.json")
    normalized_knowledge = normalize_knowledge_store(knowledge) if isinstance(knowledge, dict) else None
    store.set(DATA_STORES["toolCatalog"], catalog)
    save_padelog_matches([normalize_padelog_match(row) for row in padelog])
    save_betlog_bets([normalize_betlog_bet(row) for row in betlog])
    save_notelog_notes([normalize_notelog_note(row) for row in notelog])
    save_performance_insights(insights if isinstance(insights, list) else [])
    if normalized_knowledge is not None:
        knowledge_repo.replace_all(normalized_knowledge)
    return {
        "ok": True,
        "restored": {
            "matches": len(padelog),
            "bets": len(betlog),
            "notes": len(notelog),
            "insights": len(insights) if isinstance(insights, list) else 0,
            "knowledgeExpertEntries": len(normalized_knowledge["entries"]) if normalized_knowledge is not None else 0,
        },
        "catalog": admin_tool_catalog(load_tool_catalog_config()),
    }


@app.post("/api/public/padelog/matches", dependencies=[Depends(require_public_api_key)])
def public_add_padelog_matches(payload: dict[str, Any]) -> JSONResponse:
    result = add_padelog_matches(payload)
    return JSONResponse(status_code=201, content={"imported": result["imported"], "total": len(result["matches"]), "created": result["created"]})


@app.post("/api/public/betlog/bets", dependencies=[Depends(require_public_api_key)])
def public_add_betlog_bets(payload: dict[str, Any]) -> JSONResponse:
    result = add_betlog_bets(payload)
    return JSONResponse(status_code=201, content={"imported": result["imported"], "total": len(result["bets"]), "created": result["created"]})


@app.get("/api/tools/padelog/matches")
def get_padelog_matches(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"matches": load_padelog_matches()}


@app.post("/api/tools/padelog/matches")
def post_padelog_matches(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return add_padelog_matches(payload)


@app.post("/api/tools/padelog/update")
def post_padelog_update(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return update_padelog_match(payload)


@app.post("/api/tools/padelog/delete")
def post_padelog_delete(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return delete_padelog_match(str(payload.get("id") or ""))


@app.get("/api/tools/padelog/analysis")
def get_padelog_analysis(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"insights": [item for item in load_performance_insights() if item.get("toolId") == "padelog"]}


@app.post("/api/tools/padelog/analysis")
def post_padelog_analysis(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_performance_insight(analyze_padelog_performance(load_padelog_matches(), settings))


@app.get("/api/tools/betlog/bets")
def get_betlog_bets(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"bets": load_betlog_bets()}


@app.post("/api/tools/betlog/bets")
def post_betlog_bets(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return add_betlog_bets(payload)


@app.post("/api/tools/betlog/update")
def post_betlog_update(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return update_betlog_bet(payload)


@app.post("/api/tools/betlog/delete")
def post_betlog_delete(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return delete_betlog_bet(str(payload.get("id") or ""))


@app.get("/api/tools/betlog/analysis")
def get_betlog_analysis(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"insights": [item for item in load_performance_insights() if item.get("toolId") == "betlog"]}


@app.post("/api/tools/betlog/analysis")
def post_betlog_analysis(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_performance_insight(analyze_betlog_performance(load_betlog_bets(), settings))


@app.get("/api/tools/notelog/notes")
def get_notelog_notes(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"notes": load_notelog_notes()}


@app.post("/api/tools/notelog/notes")
def post_notelog_notes(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return upsert_notelog_note(payload)


@app.post("/api/tools/notelog/delete")
def post_notelog_delete(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return delete_notelog_note(str(payload.get("id") or ""))


@app.post("/api/tools/notelog/export")
def post_notelog_export(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return export_notelog_note(str(payload.get("id") or ""))


@app.get("/api/outputs/notes/{file_name}")
def get_notelog_output(file_name: str, _: dict[str, Any] = Depends(require_session)) -> FastAPIResponse:
    safe_name = file_name.split("/")[-1]
    path = settings.outputs_dir / "Notes" / safe_name
    if not path.exists():
        raise HTTPException(status_code=404, detail="Notelog PDF not found")
    return FastAPIResponse(content=path.read_bytes(), media_type="application/pdf", headers={"Content-Disposition": f'inline; filename="{safe_name}"'})


@app.post("/api/tools/html-base64")
def post_html_base64(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_iframe_source(payload, settings)


@app.post("/api/tools/pdf-base64")
def post_pdf_base64(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_pdf_iframe_source(payload, settings)


@app.post("/api/tools/combine-pdfs")
def post_combine_pdfs(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return combine_pdf_documents(payload, settings)


@app.post("/api/tools/csv-json-rows")
def post_csv_json_rows(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_csv_json_rows(payload, settings)


@app.post("/api/tools/csv-qa-markdown")
def post_csv_qa_markdown(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_csv_qa_markdown(payload, settings)


@app.post("/api/tools/token-usage")
def post_token_usage(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return check_token_usage(payload, settings)


@app.get("/api/outputs/iframe-sources")
def get_iframe_sources(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return {"files": list_iframe_source_files(settings)}


@app.get("/api/outputs/download/{output_path:path}")
def download_output(output_path: str, _: dict[str, Any] = Depends(require_session)) -> FastAPIResponse:
    relative_path = output_path.strip("/")
    if not relative_path or Path(relative_path).is_absolute() or any(part == ".." for part in Path(relative_path).parts):
        raise HTTPException(status_code=404, detail="Output not found")
    path = settings.outputs_dir / relative_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Output not found")
    if path.is_dir():
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for child in sorted(item for item in path.rglob("*") if item.is_file()):
                archive.write(child, child.relative_to(path.parent))
        file_name = f"{path.name}.zip"
        return FastAPIResponse(
            content=buffer.getvalue(),
            media_type="application/zip",
            headers={"Content-Disposition": f'attachment; filename="{file_name}"'},
        )
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return FastAPIResponse(
        content=path.read_bytes(),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{path.name}"'},
    )


@app.post("/api/tools/presentation-suite")
def post_presentation_suite(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_presentation_suite(payload, settings)


@app.post("/api/tools/demo-builder")
def post_demo_builder(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return save_demo_builder_template(payload, settings)


@app.get("/api/tools/knowledge-expert")
def get_knowledge_expert(
    conversationId: str = "",
    _: dict[str, Any] = Depends(require_session),
) -> dict[str, Any]:
    return knowledge_repo.snapshot(conversationId)


@app.post("/api/tools/knowledge-expert/conversations")
def post_knowledge_conversation(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.create_conversation(payload, session["name"])


@app.post("/api/tools/knowledge-expert/conversations/update")
def post_knowledge_conversation_update(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.update_conversation(payload, session["name"])


@app.post("/api/tools/knowledge-expert/conversations/clear")
def post_knowledge_conversation_clear(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, bool]:
    return knowledge_repo.clear_conversation(payload)


@app.post("/api/tools/knowledge-expert/conversations/delete")
def post_knowledge_conversation_delete(payload: dict[str, Any], _: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.delete_conversation(payload)


@app.post("/api/tools/knowledge-expert/feedback")
def post_knowledge_feedback(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.rate_turn(payload, session["name"])


@app.get("/api/tools/knowledge-expert/admin/conversations")
def get_knowledge_admin_conversations(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.conversations_report()


@app.get("/api/tools/knowledge-expert/admin/reports/errors")
def get_knowledge_admin_errors(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.errors_report()


@app.get("/api/tools/knowledge-expert/admin/reports/dead-entries")
def get_knowledge_admin_dead_entries(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.dead_entries_report()


@app.get("/api/tools/knowledge-expert/admin/reports/source-coverage")
def get_knowledge_admin_source_coverage(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.source_coverage_report()


@app.get("/api/tools/knowledge-expert/admin/reports/knowledge-gaps")
def get_knowledge_admin_gaps(_: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.gaps_report()


@app.post("/api/tools/knowledge-expert/upload")
def post_knowledge_upload(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.replace_dataset(payload, session["name"])


@app.post("/api/tools/knowledge-expert/chat")
def post_knowledge_chat(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> dict[str, Any]:
    return knowledge_repo.chat(payload, session["name"])


def sse_event(event: str, payload: dict[str, Any] | None = None) -> str:
    import json

    return f"event: {event}\ndata: {json.dumps(payload or {})}\n\n"


@app.post("/api/tools/knowledge-expert/chat/stream")
def post_knowledge_chat_stream(payload: dict[str, Any], session: dict[str, Any] = Depends(require_session)) -> StreamingResponse:
    def generate():
        trace_events: list[dict[str, Any]] = []
        text_chunks: list[str] = []

        def on_trace(event: dict[str, Any]) -> None:
            trace_events.append(event)

        def on_text_delta(delta: str) -> None:
            text_chunks.append(delta)

        try:
            turn = knowledge_repo.chat(payload, session["name"], on_trace=on_trace, on_text_delta=on_text_delta)
            for event in trace_events:
                yield sse_event("trace", event)
            if text_chunks:
                for delta in text_chunks:
                    yield sse_event("text_delta", {"delta": delta})
            elif turn.get("assistantResponse"):
                yield sse_event("text_delta", {"delta": turn["assistantResponse"]})
            yield sse_event(
                "meta",
                {
                    "traceId": turn["id"],
                    "citations": turn["citations"],
                    "grounded": turn["grounded"],
                    "durationMs": turn["durationMs"],
                    "turn": turn,
                },
            )
        except Exception as error:
            yield sse_event("error", {"message": getattr(error, "detail", None) or str(error)})
        yield sse_event("done", {})

    return StreamingResponse(generate(), media_type="text/event-stream")
