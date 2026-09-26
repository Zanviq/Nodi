"""Auth dependencies.

The session is an HS256 JWT issued by POST /auth/login|register and stored in
the httpOnly cookie `nodi_session` (an `Authorization: Bearer <token>` header
with the same token is also accepted, e.g. for curl). Provides:

- `get_current_user`    -> verified identity (id / username)
- `get_current_profile` -> the caller's `profiles` row (+ username)
- `require_role(*roles)`-> guard factory using the APP role from `profiles`
- `require_admin`       -> admin-only guard
- `get_user_scopes`     -> personal + class scopes the caller can access
"""

from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status
from pydantic import BaseModel

from ..config import get_settings
from ..db.client import UserClient, get_service_client
from .security import decode_session_token

settings = get_settings()


class CurrentUser(BaseModel):
    id: str  # users.id == profiles.id
    username: str | None = None


class Profile(BaseModel):
    id: str
    username: str | None = None
    email: str | None = None
    role: str = "student"  # app role: student | teacher | admin
    display_name: str | None = None
    avatar_url: str | None = None
    onboarded: bool = False  # D18 — one-time onboarding completed


def _unauthorized(detail: str = "Not authenticated.") -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def _token_from_request(request: Request) -> str | None:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        return token
    auth = request.headers.get("authorization") or ""
    if auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


async def get_current_user(request: Request) -> CurrentUser:
    token = _token_from_request(request)
    if not token:
        raise _unauthorized()
    claims = decode_session_token(token)
    if claims is None:
        raise _unauthorized("Session is invalid or expired.")
    return CurrentUser(id=str(claims["sub"]), username=claims.get("username"))


PROFILE_SQL = """
select p.id::text as id, u.username, p.email, p.role, p.display_name,
       p.avatar_url, p.onboarded
  from public.profiles p
  join public.users u on u.id = p.id
 where p.id = $1::text::uuid
"""


async def load_profile(user_id: str) -> Profile | None:
    row = await get_service_client().fetchrow(PROFILE_SQL, user_id)
    return Profile(**dict(row)) if row else None


async def get_current_profile(
    user: CurrentUser = Depends(get_current_user),
) -> Profile:
    profile = await load_profile(user.id)
    if profile is None:
        # Account deleted (or DB reset) while the cookie was still valid.
        raise _unauthorized("Account no longer exists.")
    return profile


def require_role(*allowed_roles: str):
    """Dependency factory: allow only callers whose APP role is in allowed_roles."""

    async def _guard(profile: Profile = Depends(get_current_profile)) -> Profile:
        if profile.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires role in {allowed_roles}; have '{profile.role}'.",
            )
        return profile

    return _guard


async def require_admin(
    profile: Profile = Depends(get_current_profile),
) -> Profile:
    """Guard for admin-only endpoints (app role 'admin'). 403 otherwise."""
    if profile.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin only.",
        )
    return profile


class UserScopes(BaseModel):
    user_id: str
    personal_ref: str  # == user_id
    class_ids: list[str] = []


async def get_user_scopes(
    user: CurrentUser = Depends(get_current_user),
) -> UserScopes:
    """Resolve the scopes (personal + class memberships) the caller can access."""
    rows = await UserClient.from_user(user).select(
        "class_members",
        {"user_id": f"eq.{user.id}", "select": "class_id"},
    )
    class_ids = [r["class_id"] for r in rows if r.get("class_id")]
    return UserScopes(user_id=user.id, personal_ref=user.id, class_ids=class_ids)
