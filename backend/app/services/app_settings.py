"""Runtime settings overlay (D62) — app_settings ⊕ config.

The admin console writes tuning values to `public.app_settings` (jsonb), but the
runtime historically read ONLY `config.py`, so admin edits had no live effect
(the (c)(d) bug class). This module is the single READ BRIDGE: every tunable
call site resolves its value as **per-request override > app_settings overlay >
config default**.

`get_overlay()` returns `{key: value}` for all rows via the trusted system
client (app_settings is admin-only for user clients, so a normal caller can't
read it). A short TTL cache avoids a DB read every chat turn; admin PUTs call
`bust_cache()` for same-process instant reflection (multi-process reflects
within the TTL). The cache holds only these global tuning values — nothing
user- or key-specific.

Best-effort by contract: a failed read returns `{}`, and the typed accessors
fall back to the caller-supplied config default — this module NEVER raises, so
it can sit on the hot chat path without risking a 502.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from ..db.client import get_service_client

logger = logging.getLogger("nodi.app_settings")

# Q62-1: short TTL — admin changes propagate within ~20s across processes while
# a single chat turn never triggers more than one DB read. 0 would mean "read
# every call" (instant but high load).
_TTL = 20.0
_cache: dict[str, Any] = {}
_loaded_at = 0.0


async def get_overlay() -> dict[str, Any]:
    """All app_settings as a `{key: jsonb_value}` dict (cached, best-effort).

    Returns `{}` when the read fails, so callers transparently fall back to
    config defaults. Never raises.
    """
    global _cache, _loaded_at
    now = time.monotonic()
    if _cache and (now - _loaded_at) < _TTL:
        return _cache
    svc = get_service_client()
    try:
        rows = await svc.select("app_settings", {"select": "key,value"})
        _cache = {r["key"]: r.get("value") for r in rows if r.get("key")}
        _loaded_at = now
        return _cache
    except Exception:  # noqa: BLE001 - overlay is optional; never break a turn
        logger.warning("app_settings overlay read failed; using config defaults")
        return {}


def bust_cache() -> None:
    """Force the next get_overlay() to re-read (call after an admin PUT)."""
    global _loaded_at
    _loaded_at = 0.0


# ---------------------------------------------------------------------------
# Typed accessors — jsonb value -> python, with config fallback + clamp.
# app_settings values are jsonb, so the DB layer already deserializes them to
# native python (str/int/float/bool). These coerce defensively and clamp tuning
# values into an admin-safe range so a bad edit can't push the runtime out of
# bounds.
# ---------------------------------------------------------------------------
def _clamp(value: Any, lo: Any, hi: Any) -> Any:
    if lo is not None:
        value = max(lo, value)
    if hi is not None:
        value = min(hi, value)
    return value


def as_int(
    overlay: dict[str, Any],
    key: str,
    default: int,
    lo: int | None = None,
    hi: int | None = None,
) -> int:
    raw = overlay.get(key)
    if raw is None or isinstance(raw, bool):
        return default
    try:
        v = int(raw)
    except (TypeError, ValueError):
        return default
    return _clamp(v, lo, hi)


def as_float(
    overlay: dict[str, Any],
    key: str,
    default: float,
    lo: float | None = None,
    hi: float | None = None,
) -> float:
    raw = overlay.get(key)
    if raw is None or isinstance(raw, bool):
        return default
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return default
    return _clamp(v, lo, hi)


def as_bool(overlay: dict[str, Any], key: str, default: bool) -> bool:
    raw = overlay.get(key)
    if raw is None:
        return default
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        return raw.strip().lower() in ("true", "1", "yes", "on")
    return default


def as_str(overlay: dict[str, Any], key: str, default: str) -> str:
    raw = overlay.get(key)
    if raw is None:
        return default
    if isinstance(raw, str):
        return raw.strip() or default
    return str(raw)
