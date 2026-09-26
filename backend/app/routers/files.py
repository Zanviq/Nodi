"""File endpoints (Stage 3b-1) — upload + list + status.

Upload stores the bytes locally and processes the file INLINE (text extraction,
chunking and — when the caller sends `X-Gemini-Key` — embeddings + concept
tags). Without a key the file ends in status 'needs_key' (stored and chunked,
not yet searchable); POST /files/{id}/retry with a key finishes it.
"""

from __future__ import annotations

from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    UploadFile,
    status,
)
from pydantic import BaseModel

from ..ai_key import optional_gemini_key, require_gemini_key
from ..auth.deps import CurrentUser, get_current_user
from ..config import get_settings
from ..db.client import UserClient, get_service_client
from ..services import app_settings
from ..services import files as svc

router = APIRouter(prefix="/files", tags=["files"])
settings = get_settings()


class LinkBody(BaseModel):
    target_node_id: str


class FilePositionBody(BaseModel):
    position_x: float | None = None
    position_y: float | None = None


@router.post("", status_code=201)
async def upload(
    file: UploadFile = File(...),
    space_kind: str = Form("personal"),
    space_ref: str | None = Form(None),
    session_id: str | None = Form(None),
    position_x: float | None = Form(None),
    position_y: float | None = Form(None),
    kind: str = Form("user_upload"),
    user: CurrentUser = Depends(get_current_user),
    api_key: str | None = Depends(optional_gemini_key),
) -> dict[str, Any]:
    """Upload a file -> local storage + files row + inline processing.

    Returns the final file row: status 'indexed' (with key), 'needs_key'
    (no key: RAG unavailable until retried with a key), 'failed'/'partial'.
    Optional `session_id` + `position_x/y` place the file as a node in a session
    graph (D13). `kind='class_material'` (teacher only, space_kind='class') makes
    the file readable + RAG-searchable by all class members (Stage 4b).
    """
    service = get_service_client()
    # Early reject on declared size (avoid buffering an oversized body). D62:
    # the limit is admin-tunable via the overlay (upload_file re-checks it too).
    overlay = await app_settings.get_overlay()
    max_bytes = app_settings.as_int(
        overlay, "file_max_bytes", settings.file_max_bytes, 1024, 100 * 1024 * 1024
    )
    if file.size is not None and file.size > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {max_bytes} bytes.",
        )
    data = await file.read()
    return await svc.upload_file(
        service,
        UserClient.from_user(user),
        owner_id=user.id,
        space_kind=space_kind,
        space_ref=space_ref,
        filename=file.filename or "upload",
        mime=file.content_type,
        data=data,
        session_id=session_id,
        position_x=position_x,
        position_y=position_y,
        kind=kind,
        api_key=api_key,
    )


@router.get("")
async def list_files(
    space_kind: str = Query(..., pattern="^(personal|class)$"),
    space_ref: str | None = Query(None),
    user: CurrentUser = Depends(get_current_user),
) -> list[dict[str, Any]]:
    ref = space_ref or (user.id if space_kind == "personal" else None)
    if not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class space requires space_ref (class id).",
        )
    client = UserClient.from_user(user)
    return await svc.list_files(client, space_kind, ref)


@router.get("/{file_id}")
async def get_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """File row incl. status + progress (chunk_done / chunk_total)."""
    client = UserClient.from_user(user)
    return await svc.get_file(client, file_id)


@router.get("/{file_id}/tags")
async def get_file_tags(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Tag names of a file the caller can access (own or class material)."""
    client = UserClient.from_user(user)
    return {"file_id": file_id, "tags": await svc.get_file_tags(client, file_id)}


@router.delete("/{file_id}", status_code=204)
async def delete_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    """Delete a file (owner only): row (cascades chunks/links/tags) + stored bytes."""
    client = UserClient.from_user(user)
    await svc.delete_file(client, user.id, file_id)


@router.post("/{file_id}/retry")
async def retry_file(
    file_id: str,
    user: CurrentUser = Depends(get_current_user),
    api_key: str = Depends(require_gemini_key),
) -> dict[str, Any]:
    """Re-process a failed/partial/needs_key file (owner only), inline, with the
    caller's Gemini key (400 `gemini_key_required` without it). Idempotent.
    Returns {file_id, action, file} where `file` is the updated row."""
    service = get_service_client()
    client = UserClient.from_user(user)
    action = await svc.retry_file(service, client, user.id, file_id, api_key)
    return {
        "file_id": file_id,
        "action": action,
        "file": await svc.get_file(client, file_id),
    }


@router.patch("/{file_id}/position")
async def set_file_position(
    file_id: str,
    body: FilePositionBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Persist a file-node's coordinates after drag (D13). Owner only."""
    client = UserClient.from_user(user)
    return await svc.set_file_position(
        client, file_id, body.position_x, body.position_y
    )


# --- RAG source detail (D41) ---------------------------------------------
@router.get("/chunks/{chunk_id}/context")
async def get_chunk_context(
    chunk_id: str,
    neighbors: int = Query(1, ge=0, le=5),
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Full text + neighbours of a RAG source chunk (the "⋯" detail panel, D41).

    Calls the get_chunk_context RPC as the caller; visibility (own file
    or class_material the caller belongs to) is enforced inside the RPC, so a
    chunk the caller cannot access yields 0 rows -> 404. Returns
    ``{file_id, name, seq, page, chunk_text, prev_text, next_text}``.
    """
    client = UserClient.from_user(user)
    rows = await client.rpc(
        "get_chunk_context",
        {"p_chunk_id": chunk_id, "p_neighbors": neighbors},
    )
    if isinstance(rows, list):
        if not rows:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Chunk not found or not accessible.",
            )
        return rows[0]
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Chunk not found or not accessible.",
        )
    return rows


# --- Visual RAG links (Stage 3b-2) ---------------------------------------
@router.post("/{file_id}/links", status_code=201)
async def add_link(
    file_id: str,
    body: LinkBody,
    user: CurrentUser = Depends(get_current_user),
) -> dict[str, Any]:
    """Link this file to a node ("use this file when answering from this branch").

    Applies to the node and its descendant branch. Caller must own both the file
    and the node's session. Idempotent.
    """
    client = UserClient.from_user(user)
    return await svc.add_link(client, user.id, file_id, body.target_node_id)


@router.delete("/{file_id}/links/{node_id}", status_code=204)
async def remove_link(
    file_id: str,
    node_id: str,
    user: CurrentUser = Depends(get_current_user),
) -> None:
    client = UserClient.from_user(user)
    await svc.remove_link(client, file_id, node_id)
