"""Home dashboard endpoints (Stage 4a).

- GET /home/summary      spaces + recent sessions + top personal concepts
- GET /home/suggestions  3 starter questions (D5: concept-based, click -> new
                         personal session seeded with the question)

Scope decision: /home/summary is account-wide (not space-scoped) — spaces across
all memberships, recent sessions across all spaces, and top concepts from the
PERSONAL space (the always-present home space). Space-scoped variants can be
added later if the home UI needs them.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query

from ..ai_key import GeminiKeyError, key_http_error, require_gemini_key
from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..db.client import UserClient
from ..services import gemini, home

router = APIRouter(prefix="/home", tags=["home"])
settings = get_settings()


@router.get("/summary")
async def home_summary(
    recent_limit: int = Query(8, ge=1, le=30),
    concept_limit: int = Query(8, ge=1, le=50),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    spaces = await home.get_my_spaces(client, user.id)
    recents = await home.get_recent_sessions(client, limit=recent_limit)
    top_concepts = await home.get_top_concepts(
        client, "personal", user.id, concept_limit
    )
    return {
        "spaces": spaces,
        "recent_sessions": recents,
        "top_concepts": top_concepts,
    }


@router.get("/suggestions")
async def home_suggestions(
    count: int = Query(3, ge=1, le=5),
    user: CurrentUser = Depends(get_current_user),
    api_key: str = Depends(require_gemini_key),
) -> dict[str, Any]:
    """D5 (1st pass): top-concept-based starter questions. Each suggestion, when
    clicked, should start a NEW personal session seeded with the question.

    AI endpoint: 400 `gemini_key_required` without `X-Gemini-Key`."""
    client = UserClient.from_user(user)
    concepts = await home.get_top_concepts(client, "personal", user.id, 10)
    recents = await home.get_recent_sessions(client, limit=8)
    try:
        questions = await gemini.generate_home_suggestions(
            [c.get("name") for c in concepts if c.get("name")],
            [r.get("title") for r in recents if r.get("title")],
            count,
            api_key,
        )
    except GeminiKeyError as exc:  # invalid key / quota -> 400 with its code
        raise key_http_error(exc.code) from None
    suggestions = [
        {
            "question": q,
            "seed_question": q,
            "space_kind": "personal",
            "space_ref": user.id,
        }
        for q in questions
    ]
    return {"suggestions": suggestions}
