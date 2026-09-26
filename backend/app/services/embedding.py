"""Gemini embeddings + text chunking (Stage 3b-1).

Uses gemini-embedding-001 at output_dimensionality=768 (matches the
file_chunks.embedding vector(768) column). Reduced-dimension outputs are not
pre-normalized by the model, so we L2-normalize for stable cosine/IP search.
"""

from __future__ import annotations

import logging
import math
import re

from google.genai import types

from ..config import get_settings
from . import app_settings
from .gemini import ai_session

logger = logging.getLogger("nodi.embedding")
settings = get_settings()

# The file_chunks.embedding column is a FIXED vector(768) (baseline schema). The
# file pipeline guards against an admin setting embedding_dimension to any
# other value (it would make insert/search fail or be meaningless) — see
# file_pipeline. This constant is the contract that guard checks against.
DB_VECTOR_DIM = 768


def _l2_normalize(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0:
        return vec
    return [v / norm for v in vec]


async def embed_texts(
    texts: list[str],
    *,
    api_key: str | None,
    task_type: str = "RETRIEVAL_DOCUMENT",
    model: str | None = None,
    dimension: int | None = None,
) -> list[list[float]]:
    """Embed a list of texts -> list of L2-normalized vectors.

    Sub-batches by `embedding_request_max_chunks` per embed_content call.

    D62: `model`/`dimension` default to the admin overlay (falling back to
    config) so model/dimension changes take effect. Callers that have already
    resolved (and guarded) these values — the file pipeline — pass them
    explicitly; the query path (rag.search) leaves them None to auto-resolve,
    keeping query and document embeddings in the SAME space.

    `api_key` is the caller's own Gemini key (X-Gemini-Key); GeminiKeyError
    when absent.
    """
    if not texts:
        return []
    if model is None or dimension is None:
        overlay = await app_settings.get_overlay()
        if model is None:
            model = app_settings.as_str(
                overlay, "embedding_model", settings.gemini_embedding_model
            )
        if dimension is None:
            dimension = app_settings.as_int(
                overlay, "embedding_dimension", settings.embedding_dimension, 1, 10000
            )
    out: list[list[float]] = []
    step = max(1, settings.embedding_request_max_chunks)
    async with ai_session(api_key) as aio:
        for i in range(0, len(texts), step):
            batch = texts[i : i + step]
            resp = await aio.models.embed_content(
                model=model,
                contents=batch,
                config=types.EmbedContentConfig(
                    output_dimensionality=dimension,
                    task_type=task_type,
                ),
            )
            for emb in resp.embeddings:
                out.append(_l2_normalize(list(emb.values)))
    return out


# ---------------------------------------------------------------------------
# Text chunking
# ---------------------------------------------------------------------------
_PARA_SPLIT = re.compile(r"\n\s*\n")


def _hard_split(text: str, size: int, overlap: int) -> list[str]:
    """Fixed-window split with overlap for an over-long paragraph."""
    chunks: list[str] = []
    start = 0
    n = len(text)
    step = max(1, size - overlap)
    while start < n:
        chunks.append(text[start : start + size])
        start += step
    return chunks


def chunk_text(
    text: str, size: int | None = None, overlap: int | None = None
) -> list[str]:
    """Greedy paragraph-aware chunker with character overlap.

    Accumulates paragraphs up to `size`; paragraphs longer than `size` are
    hard-split. Carries `overlap` trailing chars between adjacent chunks for
    context continuity.
    """
    size = size or settings.chunk_size_chars
    overlap = overlap if overlap is not None else settings.chunk_overlap_chars
    text = (text or "").strip()
    if not text:
        return []

    paragraphs = [p.strip() for p in _PARA_SPLIT.split(text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for para in paragraphs:
        if len(para) > size:
            if buf:
                chunks.append(buf)
                buf = ""
            chunks.extend(_hard_split(para, size, overlap))
            continue
        if buf and len(buf) + 1 + len(para) > size:
            chunks.append(buf)
            # carry overlap from the end of the flushed chunk
            tail = buf[-overlap:] if overlap else ""
            buf = (tail + "\n" + para).strip() if tail else para
        else:
            buf = f"{buf}\n{para}".strip() if buf else para
    if buf:
        chunks.append(buf)
    return [c for c in (c.strip() for c in chunks) if c]
