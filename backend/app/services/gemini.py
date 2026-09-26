"""Gemini access (google-genai).

Stage 1 scope: stream a chat answer over an ancestor-chain context, and produce
a short (<=10 char intent) label for a finished (question, answer) node.
No tools / ReAct / RAG here — that is Stage 2+.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from google import genai
from google.genai import types

from ..ai_key import GeminiKeyError, classify_ai_error
from ..config import get_settings
from . import app_settings

logger = logging.getLogger("nodi.gemini")
settings = get_settings()

# A system instruction kept deliberately generic: nodi's AI is a general
# conversational assistant; the tree is only a UX layer (no topic restriction).
_SYSTEM_INSTRUCTION = (
    "You are nodi's assistant, a helpful general-purpose conversational AI. "
    "Answer the user's latest message using the prior conversation as context. "
    "Respond in the user's language."
)

@asynccontextmanager
async def ai_session(api_key: str | None):
    """Per-call async Gemini client built from the CALLER'S key.

    No module-level client: the key is user-supplied per request (X-Gemini-Key)
    and must never outlive the request. Raises GeminiKeyError when absent.
    """
    if not api_key:
        raise GeminiKeyError()
    client = genai.Client(api_key=api_key)
    try:
        yield client.aio
    finally:
        try:
            await client.aio.aclose()
        except Exception:  # noqa: BLE001 - closing is best-effort
            pass
        try:
            client.close()
        except Exception:  # noqa: BLE001
            pass


def _build_contents(
    history: list[tuple[str, str]], question: str
) -> list[types.Content]:
    """history = ordered [(question, answer), ...] from root to parent."""
    contents: list[types.Content] = []
    for q, a in history:
        if q:
            contents.append(
                types.Content(role="user", parts=[types.Part.from_text(text=q)])
            )
        if a:
            contents.append(
                types.Content(role="model", parts=[types.Part.from_text(text=a)])
            )
    contents.append(
        types.Content(role="user", parts=[types.Part.from_text(text=question)])
    )
    return contents


# Per-block instruction wrappers. The wrapper text + its context together form
# one prompt "part"; parts are joined with "\n\n". Keeping the exact strings in
# one place lets compose_system_structured() report each part's char span (D35).
_WRAP_MEMORY = (
    "아래는 사용자가 다른 대화 분기에서 끌어온 참고 자료입니다. 현재 분기 "
    "대화와 출처를 구분해 활용하되, 답변에 자연스럽게 반영하세요. 현재 "
    "분기에서 실제로 오간 대화가 아님에 유의하세요.\n\n"
)
_WRAP_RAG = (
    "아래는 사용자가 이 분기에 연결한 자료에서 검색된 내용입니다. 질문과 "
    "관련된 근거로 우선 활용하고, 자료에 없는 내용은 일반 지식으로 보완하되 "
    "출처를 구분하세요.\n\n"
)
_WRAP_COMPARISON = (
    "아래는 사용자가 이번 질문에서만 비교 목적으로 참조한 다른 분기들의 "
    "내용입니다. 현재 분기와 비교/대조해 답하되, 출처를 구분하세요.\n\n"
)


def compose_system_structured(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
    *,
    rag_sources: list[dict] | None = None,
    reference_node_ids: list[str] | None = None,
    comparison_node_ids: list[str] | None = None,
) -> tuple[str, list[dict]]:
    """Single source of truth (D35): build the system prompt AND the per-block
    metadata (kind/order/source/raw_text/node_ids/sources/prompt_span) in one
    place, so the saved prompt and the highlight offsets can never drift.

    - `reference_context`: imported other-branch content (Stage 3a memory link).
    - `rag_context`: chunks from files linked to the branch (Stage 3b-2 RAG).
    - `comparison_context`: one-time referenced branches for comparison (D15).

    Returns ``(system_prompt, blocks)`` where each block's ``prompt_span`` is the
    ``[start, end)`` char range of that part inside ``system_prompt``.
    """
    # (kind, segment_text, source, raw_text, node_ids, sources)
    parts: list[tuple[str, str, str | None, str | None, list | None, list | None]] = [
        ("system_base", _SYSTEM_INSTRUCTION, None, None, None, None)
    ]
    if reference_context:
        parts.append(
            (
                "memory_link",
                _WRAP_MEMORY + reference_context,
                "다른 분기 노드(기억 연결)",
                reference_context,
                reference_node_ids or None,
                None,
            )
        )
    if rag_context:
        parts.append(
            (
                "rag",
                _WRAP_RAG + rag_context,
                "이 분기에 연결한 자료",
                rag_context,
                None,
                rag_sources or [],
            )
        )
    if comparison_context:
        parts.append(
            (
                "comparison",
                _WRAP_COMPARISON + comparison_context,
                "이번 질문 한정 비교 참조",
                comparison_context,
                comparison_node_ids or None,
                None,
            )
        )

    system_prompt = "\n\n".join(p[1] for p in parts)

    blocks: list[dict] = []
    cursor = 0
    sep = len("\n\n")
    for order, (kind, seg, source, raw_text, node_ids, sources) in enumerate(parts):
        start = cursor
        end = start + len(seg)
        block: dict = {"kind": kind, "order": order, "prompt_span": [start, end]}
        if source:
            block["source"] = source
        if raw_text:
            block["raw_text"] = raw_text
        if node_ids:
            block["node_ids"] = node_ids
        if sources is not None:
            block["sources"] = sources
        blocks.append(block)
        cursor = end + sep
    return system_prompt, blocks


# Public alias so callers (e.g. turn logging) can capture the exact system
# prompt that stream_answer will use.
def compose_system_instruction(
    reference_context: str | None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
) -> str:
    return compose_system_structured(
        reference_context, rag_context, comparison_context
    )[0]


async def stream_answer(
    history: list[tuple[str, str]],
    question: str,
    *,
    api_key: str,
    reference_context: str | None = None,
    rag_context: str | None = None,
    comparison_context: str | None = None,
) -> AsyncIterator[str]:
    """Yield answer text deltas for the SSE `token` events.

    `reference_context` = imported other-branch content (Stage 3a).
    `rag_context` = chunks from files linked to the branch (Stage 3b-2).
    `comparison_context` = one-time referenced branches for comparison (D15).
    All are injected separately from the live ancestor chain.
    """
    contents = _build_contents(history, question)
    config = types.GenerateContentConfig(
        system_instruction=compose_system_instruction(
            reference_context, rag_context, comparison_context
        )
    )
    overlay = await app_settings.get_overlay()
    async with ai_session(api_key) as aio:
        stream = await aio.models.generate_content_stream(
            model=app_settings.as_str(
                overlay, "chat_model", settings.gemini_chat_model
            ),
            contents=contents,
            config=config,
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text


_OCR_PROMPT = (
    "Extract ALL readable text from this image, preserving reading order and "
    "line/paragraph breaks. Output ONLY the extracted text (no commentary). "
    "If there is no readable text, output nothing."
)


async def ocr_image_bytes(data: bytes, mime: str, api_key: str | None) -> str:
    """OCR an image with the multimodal model. Returns '' on failure/empty."""
    try:
        overlay = await app_settings.get_overlay()
        async with ai_session(api_key) as aio:
            resp = await aio.models.generate_content(
                model=app_settings.as_str(overlay, "ocr_model", settings.ocr_model),
                contents=[
                    types.Part.from_bytes(data=data, mime_type=mime),
                    types.Part.from_text(text=_OCR_PROMPT),
                ],
                config=types.GenerateContentConfig(
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
        return (resp.text or "").strip()
    except Exception as exc:  # noqa: BLE001 - OCR failure surfaces as empty text
        logger.warning("Image OCR failed: %s", exc)
        return ""


async def generate_label(
    question: str, answer: str, api_key: str | None
) -> str | None:
    """Short topic label for a node. Best-effort: returns None on failure."""
    overlay = await app_settings.get_overlay()
    max_chars = app_settings.as_int(
        overlay, "node_label_max_chars", settings.node_label_max_chars, 4, 16
    )
    prompt = (
        "LANGUAGE RULE (most important): write the label in the SAME language as "
        "the QUESTION below. Do NOT translate to any other language.\n"
        "Summarize the topic of this Q&A as a very short label of at most "
        f"{max_chars} characters. Output ONLY the label, no quotes, no "
        "punctuation at the end.\n\n"
        f"Q: {question}\nA: {answer}"
    )
    try:
        async with ai_session(api_key) as aio:
            resp = await aio.models.generate_content(
                model=app_settings.as_str(
                    overlay, "label_model", settings.gemini_label_model
                ),
                contents=prompt,
                config=types.GenerateContentConfig(
                    max_output_tokens=20, temperature=0.0
                ),
            )
        text = (resp.text or "").strip().strip('"').strip()
        if not text:
            return None
        # Hard-enforce the length cap (design: <=10 chars).
        return text[:max_chars]
    except Exception as exc:  # noqa: BLE001 - labeling must never break chat
        logger.warning("Label generation failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Overseer (home, linear context) — architecture §7
# ---------------------------------------------------------------------------
_OVERSEER_INSTRUCTION = (
    "You are nodi's overseer — the assistant on the home screen. You do NOT "
    "answer the topic in depth; instead you help the user NAVIGATE their "
    "workspaces and decide where to take a question. Use the workspace snapshot "
    "below (spaces, recent sessions, top concepts, topic matches) to give a "
    "short, friendly reply in the user's language. If the user asks a "
    "substantive/concept question, suggest starting a NEW conversation for it; "
    "if it relates to an existing session, point them there. Keep it concise; "
    "the concrete buttons are provided separately by the app."
)


async def stream_overseer(
    snapshot: str, message: str, api_key: str
) -> AsyncIterator[str]:
    """Stream the overseer's short navigational reply (token events)."""
    system = _OVERSEER_INSTRUCTION + "\n\n[워크스페이스 스냅샷]\n" + snapshot
    contents = [
        types.Content(role="user", parts=[types.Part.from_text(text=message)])
    ]
    overlay = await app_settings.get_overlay()
    async with ai_session(api_key) as aio:
        stream = await aio.models.generate_content_stream(
            model=app_settings.as_str(
                overlay, "chat_model", settings.gemini_chat_model
            ),
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=600,
            ),
        )
        async for chunk in stream:
            if chunk.text:
                yield chunk.text


def _parse_json_array(raw: str, n: int) -> list[str]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        text = text[text.find("[") :] if "[" in text else text
    try:
        data = json.loads(text)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, list):
        return []
    out: list[str] = []
    for item in data:
        if isinstance(item, str) and item.strip():
            out.append(item.strip().strip('"').strip())
        if len(out) >= n:
            break
    return out


async def generate_home_suggestions(
    concepts: list[str], recent_titles: list[str], count: int, api_key: str
) -> list[str]:
    """Propose `count` starter questions from the user's concepts/activity.

    Best-effort: returns [] on failure (home still renders without suggestions).
    """
    prompt = (
        f"Propose exactly {count} SHORT, engaging starter questions a learner "
        "might want to explore next, in the user's language. Base them on the "
        "user's frequent concepts and recent activity. Make them specific and "
        "distinct. Return ONLY a JSON array of strings.\n\n"
        f"Frequent concepts: {', '.join(concepts) if concepts else '(none)'}\n"
        f"Recent sessions: {', '.join(recent_titles) if recent_titles else '(none)'}"
    )
    try:
        overlay = await app_settings.get_overlay()
        async with ai_session(api_key) as aio:
            resp = await aio.models.generate_content(
                model=app_settings.as_str(
                    overlay, "navigator_model", settings.gemini_navigator_model
                ),
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                    max_output_tokens=400,
                    temperature=0.8,
                ),
            )
        return _parse_json_array(resp.text or "", count)
    except Exception as exc:  # noqa: BLE001 - suggestions are optional
        # A bad key / exhausted quota is surfaced so the UI can say so; any
        # other failure just means "no suggestions this time".
        code = classify_ai_error(exc)
        if code:
            raise GeminiKeyError(code) from None
        logger.warning("Home suggestion generation failed: %s", exc)
        return []
