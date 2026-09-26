"""Overseer (총괄 AI) — home, LINEAR context (architecture §7).

Builds a workspace snapshot by calling the read-skills (access-checked, traced
via the ReActRunner), streams a short navigational reply, and proposes structured
ACTIONS (buttons) the frontend renders:

  - {action: "create_session", label, space_kind, space_ref, seed_question}
      "새 대화방 만들까요?" — start a new conversation seeded with the question.
  - {action: "open_session", label, session_id}
      jump to an existing session that matches the topic.

Actions are SUGGESTIONS only; the actual create uses POST /sessions, the open is
a frontend navigation. The overseer never writes.
"""

from __future__ import annotations

import logging
from typing import Any

from ..ai.react import Budget, ReActRunner
from ..ai.skills.base import SkillContext
from ..config import get_settings
from . import app_settings
from ..db.client import UserClient

logger = logging.getLogger("nodi.overseer")
settings = get_settings()


def _build_snapshot(
    spaces: list[dict[str, Any]],
    recents: list[dict[str, Any]],
    concepts: list[dict[str, Any]],
    matches: dict[str, Any],
) -> str:
    lines: list[str] = []
    if spaces:
        lines.append(
            "공간: "
            + ", ".join(f"{s.get('name')}({s.get('space_kind')})" for s in spaces)
        )
    if recents:
        lines.append(
            "최근 세션: "
            + ", ".join(f"{r.get('title') or '제목없음'}" for r in recents[:8])
        )
    if concepts:
        lines.append(
            "자주 쓰는 개념: "
            + ", ".join(
                f"{c.get('name')}({c.get('usage_count')})" for c in concepts[:8]
            )
        )
    matched = (matches or {}).get("sessions") or []
    if matched:
        lines.append(
            "이 주제와 관련된 기존 세션: "
            + ", ".join(f"{m.get('title') or '제목없음'}" for m in matched)
        )
    return "\n".join(lines) if lines else "(아직 활동 내역이 없습니다.)"


async def gather(
    client: UserClient, owner_id: str, message: str
) -> dict[str, Any]:
    """Run the read-skills to assemble the snapshot + raw data for actions."""
    ctx = SkillContext(client=client, owner_id=owner_id)
    # D62: ReAct budget is admin-tunable via the overlay.
    overlay = await app_settings.get_overlay()
    runner = ReActRunner(
        client,
        owner_id,
        kind="overseer",
        session_id=None,
        budget=Budget(
            app_settings.as_int(
                overlay, "react_max_steps", settings.react_max_steps, 1, 100
            ),
            app_settings.as_int(
                overlay,
                "react_max_tokens",
                settings.react_max_tokens,
                1000,
                1_000_000,
            ),
        ),
    )
    spaces = (await runner.run_skill("read_my_spaces", ctx=ctx)).get("spaces", [])
    recents = (
        await runner.run_skill("read_recent_sessions", ctx=ctx, limit=8)
    ).get("sessions", [])
    concepts = (
        await runner.run_skill("read_top_concepts", ctx=ctx, limit=8)
    ).get("concepts", [])
    matches = await runner.run_skill(
        "find_sessions_by_topic", ctx=ctx, query=message, limit=3
    )
    snapshot = _build_snapshot(spaces, recents, concepts, matches)
    return {
        "snapshot": snapshot,
        "spaces": spaces,
        "recents": recents,
        "concepts": concepts,
        "matches": matches,
    }


def build_actions(
    owner_id: str, message: str, data: dict[str, Any]
) -> list[dict[str, Any]]:
    """Deterministic action suggestions from the snapshot (no extra LLM call)."""
    actions: list[dict[str, Any]] = [
        {
            "action": "create_session",
            "label": "이 질문으로 새 대화 시작",
            "space_kind": "personal",
            "space_ref": owner_id,
            "seed_question": message,
        }
    ]
    for m in (data.get("matches") or {}).get("sessions", [])[:3]:
        if m.get("id"):
            actions.append(
                {
                    "action": "open_session",
                    "label": f"기존 세션 열기: {m.get('title') or '제목없음'}",
                    "session_id": m["id"],
                }
            )
    return actions
