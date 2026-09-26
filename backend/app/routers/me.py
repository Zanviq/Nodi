"""Current-user endpoints — session-cookie gated.

GET   /auth/me                    profile (+ username, role, onboarded)
PATCH /auth/me                    {display_name} -> updated profile
GET   /auth/me/token              identity from the session token (no DB read)
GET   /auth/me/scopes             personal + class scopes
GET   /auth/me/classes            own class memberships (+ class id/name/join_code)
POST  /auth/me/classes/join       {code} -> join a class by join code
GET   /auth/me/navigator-defaults effective navigator defaults
POST  /auth/complete-onboarding   mark onboarding complete (idempotent)
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth.deps import (
    CurrentUser,
    Profile,
    UserScopes,
    get_current_profile,
    get_current_user,
    get_user_scopes,
    load_profile,
)
from ..config import get_settings
from ..db.client import UserClient
from ..services import app_settings

settings = get_settings()
router = APIRouter(prefix="/auth", tags=["auth"])

MY_CLASS_SELECT = "class_id,role_in_class,created_at,classes(id,name,join_code)"


@router.get("/me", response_model=Profile)
async def get_me(profile: Profile = Depends(get_current_profile)) -> Profile:
    """Return the authenticated caller's profile."""
    return profile


class ProfilePatch(BaseModel):
    display_name: str = Field(min_length=1, max_length=50)


@router.patch("/me", response_model=Profile)
async def update_me(
    body: ProfilePatch,
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    """Update the caller's own display name (the only self-editable field
    besides avatar_url — role/onboarded cannot be changed here)."""
    name = body.display_name.strip()
    if not name:
        raise HTTPException(
            status_code=422,
            detail={"code": "display_name_required", "message": "이름을 입력해 주세요."},
        )
    client = UserClient.from_user(user)
    rows = await client.update(
        "profiles", {"id": f"eq.{user.id}"}, {"display_name": name}
    )
    if not rows:
        raise HTTPException(status_code=404, detail="Profile not found.")
    profile = await load_profile(user.id)
    if profile is None:
        raise HTTPException(status_code=404, detail="Profile not found.")
    return profile


@router.get("/me/token")
async def get_me_token(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Lightweight identity from the verified session token (no DB read)."""
    return {"id": user.id, "username": user.username}


@router.get("/me/scopes", response_model=UserScopes)
async def get_me_scopes(scopes: UserScopes = Depends(get_user_scopes)) -> UserScopes:
    """Personal + class scopes the caller can access (for scoped queries)."""
    return scopes


@router.get("/me/classes")
async def list_my_classes(
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """The caller's class memberships:
    ``[{class_id, role_in_class, created_at, classes: {id, name, join_code}}]``."""
    client = UserClient.from_user(user)
    return await client.select(
        "class_members",
        {
            "user_id": f"eq.{user.id}",
            "select": MY_CLASS_SELECT,
            "order": "created_at.asc",
        },
    )


class JoinClassBody(BaseModel):
    code: str = Field(min_length=1, max_length=32)


@router.post("/me/classes/join")
async def join_class(
    body: JoinClassBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Join a class by its join code (idempotent). 404 `invalid_join_code`."""
    client = UserClient.from_user(user)
    code = body.code.strip()
    try:
        await client.rpc("join_class_by_code", {"p_code": code})
    except HTTPException as exc:
        if getattr(exc, "sqlstate", None) == "P0002":
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={
                    "code": "invalid_join_code",
                    "message": "유효하지 않은 학급 코드입니다.",
                },
            ) from exc
        raise
    rows = await client.select(
        "class_members",
        {
            "user_id": f"eq.{user.id}",
            "select": MY_CLASS_SELECT,
            "order": "created_at.desc",
        },
    )
    joined = next(
        (r for r in rows if (r.get("classes") or {}).get("join_code") == code),
        rows[0] if rows else {},
    )
    return joined


@router.get("/me/navigator-defaults")
async def get_navigator_defaults(
    _user: CurrentUser = Depends(get_current_user),
) -> dict[str, int]:
    """Effective navigator defaults = config baseline ⊕ admin app_settings override.

    Lets the workspace settings UI show the REAL applied numbers (not "기본")
    even for non-admins (D55b). Returns ``{question_count, gate_k, period}``.

    D64: this resolves through the SAME app_settings overlay + accessors +
    clamps that navigator.maybe_generate uses for the actual gate, so the value
    shown here can no longer drift from the value enforced at generation time.
    The overlay is read by the trusted system client (app_settings is admin-only
    for user clients) and falls back to config on any failure.
    """
    overlay = await app_settings.get_overlay()
    return {
        "question_count": app_settings.as_int(
            overlay,
            "navigator_question_count",
            settings.navigator_question_count,
            1,
            5,
        ),
        "gate_k": app_settings.as_int(
            overlay, "navigator_k", settings.navigator_gate_k, 1, 10
        ),
        "period": app_settings.as_int(
            overlay, "navigator_period", settings.navigator_period, 1, 20
        ),
    }


@router.post("/complete-onboarding")
async def complete_onboarding(
    user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Mark the caller's onboarding complete (D18). Idempotent.

    Uses the mark_onboarded() RPC because `onboarded` is not a self-editable
    profile column (only display_name / avatar_url are).
    """
    client = UserClient.from_user(user)
    await client.rpc("mark_onboarded", {})
    return {"onboarded": True}
