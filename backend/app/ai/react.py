"""Minimal ReAct runner (Stage 2 Part B skeleton).

Runs skills under a Budget (max steps / tokens) and writes a best-effort trace
(ai_sessions / ai_steps). This is intentionally small: a single scripted plan is
enough to exercise the registry + trace structure. Stage 4 replaces the scripted
planner with an LLM planner driving a multi-step thought->skill->observation
loop, plus confirmation_required gates for write-skills.

Tracing is BEST-EFFORT: if the ai_* tables are absent or the access layer
rejects a write, the run still proceeds — trace failures only log.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..db.client import UserClient
from .skills import get_skill

logger = logging.getLogger("nodi.ai.react")


@dataclass
class Budget:
    max_steps: int
    max_tokens: int
    steps_used: int = 0
    tokens_used: int = 0

    def exceeded(self) -> bool:
        return self.steps_used >= self.max_steps or self.tokens_used >= self.max_tokens

    def charge(self, tokens: int | None) -> None:
        self.steps_used += 1
        if tokens:
            self.tokens_used += int(tokens)


@dataclass
class RunResult:
    ai_session_id: str | None
    observations: list[dict[str, Any]] = field(default_factory=list)


class ReActRunner:
    """Owns a per-run trace + budget. Call `run_skill` one or more times."""

    def __init__(
        self,
        client: UserClient,
        owner_id: str,
        kind: str,
        session_id: str | None,
        budget: Budget,
    ):
        self._client = client
        self._owner_id = owner_id
        self._kind = kind
        self._session_id = session_id
        self.budget = budget
        self.ai_session_id: str | None = None
        self._seq = 0

    async def _ensure_trace(self) -> None:
        if self.ai_session_id is not None:
            return
        try:
            row = await self._client.insert(
                "ai_sessions",
                {
                    "owner_id": self._owner_id,
                    "session_id": self._session_id,
                    "kind": self._kind,
                },
            )
            self.ai_session_id = row.get("id")
        except Exception:  # noqa: BLE001 - tracing is best-effort
            logger.warning("ai_sessions trace unavailable; continuing untraced")

    async def _record_step(
        self,
        skill: str,
        thought: str | None,
        skill_input: dict,
        observation: dict,
        tokens: int | None,
    ) -> None:
        await self._ensure_trace()
        if self.ai_session_id is None:
            return
        self._seq += 1
        try:
            await self._client.insert(
                "ai_steps",
                {
                    "ai_session_id": self.ai_session_id,
                    "seq": self._seq,
                    "thought": thought,
                    "skill": skill,
                    "input": _jsonable(skill_input),
                    "observation": _jsonable(observation),
                    "tokens": tokens,
                },
            )
        except Exception:  # noqa: BLE001
            logger.warning("ai_steps trace write failed (seq=%s)", self._seq)

    async def run_skill(
        self,
        name: str,
        *,
        thought: str | None = None,
        ctx: Any = None,
        **skill_input: Any,
    ) -> dict[str, Any]:
        """Execute one registered skill, charging the budget and tracing it.

        `ctx` (SkillContext: client + identity + Gemini key) is passed to the
        skill but kept OUT of the trace payload (no client/key in ai_steps).
        """
        if self.budget.exceeded():
            raise RuntimeError("ReAct budget exceeded")
        skill = get_skill(name)
        if skill is None:
            raise RuntimeError(f"Unknown skill: {name}")

        observation = await skill.run(ctx=ctx, **skill_input)
        tokens = (
            observation.get("tokens") if isinstance(observation, dict) else None
        )
        self.budget.charge(tokens)
        await self._record_step(name, thought, skill_input, observation, tokens)
        return observation


def _jsonable(value: Any) -> Any:
    """Coerce skill input/observation into something JSON/JSONB-safe."""
    try:
        import json

        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return {"repr": repr(value)}
