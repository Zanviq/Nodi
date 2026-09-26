"""User-supplied Gemini API key (per request).

The server holds NO Gemini key. Every AI-using request carries the caller's own
key in the `X-Gemini-Key` header. The key:
  * lives only in local variables / the request scope (never a module-level
    cache, never persisted to the DB, never put into traces or ai_logs);
  * is redacted from any log line by `KeyRedactingFilter` (defense in depth);
  * is validated for shape only (printable ASCII, sane length).

Error contract (see api-contract.md):
  REST: 400 {"detail": {"code": "gemini_key_required" | "gemini_key_invalid",
                        "message": "..."}}
  SSE : a single `event: error` with data {"code": ..., "detail": "..."}
"""

from __future__ import annotations

import contextvars
import logging
import re

from fastapi import Header, HTTPException, status

GEMINI_KEY_HEADER = "X-Gemini-Key"

KEY_REQUIRED = "gemini_key_required"
KEY_INVALID = "gemini_key_invalid"
QUOTA_EXCEEDED = "gemini_quota_exceeded"

MESSAGES = {
    KEY_REQUIRED: "Gemini API 키가 필요합니다. 설정에서 본인의 Gemini API 키를 입력해 주세요.",
    KEY_INVALID: "Gemini API 키가 올바르지 않습니다. 키를 확인해 주세요.",
    QUOTA_EXCEEDED: "Gemini API 사용량 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.",
}

_KEY_SHAPE = re.compile(r"^[\x21-\x7e]{8,256}$")

# Only used by the log redaction filter (value never read anywhere else).
_active_key: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "nodi_active_gemini_key", default=None
)


class GeminiKeyError(Exception):
    """Raised by AI helpers when no usable key is available."""

    def __init__(self, code: str = KEY_REQUIRED):
        super().__init__(code)
        self.code = code

    @property
    def message(self) -> str:
        return MESSAGES.get(self.code, MESSAGES[KEY_REQUIRED])


def error_detail(code: str) -> dict:
    return {"code": code, "message": MESSAGES.get(code, MESSAGES[KEY_REQUIRED])}


def key_http_error(code: str = KEY_REQUIRED) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=error_detail(code))


def _normalize(raw: str | None) -> tuple[str | None, str | None]:
    """-> (key, error_code). Missing -> (None, None); malformed -> (None, invalid)."""
    if raw is None:
        return None, None
    key = raw.strip()
    if not key:
        return None, None
    if not _KEY_SHAPE.match(key):
        return None, KEY_INVALID
    return key, None


async def optional_gemini_key(
    x_gemini_key: str | None = Header(default=None, alias=GEMINI_KEY_HEADER),
) -> str | None:
    """The caller's key, or None when absent/malformed (AI side effects skip)."""
    key, _err = _normalize(x_gemini_key)
    if key:
        _active_key.set(key)
    return key


async def gemini_key_status(
    x_gemini_key: str | None = Header(default=None, alias=GEMINI_KEY_HEADER),
) -> tuple[str | None, str | None]:
    """(key, error_code) — for SSE endpoints that report the error in-stream."""
    key, err = _normalize(x_gemini_key)
    if key:
        _active_key.set(key)
        return key, None
    return None, err or KEY_REQUIRED


async def require_gemini_key(
    x_gemini_key: str | None = Header(default=None, alias=GEMINI_KEY_HEADER),
) -> str:
    """REST AI endpoints: 400 with a machine-readable code when missing."""
    key, err = _normalize(x_gemini_key)
    if not key:
        raise key_http_error(err or KEY_REQUIRED)
    _active_key.set(key)
    return key


def classify_ai_error(exc: BaseException) -> str | None:
    """Map a Gemini SDK error to a user-facing code (or None if generic)."""
    if isinstance(exc, GeminiKeyError):
        return exc.code
    code = getattr(exc, "code", None)
    text = str(exc)
    if code == 429 or "RESOURCE_EXHAUSTED" in text:
        return QUOTA_EXCEEDED
    if code in (400, 401, 403) and (
        "API_KEY" in text or "API key" in text or "PERMISSION_DENIED" in text
    ):
        return KEY_INVALID
    return None


class KeyRedactingFilter(logging.Filter):
    """Replace the active request's Gemini key in any emitted log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        key = _active_key.get()
        if not key:
            return True
        try:
            msg = record.getMessage()
            if key in msg:
                record.msg = msg.replace(key, "[REDACTED]")
                record.args = None
            if record.exc_info and not record.exc_text:
                record.exc_text = logging.Formatter().formatException(record.exc_info)
            if record.exc_text and key in record.exc_text:
                record.exc_text = record.exc_text.replace(key, "[REDACTED]")
        except Exception:  # noqa: BLE001 - never break logging
            pass
        return True
