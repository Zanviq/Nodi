"""Skill: generate_navigator_questions.

Given a branch summary (the ancestor-chain Q&A) and the branch's shared concept
tags, propose a few related follow-up questions that deepen or branch the
current topic, EACH with a short rationale ("what this question reveals", D40).
Read-only (no DB writes). One model call produces both question + rationale —
no extra call when the user opens the navigator popup.

Returns {"questions": [{"question": str, "rationale": str}, ...]}.
"""

from __future__ import annotations

import json
import logging

from google.genai import types

from ...config import get_settings
from ...services.gemini import ai_session
from .base import Skill, SkillContext

logger = logging.getLogger("nodi.ai.navigator_skill")
settings = get_settings()

_PROMPT = (
    "You are nodi's navigator. Based on the conversation branch below and its "
    "key concepts, propose exactly {n} SHORT follow-up questions (in the same "
    "language as the conversation) that a curious learner would naturally ask "
    "next — to deepen, contrast, or extend the topic. Make them specific and "
    "distinct from each other; do not repeat questions already asked.\n"
    "For EACH question add a very short rationale (<= 40 characters, same "
    "language) describing what the learner would LEARN by asking it.\n"
    'Return ONLY a JSON array of {n} objects, each '
    '{{"question": "...", "rationale": "..."}}.\n\n'
    "Key concepts: {tags}\n\n"
    "Conversation branch (oldest first):\n{branch}"
)


def _format_branch(branch: list[tuple[str, str]]) -> str:
    lines: list[str] = []
    for q, a in branch:
        if q:
            lines.append(f"Q: {q}")
        if a:
            # keep the prompt compact
            lines.append(f"A: {a[:400]}")
    return "\n".join(lines) if lines else "(empty)"


def _parse(raw: str, n: int) -> list[dict[str, str]]:
    """Parse the model output into [{question, rationale}].

    Robust to: code fences, an array of objects (preferred), or an array of bare
    strings (degenerate fallback → rationale left empty so the popup still works).
    """
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
    out: list[dict[str, str]] = []
    for item in data:
        if isinstance(item, dict):
            q = str(item.get("question") or "").strip().strip('"').strip()
            r = str(item.get("rationale") or "").strip()
        elif isinstance(item, str):
            q, r = item.strip().strip('"').strip(), ""
        else:
            continue
        if q:
            out.append({"question": q, "rationale": r[:40]})
        if len(out) >= n:
            break
    return out


async def run(
    *,
    branch: list[tuple[str, str]],
    tags: list[str],
    count: int | None = None,
    model: str | None = None,
    ctx: SkillContext | None = None,
    **_: object,
) -> dict:
    n = count or settings.navigator_question_count
    # D62/D64: caller (navigator.maybe_generate) resolves the model from the
    # admin overlay and passes it; fall back to config when absent.
    model = model or settings.gemini_navigator_model
    prompt = _PROMPT.format(
        n=n,
        tags=", ".join(tags) if tags else "(none)",
        branch=_format_branch(branch),
    )
    async with ai_session(ctx.api_key if ctx else None) as aio:
        resp = await aio.models.generate_content(
            model=model,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                # Disable "thinking" (on by default for 2.5-flash) so the token
                # budget produces the answer, not internal reasoning.
                thinking_config=types.ThinkingConfig(thinking_budget=0),
                max_output_tokens=1000,
                temperature=0.7,
            ),
        )
    tokens = None
    usage = getattr(resp, "usage_metadata", None)
    if usage is not None:
        tokens = getattr(usage, "total_token_count", None)
    return {"questions": _parse(resp.text or "", n), "tokens": tokens}


SKILL = Skill(
    name="generate_navigator_questions",
    description=(
        "Propose related follow-up questions for the current conversation "
        "branch, using its shared concept tags. Read-only."
    ),
    run=run,
    writes=False,
)
