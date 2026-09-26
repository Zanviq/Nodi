"""Account endpoints — username + password, session cookie.

POST /auth/register  {username, password, display_name?}  -> 201 Profile + cookie
POST /auth/login     {username, password}                 -> 200 Profile + cookie
POST /auth/logout                                          -> 204, cookie cleared

The cookie `nodi_session` (httpOnly, SameSite=Lax, Secure iff COOKIE_SECURE)
carries an HS256 JWT valid for JWT_EXPIRE_DAYS. Errors use
`{"detail": {"code": ..., "message": ...}}`.
"""

from __future__ import annotations

import asyncio
import logging

import asyncpg
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel, Field

from ..auth.deps import Profile, load_profile
from ..auth.security import (
    clear_session_cookie,
    create_session_token,
    hash_password,
    password_too_long,
    set_session_cookie,
    verify_password,
)
from ..db.client import get_service_client

logger = logging.getLogger("nodi.auth.router")
router = APIRouter(prefix="/auth", tags=["auth"])

USERNAME_PATTERN = r"^[a-zA-Z0-9_.-]+$"


def _error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"code": code, "message": message}
    )


class RegisterBody(BaseModel):
    username: str = Field(min_length=3, max_length=32, pattern=USERNAME_PATTERN)
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=50)


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=Profile)
async def register(body: RegisterBody, response: Response) -> Profile:
    if password_too_long(body.password):
        raise _error(
            422,
            "password_too_long",
            "비밀번호가 너무 깁니다(최대 72바이트).",
        )
    display_name = (body.display_name or "").strip() or body.username
    password_hash = await asyncio.to_thread(hash_password, body.password)

    async def create(conn: asyncpg.Connection):
        row = await conn.fetchrow(
            "insert into public.users (username, password_hash) "
            "values ($1::text, $2::text) returning id::text as id",
            body.username,
            password_hash,
        )
        await conn.execute(
            "insert into public.profiles (id, display_name, role, onboarded) "
            "values ($1::text::uuid, $2::text, 'student', false)",
            row["id"],
            display_name,
        )
        return row["id"]

    try:
        user_id = await get_service_client().transaction(create)
    except HTTPException as exc:
        if getattr(exc, "sqlstate", None) == "23505":
            raise _error(
                status.HTTP_409_CONFLICT,
                "username_taken",
                "이미 사용 중인 아이디입니다.",
            ) from exc
        raise
    profile = await load_profile(user_id)
    if profile is None:  # pragma: no cover - just created
        raise HTTPException(status_code=500, detail="Registration failed.")
    set_session_cookie(response, create_session_token(user_id, body.username))
    return profile


@router.post("/login", response_model=Profile)
async def login(body: LoginBody, response: Response) -> Profile:
    row = await get_service_client().fetchrow(
        "select id::text as id, username, password_hash from public.users "
        "where lower(username) = lower($1::text)",
        body.username.strip(),
    )
    ok = await asyncio.to_thread(
        verify_password, body.password, row["password_hash"] if row else None
    )
    if not row or not ok:
        raise _error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "아이디 또는 비밀번호가 올바르지 않습니다.",
        )
    profile = await load_profile(row["id"])
    if profile is None:
        raise _error(
            status.HTTP_401_UNAUTHORIZED,
            "invalid_credentials",
            "아이디 또는 비밀번호가 올바르지 않습니다.",
        )
    set_session_cookie(response, create_session_token(row["id"], row["username"]))
    return profile


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout() -> Response:
    response = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_session_cookie(response)
    return response
