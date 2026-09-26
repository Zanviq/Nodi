"""Admin console endpoints (Stage 4c) — all admin-only.

Runs as the admin's own identity: the access layer's admin read rules and the
admin RPCs (admin_set_user_role / admin_token_usage) re-check is_admin().
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, Profile, get_current_user, require_admin
from ..db.client import UserClient, get_service_client
from ..services import app_settings

logger = logging.getLogger("nodi.admin")
router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Users + roles
# ---------------------------------------------------------------------------
@router.get("/users")
async def list_users(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    rows = await client.select(
        "profiles",
        {
            "select": "id,email,role,display_name,avatar_url,created_at",
            "order": "created_at.desc",
        },
    )
    # Login names live in `users` (not user-readable); attach them for the
    # caller-verified admin.
    names = {
        r["id"]: r["username"]
        for r in await get_service_client().fetch(
            "select id::text as id, username from public.users"
        )
    }
    for r in rows:
        r["username"] = names.get(r.get("id"))
    return rows


class RoleBody(BaseModel):
    role: str = Field(pattern="^(student|teacher|admin)$")


@router.post("/users/{user_id}/role")
async def set_user_role(
    user_id: str,
    body: RoleBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Change a user's app role. Self-demotion is blocked inside the RPC."""
    client = UserClient.from_user(user)
    result = await client.rpc(
        "admin_set_user_role",
        {"p_user_id": user_id, "p_role": body.role},
    )
    if isinstance(result, list):
        return result[0] if result else {}
    return result


# ---------------------------------------------------------------------------
# Runtime settings (app_settings)
# ---------------------------------------------------------------------------
@router.get("/settings")
async def list_settings(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await client.select(
        "app_settings",
        {"select": "key,value,updated_at,updated_by", "order": "key.asc"},
    )


class SettingBody(BaseModel):
    # jsonb value — any JSON type (str/number/bool/object/array).
    value: Any


@router.put("/settings/{key}")
async def put_setting(
    key: str,
    body: SettingBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Upsert one runtime setting and invalidate the overlay cache (D62).

    The value lands in app_settings AND, because every tunable call site now
    reads through the app_settings overlay (services/app_settings.py), takes
    LIVE effect — instantly in this process via bust_cache(), within the TTL
    elsewhere. (Danger keys like embedding_dimension are guarded in the file pipeline.)
    """
    client = UserClient.from_user(user)
    result = await client.upsert(
        "app_settings",
        {
            "key": key,
            "value": body.value,
            "updated_by": user.id,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        on_conflict="key",
    )
    app_settings.bust_cache()
    return result


# ---------------------------------------------------------------------------
# Usage (partial — see note)
# ---------------------------------------------------------------------------
@router.get("/usage")
async def token_usage(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Per-user token totals.

    PARTIAL: ai_steps.tokens currently covers only ReAct skill steps (navigator
    / overseer). Chat and tagging token usage is not yet logged. Storage /
    embedding usage arrives with files (Stage 3b).
    """
    client = UserClient.from_user(user)
    rows = await client.rpc("admin_token_usage", {})
    return {
        "partial": True,
        "note": "Only ReAct skill-step tokens are counted; chat/tagging tokens "
        "are not yet logged. Storage/embedding usage pending Stage 3b.",
        "by_user": rows if isinstance(rows, list) else [],
    }


# ---------------------------------------------------------------------------
# Logs — chat turn browser (ai_logs, D25) + ReAct step traces (ai_sessions)
# ---------------------------------------------------------------------------
def _iso_or_422(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid timestamp.",
        ) from None


@router.get("/logs")
async def list_logs(
    user_id: str | None = Query(None),
    since: str | None = Query(None, description="ISO timestamp (created_at >=)"),
    until: str | None = Query(None, description="ISO timestamp (created_at <)"),
    after: str | None = Query(
        None,
        description="ISO timestamp (created_at > after) — polling for new turns",
    ),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """Chat turn logs (`ai_logs`): system prompt, Q/A, used contexts, skill
    calls, errors, token estimate. user/date filters + pagination, newest first.

    Live view = polling: call with `after=<created_at of the newest row you
    have>` every few seconds; only strictly newer turns come back (newest
    first). `since`/`until` remain the inclusive/exclusive range filters."""
    client = UserClient.from_user(user)
    params: dict[str, str] = {
        "select": (
            "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
            "contexts,skill_calls,errors,token_estimate,created_at"
        ),
        "order": "created_at.desc",
        "limit": str(limit),
        "offset": str(offset),
    }
    # These values are spliced into filter strings (and=(...)), so accept only
    # real ISO timestamps — a raw value could otherwise append extra conditions.
    since, until, after = (_iso_or_422(v) for v in (since, until, after))
    if user_id:
        params["owner_id"] = f"eq.{user_id}"
    if since:
        params["created_at"] = f"gte.{since}"
    extra: list[str] = []
    if until:
        extra.append(f"created_at.lt.{until}")
    if after:
        extra.append(f"created_at.gt.{after}")
    if extra:
        # combined with `since` when present
        params["and"] = f"({','.join(extra)})"
    logs = await client.select("ai_logs", params)
    return {"limit": limit, "offset": offset, "logs": logs}


_LOG_SELECT = (
    "id,owner_id,session_id,node_id,kind,system_prompt,question,answer,"
    "contexts,skill_calls,errors,token_estimate,created_at"
)
# D42: two SIMPLE selects (no embed / embed-ordering) then assemble in Python,
# so a secondary trace problem can never block the CORE log. Plain queries are
# robust.
_SESSION_SELECT = "id,owner_id,session_id,kind,created_at"
_STEP_SELECT = (
    "ai_session_id,seq,thought,skill,input,observation,tokens,created_at"
)


async def _fetch_session_traces(
    client: UserClient,
    *,
    session_id: str | None = None,
    user_id: str | None = None,
    limit: int | None = None,
    offset: int | None = None,
) -> list[dict[str, Any]]:
    """ReAct traces assembled from two plain queries (no embed): ai_sessions,
    then ai_steps (in.(session ids), seq.asc), grouped in Python. Returns each
    session row with an attached `ai_steps` list — the shape the frontend's
    embedded form produced — without depending on embedded selects."""
    params: dict[str, str] = {
        "select": _SESSION_SELECT,
        "order": "created_at.desc",
    }
    if session_id:
        params["session_id"] = f"eq.{session_id}"
    if user_id:
        params["owner_id"] = f"eq.{user_id}"
    if limit is not None:
        params["limit"] = str(limit)
    if offset is not None:
        params["offset"] = str(offset)
    sessions = await client.select("ai_sessions", params)
    if not sessions:
        return []
    sess_ids = [s["id"] for s in sessions if s.get("id")]
    steps: list[dict[str, Any]] = []
    if sess_ids:
        steps = await client.select(
            "ai_steps",
            {
                "ai_session_id": f"in.({','.join(sess_ids)})",
                "select": _STEP_SELECT,
                "order": "seq.asc",
            },
        )
    by_session: dict[str, list[dict[str, Any]]] = {}
    for st in steps:
        by_session.setdefault(st.get("ai_session_id"), []).append(st)
    assembled: list[dict[str, Any]] = []
    for s in sessions:
        row = dict(s)
        row["ai_steps"] = by_session.get(s.get("id"), [])
        assembled.append(row)
    return assembled


@router.get("/logs/{log_id}")
async def get_log_detail(
    log_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """D34 turn detail: one `ai_logs` turn (structured contexts incl. RAG
    sources + prompt spans) bundled with the ReAct traces (`ai_sessions` +
    `ai_steps`) of the SAME session, so the admin sees how a turn was built and
    which navigator/overseer steps ran. Admin-only (require_admin + admin rules).

    D42: the CORE log is always returned when it exists; trace assembly is
    isolated in try/except so a secondary-data failure can never block the turn
    detail (the all-or-nothing embed bug)."""
    client = UserClient.from_user(user)
    rows = await client.select(
        "ai_logs",
        {"id": f"eq.{log_id}", "select": _LOG_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Log not found."
        )
    log = rows[0]
    traces: list[dict[str, Any]] = []
    session_id = log.get("session_id")
    if session_id:
        try:
            traces = await _fetch_session_traces(client, session_id=session_id)
        except Exception:  # noqa: BLE001 - traces are secondary; never 502 the log
            logger.warning(
                "trace fetch failed for log=%s session=%s",
                log_id,
                session_id,
                exc_info=True,
            )
            traces = []
    return {"log": log, "traces": traces}


@router.get("/traces")
async def list_traces(
    user_id: str | None = Query(None),
    session_id: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_admin),
) -> dict[str, Any]:
    """ReAct step traces (`ai_sessions` + `ai_steps`) for navigator/overseer
    runs. Filter by user and/or session (the latter powers the D34 turn-detail
    timeline). Assembled from two plain queries (D42) — no embedded select."""
    client = UserClient.from_user(user)
    sessions = await _fetch_session_traces(
        client,
        session_id=session_id,
        user_id=user_id,
        limit=limit,
        offset=offset,
    )
    return {"limit": limit, "offset": offset, "sessions": sessions}
