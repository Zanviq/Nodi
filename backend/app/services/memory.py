"""Node memory linking — LCA-aware imported context (Stage 3a).

A node's `connections uuid[]` lists OTHER-branch nodes the user pulled into the
current branch (architecture §4/§5). When assembling chat context we:

  - gather the connections declared by any node on the current branch
    (head -> root ancestor chain);
  - for each connected node C:
      * SAME session  -> find the LCA of C and the current head, and import only
        the nodes BELOW the LCA on C's side (LCA excluded), i.e. what happened on
        the other branch that the AI does not already know from the shared
        ancestor chain;
      * DIFFERENT session -> no shared ancestor, so import C's full chain
        (root -> C) from that session;
  - exclude anything already on the current branch, cap the total, and render a
    SOURCE-LABELLED reference block injected separately from the live branch.

Everything is best-effort: failure -> no imported context, never breaks chat.
All reads use the caller's access-checked client (own data only).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import get_settings
from ..db.client import UserClient

logger = logging.getLogger("nodi.memory")
settings = get_settings()

_IMPORT_SELECT = "id,session_id,parent_id,question,answer,label,is_navigator"


def _same_session_segment(
    by_id: dict[str, dict[str, Any]],
    current_chain_ids: set[str],
    source_id: str,
) -> list[dict[str, Any]]:
    """Nodes from `source` up to (excluding) the LCA, returned top->source.

    The LCA is the first ancestor of `source` that lies on the current branch.
    """
    seg: list[dict[str, Any]] = []
    cursor = by_id.get(source_id)
    guard = 0
    while cursor is not None and guard < 10000:
        if cursor["id"] in current_chain_ids:
            break  # reached the LCA (shared ancestor) — exclude it and stop
        seg.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    seg.reverse()  # chronological: just-below-LCA ... source
    return seg


def _full_chain(
    by_id: dict[str, dict[str, Any]], source_id: str
) -> list[dict[str, Any]]:
    """Full ancestor chain root -> source (for a different session)."""
    seg: list[dict[str, Any]] = []
    cursor = by_id.get(source_id)
    guard = 0
    while cursor is not None and guard < 10000:
        seg.append(cursor)
        cursor = by_id.get(cursor.get("parent_id"))
        guard += 1
    seg.reverse()
    return seg


async def collect_imported_segments(
    client: UserClient,
    current_session_id: str,
    current_chain: list[dict[str, Any]],
    current_by_id: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    """Return [{label, nodes:[...]}] of LCA-trimmed imported context, or []."""
    chain_ids = {n["id"] for n in current_chain}

    # Connections declared anywhere on the current branch (dedup, ordered).
    conn_ids: list[str] = []
    for n in current_chain:
        for c in n.get("connections") or []:
            if c and c not in conn_ids and c not in chain_ids:
                conn_ids.append(c)
    if not conn_ids:
        return []

    # Fetch the connected (source) nodes themselves.
    sources = await client.select(
        "nodes",
        {"id": f"in.({','.join(conn_ids)})", "select": _IMPORT_SELECT},
    )
    if not sources:
        return []

    # For sources in OTHER sessions, fetch each session's nodes once to walk.
    other_session_ids = {
        s["session_id"] for s in sources if s["session_id"] != current_session_id
    }
    other_by_session: dict[str, dict[str, dict[str, Any]]] = {}
    for sid in other_session_ids:
        rows = await client.select(
            "nodes",
            {"session_id": f"eq.{sid}", "select": _IMPORT_SELECT},
        )
        other_by_session[sid] = {r["id"]: r for r in rows}

    segments: list[dict[str, Any]] = []
    budget = settings.memory_max_imported_nodes
    for src in sources:
        if budget <= 0:
            break
        if src["session_id"] == current_session_id:
            seg = _same_session_segment(current_by_id, chain_ids, src["id"])
            label = "같은 세션의 다른 분기"
        else:
            seg = _full_chain(other_by_session.get(src["session_id"], {}), src["id"])
            label = "다른 세션"
        # Real nodes only; nothing already on the current branch.
        seg = [
            n
            for n in seg
            if not n.get("is_navigator") and n["id"] not in chain_ids
        ]
        if not seg:
            continue
        seg = seg[:budget]
        budget -= len(seg)
        segments.append({"label": label, "nodes": seg})

    return segments


def build_reference_text(segments: list[dict[str, Any]]) -> str:
    """Render source-labelled reference blocks for prompt injection."""
    cap = settings.memory_answer_char_cap
    blocks: list[str] = []
    for seg in segments:
        lines = [f"[{seg['label']}에서 가져온 참고 내용]"]
        for n in seg["nodes"]:
            q = (n.get("question") or "").strip()
            a = (n.get("answer") or "").strip()[:cap]
            if q:
                lines.append(f"Q: {q}")
            if a:
                lines.append(f"A: {a}")
        if len(lines) > 1:
            blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


def _segment_node_ids(segments: list[dict[str, Any]]) -> list[str]:
    """Flatten the imported node ids (for D35 structured logging / provenance)."""
    ids: list[str] = []
    for seg in segments:
        for n in seg.get("nodes", []):
            nid = n.get("id")
            if nid:
                ids.append(nid)
    return ids


async def build_reference_context(
    client: UserClient,
    current_session_id: str,
    current_chain: list[dict[str, Any]],
    current_by_id: dict[str, dict[str, Any]],
) -> tuple[str | None, list[str]]:
    """Best-effort: assemble the imported reference text + its source node ids.

    Returns ``(text_or_None, node_ids)`` — node_ids feeds the D35 structured
    ``memory_link`` block. On any failure -> ``(None, [])``.
    """
    try:
        segments = await collect_imported_segments(
            client, current_session_id, current_chain, current_by_id
        )
        text = build_reference_text(segments)
        return (text or None), _segment_node_ids(segments)
    except Exception:  # noqa: BLE001 - memory linking must never break chat
        logger.exception("Imported context assembly failed")
        return None, []


async def build_comparison_context(
    client: UserClient,
    reference_node_ids: list[str],
    current_chain: list[dict[str, Any]] | None = None,
    current_by_id: dict[str, dict[str, Any]] | None = None,
) -> tuple[str | None, list[str], list[dict[str, Any]]]:
    """ONE-TIME branch comparison (D15/D46): pull each referenced branch into
    this turn only.

    Unlike Stage 3a memory linking, this is NOT persisted into node.connections.
    Rendered under a distinct "[브랜치 참조 — 비교]" label so the model keeps it
    separate from the live branch / imported / RAG blocks. Only nodes the caller
    can access are used (access layer).

    LCA trim (D46): a reference in the CURRENT session reuses ``current_by_id``
    and is trimmed to the segment BELOW the lowest common ancestor (drop the
    shared ancestor chain the model already has from the live branch); a
    reference in ANOTHER session has no shared ancestor, so its full root->node
    chain is imported.

    Returns ``(text_or_None, node_ids, sources)`` where ``sources`` is the D46
    ``reference_sources`` list — ``[{kind:'comparison', label, node_ids, leaf_id,
    session_id}]`` — for best-effort persistence on the answer node. Every early
    return is a 3-tuple (a bare ``return None`` here used to TypeError the chat
    handler's tuple-unpack → 500). Best-effort -> ``(None, [], [])``.
    """
    current_chain = current_chain or []
    current_by_id = current_by_id or {}
    chain_ids = {n["id"] for n in current_chain}

    ids = [i for i in (reference_node_ids or []) if i]
    if not ids:
        return None, [], []
    try:
        refs = await client.select(
            "nodes",
            {"id": f"in.({','.join(ids)})", "select": _IMPORT_SELECT},
        )
        if not refs:
            return None, [], []
        # Fetch OTHER-session nodes once each to walk their chains. Same-session
        # references reuse current_by_id (already in hand → no extra query).
        other_session_ids = {
            r["session_id"] for r in refs if r["id"] not in current_by_id
        }
        other_by_session: dict[str, dict[str, dict[str, Any]]] = {}
        for sid in other_session_ids:
            rows = await client.select(
                "nodes", {"session_id": f"eq.{sid}", "select": _IMPORT_SELECT}
            )
            other_by_session[sid] = {r["id"]: r for r in rows}

        budget = settings.memory_max_imported_nodes
        segments: list[dict[str, Any]] = []
        sources: list[dict[str, Any]] = []
        for ref in refs:
            if budget <= 0:
                break
            if ref["id"] in current_by_id:
                # Same session: LCA trim (exclude the shared ancestor chain).
                seg = _same_session_segment(current_by_id, chain_ids, ref["id"])
            else:
                # Different session: no shared ancestor → full root->node chain.
                seg = _full_chain(
                    other_by_session.get(ref["session_id"], {}), ref["id"]
                )
            # Real nodes only; nothing already on the current branch.
            seg = [
                n
                for n in seg
                if not n.get("is_navigator") and n["id"] not in chain_ids
            ]
            if not seg:
                continue
            seg = seg[:budget]
            budget -= len(seg)
            label = ref.get("label") or "참조 분기"
            segments.append({"label": f"브랜치 참조 — {label}", "nodes": seg})
            sources.append(
                {
                    "kind": "comparison",
                    "label": label,
                    "node_ids": [n["id"] for n in seg],
                    "leaf_id": ref["id"],
                    "session_id": ref["session_id"],
                }
            )

        text = build_reference_text(segments)
        return (text or None), _segment_node_ids(segments), sources
    except Exception:  # noqa: BLE001 - comparison must never break chat
        logger.exception("Comparison context assembly failed")
        return None, [], []
