"""Session endpoints — list / create / fetch-with-nodes (tree restore)."""

from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field

from ..ai_key import optional_gemini_key
from ..auth.deps import CurrentUser, get_current_user
from ..services import files as files_svc
from ..services import rag
from ..services import sessions as svc
from ..db.client import UserClient

router = APIRouter(prefix="/sessions", tags=["sessions"])


class CreateSessionBody(BaseModel):
    space_kind: str = Field(pattern="^(personal|class)$")
    space_ref: str | None = None  # class id for class; defaults to owner for personal
    title: str | None = Field(default=None, max_length=200)


class RenameSessionBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class NodePosition(BaseModel):
    node_id: str
    x: float | None = None
    y: float | None = None


class NodePositionsBody(BaseModel):
    positions: list[NodePosition] = Field(default_factory=list, max_length=2000)


class PlacementBody(BaseModel):
    """Add/upsert a file placement on this session's graph (D58)."""

    file_id: str
    position_x: float | None = None
    position_y: float | None = None


class PlacementMoveBody(BaseModel):
    """Move an existing placement (D58)."""

    file_id: str
    position_x: float | None = None
    position_y: float | None = None


@router.post("", status_code=201)
async def create_session(
    body: CreateSessionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    client = UserClient.from_user(user)
    return await svc.create_session(
        client, user.id, body.space_kind, body.space_ref, body.title
    )


@router.get("")
async def list_sessions(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    client = UserClient.from_user(user)
    return await svc.list_sessions(client, space_kind, space_ref, user.id)


@router.get("/{session_id}")
async def get_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Session metadata + all of its nodes, for client-side tree reconstruction."""
    client = UserClient.from_user(user)
    # Session meta and the node list are independent reads -> fetch concurrently
    # (same pattern as chat.py). Return shape/fields are unchanged (with_tags=True
    # keeps the NODE_SELECT_WITH_TAGS contract). A 404 from get_session still
    # propagates out of gather as a plain HTTP error.
    session, nodes = await asyncio.gather(
        svc.get_session(client, session_id),
        svc.get_session_nodes(client, session_id, with_tags=True),
    )
    return {"session": session, "nodes": nodes}


@router.patch("/{session_id}")
async def rename_session(
    session_id: str,
    body: RenameSessionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Rename a session (owner only)."""
    client = UserClient.from_user(user)
    return await svc.update_session_title(client, session_id, body.title)


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Delete a session and its nodes (files are kept; session_id -> null)."""
    client = UserClient.from_user(user)
    await svc.delete_session(client, session_id)


@router.put("/{session_id}/node-positions")
async def set_node_positions(
    session_id: str,
    body: NodePositionsBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Batch-persist node coordinates after drag/relayout (D20/D69).

    One bulk statement; only the caller's own nodes in this session are
    updated. Non-uuid (client-only) ids are skipped silently."""
    client = UserClient.from_user(user)
    n = await svc.set_node_positions(
        client, session_id, [p.model_dump() for p in body.positions]
    )
    return {"updated": n}


@router.get("/{session_id}/file-links")
async def get_session_file_links(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Files linked to any node in this session (for graph file-nodes + edges)."""
    client = UserClient.from_user(user)
    await svc.get_session(client, session_id)  # 404/access gate
    return await files_svc.list_session_file_links(client, session_id)


# --- File graph-node placements (D58/D59) — display, decoupled from RAG ----
@router.get("/{session_id}/file-graph-nodes")
async def list_file_graph_nodes(
    session_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """Files placed as free nodes on this session's graph (with file meta joined).

    This is the DISPLAY source for graph file-nodes (replaces the old
    files.session_id filter). Independent of RAG links.
    """
    client = UserClient.from_user(user)
    await svc.get_session(client, session_id)  # 404/access gate
    return await files_svc.list_placements(client, session_id)


@router.post("/{session_id}/file-graph-nodes", status_code=201)
async def add_file_graph_node(
    session_id: str,
    body: PlacementBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Place (or re-place) a file on this session's graph at the given coords.

    Idempotent upsert on (file_id, session_id). Caller must own both the file and
    the session and they must share a space. Does NOT create a RAG link.
    """
    client = UserClient.from_user(user)
    return await files_svc.add_placement(
        client, user.id, body.file_id, session_id, body.position_x, body.position_y
    )


@router.patch("/{session_id}/file-graph-nodes")
async def move_file_graph_node(
    session_id: str,
    body: PlacementMoveBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Update a placement's coordinates after drag (owner only)."""
    client = UserClient.from_user(user)
    return await files_svc.move_placement(
        client, body.file_id, session_id, body.position_x, body.position_y
    )


@router.delete("/{session_id}/file-graph-nodes/{file_id}", status_code=204)
async def remove_file_graph_node(
    session_id: str,
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Remove a file from this session's graph (placement only; file is kept)."""
    client = UserClient.from_user(user)
    await files_svc.remove_placement(client, file_id, session_id)


@router.get("/{session_id}/file-suggestions")
async def get_file_suggestions(
    session_id: str,
    node_id: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
    api_key: str | None = Depends(optional_gemini_key),
) -> dict[str, Any]:
    """When the current branch has no linked files, propose space files to link
    (embedding match). Empty if files are already linked or none indexed.

    Needs the caller's Gemini key for the query embedding; without it the
    answer is `{"suggestions": [], "ai_unavailable": true}` (not an error)."""
    if not api_key:
        return {"suggestions": [], "ai_unavailable": True}
    client = UserClient.from_user(user)
    # Session meta and the node list are independent reads -> fetch concurrently.
    # Only `head`/`chain` depend on the session (current_head_id), so they stay
    # after the gather. A 404 from get_session propagates out of gather.
    session, nodes = await asyncio.gather(
        svc.get_session(client, session_id),
        svc.get_session_nodes(client, session_id),
    )
    head = node_id or session.get("current_head_id")
    chain = svc.ancestor_chain_nodes(nodes, head)
    suggestions = await rag.suggest_files(
        client, chain, session.get("space_kind"), session.get("space_ref"), api_key
    )
    return {"suggestions": suggestions}
