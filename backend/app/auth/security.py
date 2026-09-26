"""Password hashing (bcrypt) + session tokens (HS256 JWT in an httpOnly cookie)."""

from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
from fastapi import Response
from jose import jwt
from jose.exceptions import JWTError

from ..config import get_settings

logger = logging.getLogger("nodi.auth")
settings = get_settings()

ALGORITHM = "HS256"  # pinned: the token header's alg is never trusted
PLACEHOLDER_SECRET = "change-me-to-a-long-random-string"

# An empty, placeholder or short secret is never used for signing: the example
# value is public, so anyone could forge a session cookie with it. Fall back to
# a random per-process secret instead (sessions then end on backend restart).
if (
    not settings.jwt_secret
    or settings.jwt_secret == PLACEHOLDER_SECRET
    or len(settings.jwt_secret) < 32
):
    _SECRET = secrets.token_urlsafe(48)
    logger.warning(
        "JWT_SECRET is empty, the example placeholder or shorter than 32 chars: "
        "using a random per-process secret (all sessions end when the backend "
        "restarts). Set JWT_SECRET to a long random string."
    )
else:
    _SECRET = settings.jwt_secret

# Used when the username does not exist, so a failed login costs the same time
# whether or not the account exists (no username enumeration by timing).
_DUMMY_HASH = bcrypt.hashpw(b"nodi-dummy-password", bcrypt.gensalt())


def password_too_long(password: str) -> bool:
    return len(password.encode("utf-8")) > 72  # bcrypt input limit


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("ascii")


def verify_password(password: str, password_hash: str | None) -> bool:
    candidate = password.encode("utf-8")[:72]
    try:
        if not password_hash:
            bcrypt.checkpw(candidate, _DUMMY_HASH)
            return False
        return bcrypt.checkpw(candidate, password_hash.encode("ascii"))
    except ValueError:
        return False


def create_session_token(user_id: str, username: str) -> str:
    now = datetime.now(timezone.utc)
    claims = {
        "sub": user_id,
        "username": username,
        "typ": "session",
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=settings.jwt_expire_days)).timestamp()),
    }
    return jwt.encode(claims, _SECRET, algorithm=ALGORITHM)


def decode_session_token(token: str) -> dict | None:
    try:
        claims = jwt.decode(token, _SECRET, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if claims.get("typ") != "session" or not claims.get("sub"):
        return None
    return claims


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        max_age=settings.jwt_expire_days * 24 * 3600,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.session_cookie_name,
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
