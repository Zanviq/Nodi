"""nodi FastAPI application.

Self-hosted stack: PostgreSQL (+pgvector) via a shared asyncpg pool, username +
password auth with an httpOnly session cookie, local file storage, and Gemini
called with each user's own key (`X-Gemini-Key`). Routes are mounted at the
root (the frontend reaches them through its same-origin `/api/*` rewrite).
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .ai_key import KeyRedactingFilter
from .config import get_settings
from .db.pool import close_pool, init_pool
from .routers import (
    admin,
    auth,
    chat,
    files,
    health,
    home,
    me,
    nodes,
    overseer,
    sessions,
    tags,
    teacher,
)
from .services import storage

settings = get_settings()


def _configure_logging() -> None:
    root = logging.getLogger()
    if not root.handlers:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        )
    # Defense in depth: never let a user's Gemini key reach a log line.
    for logger_name in ("", "uvicorn", "uvicorn.error", "uvicorn.access"):
        for handler in logging.getLogger(logger_name).handlers:
            if not any(isinstance(f, KeyRedactingFilter) for f in handler.filters):
                handler.addFilter(KeyRedactingFilter())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _configure_logging()
    try:
        storage.copy_seed_uploads()
    except Exception:  # noqa: BLE001 - seed files are optional
        logging.getLogger("nodi").exception("Copying seed uploads failed")
    await init_pool()
    yield
    await close_pool()


app = FastAPI(
    title="nodi backend",
    version="0.2.0",
    description="AI conversation visualized as a node/tree.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(sessions.router)
app.include_router(tags.router)
app.include_router(nodes.router)
app.include_router(chat.router)
app.include_router(home.router)
app.include_router(overseer.router)
app.include_router(admin.router)
app.include_router(files.router)
app.include_router(teacher.router)


@app.get("/", tags=["health"])
async def root() -> dict:
    return {"service": "nodi-backend", "version": "0.2.0", "docs": "/docs"}
