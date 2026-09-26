"""Chat (SSE) — Stage 1 tree-conversation core.

Flow (architecture.md §4):
  1. Resolve parent (body.parent_node_id or session.current_head_id).
  2. Assemble ancestor-chain context (siblings excluded).
  3. Stream Gemini answer as SSE: start -> token* -> done (error on failure).
  4. Persist (question, answer) = 1 node, advance head (set root if first),
     auto-label (<=10 chars), and report the node in the `done` event.

SSE event schema:
  event: start      data: {"session_id","parent_node_id"}
  event: token      data: {"delta"}
  event: done       data: {"node":{"id","parent_id","label","tags":[...]},
                           "current_head_id","root_node_id"}
  event: navigator  data: {"nodes":[{"id","parent_id","navigator_question"}]}
  event: error      data: {"detail", "code"?}

Gemini key: the caller's own key comes in the `X-Gemini-Key` header. Without
it the stream is a single `error` event with code "gemini_key_required" (no DB
writes, no AI call). An invalid/over-quota key yields code
"gemini_key_invalid" / "gemini_quota_exceeded".

Tagging (Stage 2 Part A): after the node is persisted, concept tags are
attached and returned INLINE in the `done` event (node.tags). Label and tag
extraction run concurrently to limit added latency; tagging is best-effort
(failure -> empty tags, never an error).

Navigator (Stage 2 Part B): after `done`, a gate may fire and create waiting
is_navigator nodes; when it does, a separate `navigator` event carries them.
Generated INLINE (not a background job) with the caller's identity and key —
see services/navigator.py. Best-effort: never blocks the turn.
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..ai_key import MESSAGES, classify_ai_error, gemini_key_status
from ..auth.deps import CurrentUser, get_current_user
from ..db.client import UserClient
from ..services import gemini, memory, navigator, rag
from ..services import sessions as svc
from ..services import tagging
from ..services.turn_log import TurnLog

logger = logging.getLogger("nodi.chat")
router = APIRouter(prefix="/chat", tags=["chat"])

QUESTION_MAX_CHARS = 8000


class NavigatorOverride(BaseModel):
    """D47 per-request navigator preference (clamped server-side, navigator.py).

    All optional; missing fields fall back to the admin/config default. `enabled`
    False disables navigator generation for this turn entirely.
    """

    enabled: bool | None = None
    count: int | None = None
    gate_k: int | None = None
    period: int | None = None


class ChatStreamBody(BaseModel):
    session_id: str
    question: str = Field(min_length=1, max_length=QUESTION_MAX_CHARS)
    parent_node_id: str | None = None
    # D15: one-time branch comparison — other nodes to reference for THIS turn
    # only (not persisted, does not touch node.connections).
    reference_node_ids: list[str] | None = Field(default=None, max_length=20)
    # D47: per-request navigator override (user workspace settings).
    navigator: NavigatorOverride | None = None


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def sse_key_error(code: str) -> StreamingResponse:
    """A one-event SSE stream reporting a missing/invalid Gemini key."""

    async def one():
        yield _sse("error", {"code": code, "detail": MESSAGES[code]})

    return StreamingResponse(
        one(), media_type="text/event-stream", headers=_SSE_HEADERS
    )


def _ai_error_payload(exc: BaseException, default_detail: str) -> dict:
    code = classify_ai_error(exc)
    if code:
        return {"code": code, "detail": MESSAGES[code]}
    return {"detail": default_detail}


@router.post("/stream")
async def chat_stream(
    body: ChatStreamBody,
    user: CurrentUser = Depends(get_current_user),
    key_status: tuple[str | None, str | None] = Depends(gemini_key_status),
) -> StreamingResponse:
    api_key, key_error = key_status
    if key_error:
        # AI endpoint without a usable key: report it in-stream, touch nothing.
        return sse_key_error(key_error)
    client = UserClient.from_user(user)

    # Validate access + resolve context BEFORE streaming so auth/404 errors are
    # plain HTTP responses (not mid-stream SSE errors). Session meta and the node
    # list are independent reads -> fetch concurrently (D66). A 404 from
    # get_session still propagates out of gather as a plain HTTP error.
    session, nodes = await asyncio.gather(
        svc.get_session(client, body.session_id),
        svc.get_session_nodes(client, body.session_id),
    )

    # Only the session OWNER may write nodes. Reject up front (saves AI tokens):
    # a class teacher can SELECT a class session but must not stream into it.
    if session.get("owner_id") != user.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the session owner can chat in this session.",
        )

    parent_id = body.parent_node_id or session.get("current_head_id")
    chain = svc.ancestor_chain_nodes(nodes, parent_id)
    by_id = {n["id"]: n for n in nodes}
    history = [
        (n.get("question") or "", n.get("answer") or "")
        for n in chain
        if not n.get("is_navigator")
    ]
    # All three context builders read the same ancestor chain but are otherwise
    # independent, and each is internally best-effort (own try/except, safe
    # defaults on failure). Run them concurrently to cut first-token latency —
    # the RAG builder's question-embedding Gemini call is the heaviest leg (D66).
    #   - reference:  imported other-branch context (node connections, LCA-trimmed, 3a, D35)
    #   - rag:        chunks from files linked to this branch (Stage 3b-2, D32 sources)
    #   - comparison: one-time branch references for THIS turn (D15/D46, LCA-trimmed)
    (
        (reference_context, reference_node_ids),
        rag_result,
        (comparison_context, comparison_node_ids, comparison_sources),
    ) = await asyncio.gather(
        memory.build_reference_context(client, body.session_id, chain, by_id),
        rag.build_rag_context(client, chain, body.question, api_key),
        memory.build_comparison_context(
            client, body.reference_node_ids or [], chain, by_id
        ),
    )
    rag_context = rag_result["block"] if rag_result else None
    rag_sources = rag_result["sources"] if rag_result else []
    existing_root = session.get("root_node_id")

    # Turn log (D25) + structured prompt composition (D35). compose_system_structured
    # is the SINGLE source of truth for both the system prompt string AND each
    # block's char span, so the saved prompt and the admin highlight never drift.
    system_prompt, context_blocks = gemini.compose_system_structured(
        reference_context,
        rag_context,
        comparison_context,
        rag_sources=rag_sources,
        reference_node_ids=reference_node_ids,
        comparison_node_ids=comparison_node_ids,
    )
    tlog = TurnLog(user.id, body.session_id, body.question)
    tlog.set_system(system_prompt)
    tlog.set_contexts_structured(
        blocks=context_blocks,
        history_turns=len(history),
        history_chars=sum(len(q) + len(a) for q, a in history),
    )

    async def event_stream():
        yield _sse(
            "start",
            {"session_id": body.session_id, "parent_node_id": parent_id},
        )
        answer_parts: list[str] = []
        try:
            try:
                async for delta in gemini.stream_answer(
                    history,
                    body.question,
                    api_key=api_key,
                    reference_context=reference_context,
                    rag_context=rag_context,
                    comparison_context=comparison_context,
                ):
                    answer_parts.append(delta)
                    yield _sse("token", {"delta": delta})
            except Exception as exc:  # noqa: BLE001 - details go to logs only
                logger.exception("Gemini streaming failed")
                tlog.add_error("ai_streaming_failed")
                yield _sse(
                    "error", _ai_error_payload(exc, "AI 응답 생성에 실패했습니다.")
                )
                return

            answer = "".join(answer_parts).strip()
            if not answer:
                # Empty answer (e.g. safety block / no tokens): do NOT persist a
                # blank node or advance the head — leave the tree unchanged.
                logger.warning(
                    "Empty answer for session=%s; skipping node save.",
                    body.session_id,
                )
                tlog.add_error("empty_answer")
                yield _sse("error", {"detail": "응답을 생성하지 못했습니다."})
                return

            try:
                # Label + concept extraction run concurrently (both read Q+A).
                # Label (best-effort) is needed for the atomic node insert; tag
                # names are linked right after we have the node id.
                label, tag_names = await asyncio.gather(
                    gemini.generate_label(body.question, answer, api_key),
                    tagging.extract_concepts(body.question, answer, api_key),
                )
                node = await svc.append_node(
                    client, body.session_id, parent_id, body.question, answer, label
                )
                tlog.set_final(node["id"], answer)
                # D32/D46: persist the answer's provenance on the node so the
                # source chips can be shown when the answer is re-opened —
                # rag_sources (linked-file chunks) and reference_sources (the
                # branches this turn referenced). Both target the SAME node, so
                # write them in ONE PATCH (1 round-trip instead of 2). Best-effort
                # — a provenance write must never fail the already-saved turn.
                provenance: dict = {}
                if rag_sources:
                    provenance["rag_sources"] = rag_sources
                if comparison_sources:
                    provenance["reference_sources"] = comparison_sources
                if provenance:
                    try:
                        await client.update(
                            "nodes", {"id": f"eq.{node['id']}"}, provenance
                        )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "provenance persist failed node=%s", node["id"]
                        )
                # Best-effort: reuse-or-create + link tags. A tag failure must
                # NOT turn into a "save failed" — the node is already persisted.
                try:
                    tags = await tagging.apply_node_tags(
                        client, node["id"], body.session_id, tag_names
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("Tag application failed node=%s", node["id"])
                    tlog.add_error("tag_apply_failed")
                    tags = []
                tlog.add_skill("tagging", count=len(tags))
                yield _sse(
                    "done",
                    {
                        "node": {
                            "id": node["id"],
                            "parent_id": node.get("parent_id"),
                            "label": node.get("label"),
                            "tags": tags,
                            # D57: surface the same reference provenance we just
                            # persisted so the "참조 브랜치" chips/popup show
                            # immediately (before the trailing session refetch),
                            # matching what NODE_SELECT now reads back. [] when
                            # this turn referenced no other branch.
                            "reference_sources": comparison_sources or [],
                        },
                        "current_head_id": node["id"],
                        "root_node_id": existing_root or node["id"],
                    },
                )

                # Navigator gate (best-effort, INLINE — see navigator.py). Runs
                # AFTER `done` so the answer is already shown; only fires when the
                # branch matured. A failure never affects the saved node.
                try:
                    # navigator needs the full node list INCLUDING the
                    # just-created head node. We already hold the pre-append list
                    # (`nodes`, fetched at request start) and the new node row
                    # (append_chat_node RETURNING * — same columns), and this node
                    # is the ONLY mutation since that fetch, so append in-memory
                    # instead of a second full refetch (saves 1 round-trip).
                    all_nodes = [*nodes, node]
                    nav_nodes = await navigator.maybe_generate(
                        client,
                        user.id,
                        body.session_id,
                        node["id"],
                        all_nodes,
                        override=(
                            body.navigator.model_dump()
                            if body.navigator is not None
                            else None
                        ),
                        api_key=api_key,
                    )
                    if nav_nodes:
                        tlog.add_skill("navigator", count=len(nav_nodes))
                        yield _sse("navigator", {"nodes": nav_nodes})
                except Exception:  # noqa: BLE001 - navigator is optional
                    logger.exception("Navigator generation failed")
                    tlog.add_error("navigator_failed")
            except Exception:  # noqa: BLE001 - details to logs, not the client
                logger.exception("Persisting node failed")
                tlog.add_error("save_failed")
                yield _sse("error", {"detail": "답변 저장에 실패했습니다."})
        finally:
            # Persist the turn log exactly once (best-effort).
            await tlog.save(client)

    return StreamingResponse(
        event_stream(), media_type="text/event-stream", headers=_SSE_HEADERS
    )
