"""Home dashboard + overseer data queries (Stage 4a).

Plain, read-only, access-checked queries reused by both the `/home/*` routers
and the overseer read-skills. No LLM here.
"""

from __future__ import annotations

from typing import Any

from ..db.client import UserClient


async def get_my_spaces(
    client: UserClient, owner_id: str
) -> list[dict[str, Any]]:
    """Personal space + joined classes, as logical spaces."""
    spaces: list[dict[str, Any]] = [
        {
            "space_kind": "personal",
            "space_ref": owner_id,
            "name": "개인 공간",
            "role_in_class": None,
        }
    ]
    rows = await client.select(
        "class_members",
        {
            "user_id": f"eq.{owner_id}",
            "select": "class_id,role_in_class,classes(id,name)",
        },
    )
    for r in rows:
        cls = r.get("classes") or {}
        if not isinstance(cls, dict) or not cls.get("id"):
            continue
        spaces.append(
            {
                "space_kind": "class",
                "space_ref": cls["id"],
                "name": cls.get("name") or "학급",
                "role_in_class": r.get("role_in_class"),
            }
        )
    return spaces


async def get_recent_sessions(
    client: UserClient,
    space_kind: str | None = None,
    space_ref: str | None = None,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Most-recently-updated sessions, optionally scoped to one space."""
    params: dict[str, str] = {
        "select": "id,title,emoji,space_kind,space_ref,updated_at",
        "order": "updated_at.desc",
        "limit": str(limit),
    }
    if space_kind:
        params["space_kind"] = f"eq.{space_kind}"
    if space_ref:
        params["space_ref"] = f"eq.{space_ref}"
    return await client.select("sessions", params)


async def get_top_concepts(
    client: UserClient,
    space_kind: str,
    space_ref: str,
    limit: int = 8,
) -> list[dict[str, Any]]:
    """Most-used concept tags in a space."""
    return await client.select(
        "tags",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{space_ref}",
            "select": "id,name,usage_count",
            "order": "usage_count.desc,name.asc",
            "limit": str(limit),
        },
    )


def _ilike(q: str) -> str:
    # Strip ILIKE wildcards from the user query, then wrap for a contains-match.
    safe = q.replace("%", "").replace("*", "").replace(",", " ").strip()
    return f"ilike.*{safe}*"


async def find_sessions_by_topic(
    client: UserClient, query: str, limit: int = 5
) -> dict[str, Any]:
    """Find sessions whose title matches, plus concept tags that match."""
    query = (query or "").strip()
    if not query:
        return {"sessions": [], "matched_tags": []}
    sessions = await client.select(
        "sessions",
        {
            "title": _ilike(query),
            "select": "id,title,space_kind,space_ref,updated_at",
            "order": "updated_at.desc",
            "limit": str(limit),
        },
    )
    matched_tags = await client.select(
        "tags",
        {
            "name": _ilike(query),
            "select": "id,name,usage_count,space_kind,space_ref",
            "order": "usage_count.desc",
            "limit": str(limit),
        },
    )
    return {"sessions": sessions, "matched_tags": matched_tags}
