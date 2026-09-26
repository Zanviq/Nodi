"""File RAG processing — runs INSIDE the upload / retry request.

There is no server-side Gemini key and therefore no background worker: the
caller's own key (X-Gemini-Key) is only available while their request runs, so
text extraction, chunking, embedding and file tagging happen synchronously in
that request, with the key held in local variables only.

  process(file_row, data, api_key)
      extract text (PDF/text locally; images need the key for OCR)
      -> chunk -> file_chunks(pending)
      -> with key:    embed (gemini-embedding-001, 768, L2-normalized)
                      -> status 'indexed' (+ concept tags) / 'partial' / 'failed'
      -> without key: status 'needs_key' (error 'gemini_key_required'): stored
                      and chunked, but not searchable until retried with a key.
  retry(file_id, api_key)
      re-extract when there are no chunks yet, else embed the pending/failed
      chunks only.

All DB writes use the trusted ServiceClient with explicit file ids; callers
must have verified ownership first (routers/files.py does).
"""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Any

from ..ai_key import KEY_INVALID, KEY_REQUIRED, classify_ai_error
from ..config import get_settings
from ..db.client import ServiceClient
from . import app_settings, embedding, gemini, storage, tagging

logger = logging.getLogger("nodi.file_pipeline")
settings = get_settings()

_IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".gif")


def _is_image(mime: str | None, path: str) -> bool:
    return (mime or "").startswith("image/") or path.lower().endswith(_IMAGE_EXT)


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


def _pdf_text(data: bytes) -> str:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(data))
    return "\n\n".join((p.extract_text() or "") for p in reader.pages)


async def _extract_text(
    data: bytes, mime: str | None, path: str, api_key: str | None
) -> str:
    name = (path or "").lower()
    mime = mime or ""
    if _is_image(mime, name):
        if not api_key:
            return ""
        return await gemini.ocr_image_bytes(data, mime or "image/png", api_key)
    if name.endswith(".pdf") or mime.endswith("pdf"):
        try:
            # pypdf is CPU-bound: keep it off the event loop.
            return await asyncio.to_thread(_pdf_text, data)
        except Exception:  # noqa: BLE001
            logger.exception("PDF text extraction failed for %s", path)
            return ""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="ignore")


async def _set_file(svc: ServiceClient, file_id: str, **patch: Any) -> None:
    await svc.update("files", {"id": f"eq.{file_id}"}, {**patch, "updated_at": "now"})


async def _store_chunks(svc: ServiceClient, file_id: str, chunks: list[str]) -> None:
    async def go(conn):
        await conn.execute(
            "delete from public.file_chunks where file_id = $1::text::uuid", file_id
        )
        await conn.executemany(
            "insert into public.file_chunks (file_id, seq, chunk_text, status) "
            "values ($1::text::uuid, $2::int, $3::text, 'pending')",
            [(file_id, i, c) for i, c in enumerate(chunks)],
        )

    await svc.transaction(go)


async def _resolve_embedding_config() -> tuple[str, int]:
    overlay = await app_settings.get_overlay()
    dim = app_settings.as_int(
        overlay, "embedding_dimension", settings.embedding_dimension, 1, 10000
    )
    model = app_settings.as_str(
        overlay, "embedding_model", settings.gemini_embedding_model
    )
    return model, dim


async def _tag_file(svc: ServiceClient, file_id: str, api_key: str) -> None:
    """Extract up to file_tag_max concepts and link them (best-effort)."""
    try:
        rows = await svc.select(
            "file_chunks",
            {
                "file_id": f"eq.{file_id}",
                "status": "eq.embedded",
                "select": "chunk_text",
                "order": "seq.asc",
                "limit": "40",
            },
        )
        text = "\n\n".join(r.get("chunk_text") or "" for r in rows)
        names = await tagging.extract_file_concepts(text, api_key)
        if names:
            await svc.rpc("upsert_file_tags", {"p_file_id": file_id, "p_names": names})
            logger.info("Tagged file=%s with %d concepts", file_id, len(names))
    except Exception:  # noqa: BLE001 - tagging must not break indexing
        logger.exception("File tagging failed for %s", file_id)


async def _embed_pending(svc: ServiceClient, file_id: str, api_key: str) -> str:
    """Embed every pending chunk of the file; finalize status. -> final status."""
    model, dim = await _resolve_embedding_config()
    if dim != embedding.DB_VECTOR_DIM:
        # Integrity guard: the column is a fixed vector(768).
        logger.warning(
            "embedding_dimension=%s != %s; not embedding file=%s",
            dim,
            embedding.DB_VECTOR_DIM,
            file_id,
        )
        await _set_file(
            svc, file_id, status="failed", error="dimension mismatch; re-embed required"
        )
        return "failed"

    chunks = await svc.select(
        "file_chunks",
        {
            "file_id": f"eq.{file_id}",
            "status": "eq.pending",
            "select": "id,seq,chunk_text",
            "order": "seq.asc",
        },
    )
    if chunks:
        await _set_file(svc, file_id, status="embedding", error=None)
        try:
            vectors = await embedding.embed_texts(
                [c["chunk_text"] for c in chunks],
                api_key=api_key,
                task_type="RETRIEVAL_DOCUMENT",
                model=model,
                dimension=dim,
            )
        except Exception as exc:  # noqa: BLE001
            code = classify_ai_error(exc)
            logger.warning("Embedding failed file=%s (%s)", file_id, code or "error")
            if code in (KEY_INVALID, KEY_REQUIRED):
                # Chunks stay pending: a retry with a valid key recovers.
                await _set_file(svc, file_id, status="needs_key", error=code)
                return "needs_key"
            await svc.update(
                "file_chunks",
                {"file_id": f"eq.{file_id}", "status": "eq.pending"},
                {"status": "failed"},
            )
            await _finalize(svc, file_id, api_key, error=code or "embedding failed")
            return "failed"

        if len(vectors) != len(chunks):
            logger.error(
                "Embedding count mismatch file=%s: %d vectors for %d chunks",
                file_id,
                len(vectors),
                len(chunks),
            )
            await svc.update(
                "file_chunks",
                {"file_id": f"eq.{file_id}", "status": "eq.pending"},
                {"status": "failed"},
            )
            return await _finalize(svc, file_id, api_key, error="embedding count mismatch")

        async def store(conn):
            await conn.executemany(
                "update public.file_chunks set embedding = $1::text::vector, "
                "status = 'embedded' where id = $2::text::uuid",
                [(_vector_literal(v), c["id"]) for c, v in zip(chunks, vectors)],
            )

        await svc.transaction(store)
    return await _finalize(svc, file_id, api_key)


async def _finalize(
    svc: ServiceClient, file_id: str, api_key: str, error: str | None = None
) -> str:
    """Recompute progress; mark indexed/partial/failed. Tags on first 'indexed'."""
    embedded = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.embedded"}
    )
    failed = await svc.count(
        "file_chunks", {"file_id": f"eq.{file_id}", "status": "eq.failed"}
    )
    if failed > 0:
        final = "partial" if embedded > 0 else "failed"
        await _set_file(
            svc,
            file_id,
            chunk_done=embedded,
            status=final,
            error=error or "some chunks failed to embed",
        )
        return final
    rows = await svc.update(
        "files",
        {"id": f"eq.{file_id}", "status": "neq.indexed"},
        {"chunk_done": embedded, "status": "indexed", "error": None},
    )
    if rows:  # first transition to indexed -> tag once
        await _tag_file(svc, file_id, api_key)
    return "indexed"


async def process(
    svc: ServiceClient, file_row: dict[str, Any], data: bytes, api_key: str | None
) -> str:
    """Full pipeline for freshly stored bytes. Never raises; -> final status."""
    file_id = file_row["id"]
    path = file_row.get("storage_path") or ""
    mime = file_row.get("mime")
    try:
        await _set_file(svc, file_id, status="splitting", error=None)
        text = await _extract_text(data, mime, path, api_key)
        overlay = await app_settings.get_overlay()
        size = app_settings.as_int(
            overlay, "chunk_size_chars", settings.chunk_size_chars, 400, 4000
        )
        overlap = app_settings.as_int(
            overlay, "chunk_overlap_chars", settings.chunk_overlap_chars, 0, 500
        )
        chunks = await asyncio.to_thread(embedding.chunk_text, text, size, overlap)
        if not chunks:
            if _is_image(mime, path) and not api_key:
                await _set_file(
                    svc, file_id, status="needs_key", error=KEY_REQUIRED,
                    chunk_total=0, chunk_done=0,
                )
                return "needs_key"
            await _set_file(
                svc, file_id, status="failed", error="no extractable text",
                chunk_total=0, chunk_done=0,
            )
            return "failed"

        await _store_chunks(svc, file_id, chunks)
        await _set_file(svc, file_id, chunk_total=len(chunks), chunk_done=0)
        if not api_key:
            await _set_file(svc, file_id, status="needs_key", error=KEY_REQUIRED)
            return "needs_key"
        return await _embed_pending(svc, file_id, api_key)
    except Exception:  # noqa: BLE001 - the upload itself already succeeded
        logger.exception("File processing failed file=%s", file_id)
        try:
            await _set_file(svc, file_id, status="failed", error="processing failed")
        except Exception:  # noqa: BLE001
            logger.exception("Could not mark file failed")
        return "failed"


async def retry(svc: ServiceClient, file_row: dict[str, Any], api_key: str) -> str:
    """Re-process a file (ownership verified by the caller). -> action taken."""
    file_id = file_row["id"]
    total = await svc.count("file_chunks", {"file_id": f"eq.{file_id}"})
    if total == 0:
        data = await storage.read(file_row["storage_path"])
        status = await process(svc, file_row, data, api_key)
        return f"reprocessed:{status}"
    await svc.update(
        "file_chunks",
        {"file_id": f"eq.{file_id}", "status": "eq.failed"},
        {"status": "pending"},
    )
    try:
        status = await _embed_pending(svc, file_id, api_key)
    except Exception:  # noqa: BLE001
        logger.exception("Retry failed file=%s", file_id)
        await _set_file(svc, file_id, status="failed", error="processing failed")
        status = "failed"
    return f"reembedded:{status}"
