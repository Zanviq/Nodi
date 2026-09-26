"""Tag endpoints — concept list + co-occurrence (concept page material).

All scoped to the caller's own tags in a space (access layer + owner filters).
personal: space_ref defaults to the caller's own id (mirrors sessions).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient

router = APIRouter(prefix="/tags", tags=["tags"])

TAG_SELECT = "id,name,usage_count,space_kind,space_ref,created_at"


def _resolve_ref(space_kind: str, space_ref: str | None, user_id: str) -> str:
    # personal -> own id; class -> the class id is required.
    if space_kind == "personal":
        return space_ref or user_id
    if not space_ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class space requires space_ref (class id).",
        )
    return space_ref


@router.get("")
async def list_tags(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Own concept tags in a space, most-used first."""
    ref = _resolve_ref(space_kind, space_ref, user.id)
    client = UserClient.from_user(user)
    return await client.select(
        "tags",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{ref}",
            "select": TAG_SELECT,
            "order": "usage_count.desc,name.asc",
        },
    )


@router.get("/cooccurrence")
async def tag_cooccurrence(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Tag pairs co-attached on the same node, within the caller's space.

    Returns rows {tag_a, tag_b, name_a, name_b, count} (count desc).
    """
    ref = _resolve_ref(space_kind, space_ref, user.id)
    client = UserClient.from_user(user)
    result = await client.rpc(
        "tag_cooccurrence",
        {"p_space_kind": space_kind, "p_space_ref": ref},
    )
    return result if isinstance(result, list) else []
