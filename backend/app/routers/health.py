"""Health / readiness endpoints (no auth)."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..config import get_settings
from ..db.pool import get_pool

router = APIRouter(tags=["health"])
settings = get_settings()


@router.get("/health")
async def health():
    """Liveness + database readiness. 503 while the database is unreachable.

    Exposes no secrets. AI is always per-request (X-Gemini-Key), so there is no
    server-side AI configuration to report.
    """
    db_ok = False
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            db_ok = (await conn.fetchval("select 1")) == 1
    except Exception:  # noqa: BLE001 - reported as not ready
        db_ok = False
    body = {
        "status": "ok" if db_ok else "degraded",
        "service": "nodi-backend",
        "environment": settings.environment,
        "database": db_ok,
        "ai_key_mode": "per-request",
    }
    return JSONResponse(body, status_code=200 if db_ok else 503)
