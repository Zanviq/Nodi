"""Local-disk file storage (replaces the hosted object storage bucket).

Objects live under `STORAGE_DIR` (a named Docker volume by default) at the same
relative key the DB stores in `files.storage_path`: `{owner_id}/{file_id}/{name}`.

Path-traversal guard: every key is split into segments, each segment must be a
plain name (no `..`, no separators, no NUL), and the resolved absolute path must
stay inside STORAGE_DIR. Files are only served through authenticated backend
endpoints, never directly.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import unicodedata
from pathlib import Path

from fastapi import HTTPException, status

from ..config import get_settings

logger = logging.getLogger("nodi.storage")
settings = get_settings()

_MAX_NAME = 180


def safe_filename(name: str | None) -> str:
    """User-supplied filename -> a single safe path segment."""
    base = unicodedata.normalize("NFC", (name or "upload"))
    base = base.replace("\\", "/").split("/")[-1]
    base = "".join(ch for ch in base if ch >= " " and ch not in '<>:"|?*')
    base = base.strip().strip(".")
    if not base:
        base = "upload"
    if len(base) > _MAX_NAME:
        stem, dot, ext = base.rpartition(".")
        if dot and len(ext) <= 10:
            base = stem[: _MAX_NAME - len(ext) - 1] + "." + ext
        else:
            base = base[:_MAX_NAME]
    return base


def _root() -> Path:
    return Path(settings.storage_dir).resolve()


def resolve(key: str) -> Path:
    """Storage key -> absolute path inside STORAGE_DIR (or 400)."""
    parts = [p for p in (key or "").replace("\\", "/").split("/") if p]
    bad = (
        not parts
        or any(p in (".", "..") or "\x00" in p for p in parts)
    )
    root = _root()
    path = root.joinpath(*parts).resolve() if not bad else None
    if path is None or (path != root and root not in path.parents):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid storage path."
        )
    return path


def _write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, path)


async def save(key: str, data: bytes) -> None:
    await asyncio.to_thread(_write, resolve(key), data)


async def read(key: str) -> bytes:
    path = resolve(key)
    try:
        return await asyncio.to_thread(path.read_bytes)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Stored file not found."
        ) from exc


def _remove(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        return
    # Drop now-empty {file_id}/ and {owner_id}/ directories (best-effort).
    root = _root()
    for parent in (path.parent, path.parent.parent):
        if parent == root or root not in parent.parents:
            break
        try:
            parent.rmdir()
        except OSError:
            break


async def delete(key: str) -> None:
    """Remove an object; a missing object is fine (already gone)."""
    await asyncio.to_thread(_remove, resolve(key))


def copy_seed_uploads() -> int:
    """Copy bundled seed files into STORAGE_DIR when missing (startup, sync)."""
    src = settings.seed_uploads_dir
    if not src:
        return 0
    src_root = Path(src)
    if not src_root.is_dir():
        return 0
    root = _root()
    copied = 0
    for file in src_root.rglob("*"):
        if not file.is_file() or file.name.startswith("."):
            continue
        rel = file.relative_to(src_root).as_posix()
        try:
            dest = resolve(rel)
        except HTTPException:
            continue
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, dest)
        copied += 1
    if copied:
        logger.info("Copied %d seed upload(s) into %s", copied, root)
    return copied
