"""Automatic concept tagging (Stage 2 Part A).

Extract 1..3 short concept tags from a finished (question, answer) pair with a
lightweight Gemini model, then reuse-or-create them in the node's space and link
them to the node via the upsert_node_tags() RPC (migration 0005).

Everything here is BEST-EFFORT: tagging must never break chat. Failures return
empty / are swallowed with a server-side log.
"""

from __future__ import annotations

import json
import logging
import re
import unicodedata

from google.genai import types

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings
from .gemini import ai_session

logger = logging.getLogger("nodi.tagging")
settings = get_settings()

_TAG_PROMPT = (
    "LANGUAGE RULE (most important): write EVERY tag in the SAME language as the "
    "Q&A below. Do NOT translate to any other language.\n"
    "Extract the {max_tags} most important CONCEPTS discussed in this Q&A as "
    "short noun phrases (1-3 words each). Rules: between 1 and {max_tags} tags; "
    "prefer specific, meaningful concepts over generic words (avoid words like "
    "'question', 'answer', 'explanation', 'information'); no duplicates; no "
    "surrounding punctuation. Return ONLY a JSON array of strings (the strings "
    "MUST be in the input's language).\n\n"
    "Q: {question}\nA: {answer}"
)


_PUNCT_EDGES_RE = re.compile(r"^[\s\W_]+|[\s\W_]+$", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def _norm_key(name: str) -> str:
    """Mirror the DB `nodi_norm_tag` rule for in-response dedup (D30):
    NFKC -> casefold -> collapse whitespace -> strip surrounding punctuation."""
    s = unicodedata.normalize("NFKC", name).casefold()
    s = _WS_RE.sub(" ", s)
    s = _PUNCT_EDGES_RE.sub("", s).strip()
    return s


def _parse_tags(raw: str, max_tags: int) -> list[str]:
    """Parse the model's JSON array into a clean, deduped, capped list.

    Dedup uses the same normalization as the DB (`nodi_norm_tag`), so 표기 variants
    ("Python" / "python" / "파이썬 ") collapse to one within a single response —
    complementing the DB-side norm_name reuse in upsert_*_tags (D30)."""
    text = (raw or "").strip()
    # Tolerate code fences if the model adds them.
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("[") :] if "[" in text else text
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    seen: set[str] = set()
    out: list[str] = []
    for item in data:
        if not isinstance(item, str):
            continue
        name = item.strip().strip('"').strip()
        if not name or len(name) > 40:
            continue
        key = _norm_key(name)
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(name)
        if len(out) >= max_tags:
            break
    return out


async def extract_concepts(
    question: str, answer: str, api_key: str | None
) -> list[str]:
    """Return 1..max_tags concept strings (empty list on any failure)."""
    overlay = await app_settings.get_overlay()
    max_tags = app_settings.as_int(
        overlay, "max_tags_per_node", settings.max_tags_per_node, 1, 5
    )
    prompt = _TAG_PROMPT.format(
        max_tags=max_tags, question=question, answer=answer
    )
    try:
        async with ai_session(api_key) as aio:
            resp = await aio.models.generate_content(
                model=app_settings.as_str(
                    overlay, "tag_model", settings.gemini_tag_model
                ),
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    max_output_tokens=120,
                    temperature=0.2,
                ),
            )
        return _parse_tags(resp.text or "", max_tags)
    except Exception as exc:  # noqa: BLE001 - tagging must never break chat
        logger.warning("Concept extraction failed: %s", exc)
        return []


_FILE_TAG_PROMPT = (
    "LANGUAGE RULE (most important): write EVERY tag in the SAME language as the "
    "document excerpt below. Do NOT translate to any other language.\n"
    "Extract up to {max_tags} key CONCEPTS from the document excerpt as short "
    "noun phrases (1-3 words each). Files are tagged densely (many concepts). "
    "Rules: specific, meaningful concepts only (avoid generic words like "
    "'document', 'introduction', 'information'); no duplicates; no surrounding "
    "punctuation. Return ONLY a JSON array of strings.\n\n"
    "Document excerpt:\n{text}"
)


async def extract_file_concepts(text: str, api_key: str | None) -> list[str]:
    """Extract up to file_tag_max concept strings from file text (best-effort)."""
    max_tags = settings.file_tag_max
    excerpt = (text or "").strip()[: settings.file_tag_sample_chars]
    if not excerpt:
        return []
    prompt = _FILE_TAG_PROMPT.format(max_tags=max_tags, text=excerpt)
    try:
        overlay = await app_settings.get_overlay()
        async with ai_session(api_key) as aio:
            resp = await aio.models.generate_content(
                model=app_settings.as_str(
                    overlay, "tag_model", settings.gemini_tag_model
                ),
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    max_output_tokens=1000,
                    temperature=0.3,
                ),
            )
        return _parse_tags(resp.text or "", max_tags)
    except Exception as exc:  # noqa: BLE001 - tagging must never break indexing
        logger.warning("File concept extraction failed: %s", exc)
        return []


async def apply_node_tags(
    client: UserClient, node_id: str, session_id: str, names: list[str]
) -> list[str]:
    """Reuse-or-create tags and link to the node. Returns stored tag names."""
    if not names:
        return []
    result = await client.rpc(
        "upsert_node_tags",
        {"p_node_id": node_id, "p_session_id": session_id, "p_names": names},
    )
    # RPC returns text[] (the stored names attached).
    if isinstance(result, list):
        return [n for n in result if isinstance(n, str)]
    return []


async def tag_node(
    client: UserClient,
    node_id: str,
    session_id: str,
    question: str,
    answer: str,
    api_key: str | None,
) -> list[str]:
    """Full best-effort pipeline: extract -> upsert/link. Never raises."""
    try:
        names = await extract_concepts(question, answer, api_key)
        return await apply_node_tags(client, node_id, session_id, names)
    except Exception:  # noqa: BLE001
        logger.exception("Tagging failed for node=%s", node_id)
        return []
