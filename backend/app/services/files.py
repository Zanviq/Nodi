"""File upload + registration (Stage 3b-1).

Upload writes the bytes to local storage (STORAGE_DIR), inserts the `files`
row with the trusted ServiceClient (owner_id set explicitly to the caller after
the class membership / teacher checks below), then runs the RAG pipeline inline
(services/file_pipeline.py) with the caller's own Gemini key, if any. List/get
are request-time reads through the caller's access-checked UserClient.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import HTTPException, status

from ..config import get_settings
from ..db.client import ServiceClient, UserClient
from . import app_settings, file_pipeline, storage

logger = logging.getLogger("nodi.files")

settings = get_settings()

FILE_SELECT = (
    "id,owner_id,space_kind,space_ref,uploader_id,kind,storage_path,mime,"
    "size_bytes,status,chunk_total,chunk_done,error,session_id,position_x,"
    "position_y,created_at,updated_at"
)


async def _assert_class_member(
    user_client: UserClient, owner_id: str, class_id: str
) -> None:
    """Verify the caller belongs to the class (own membership row is readable)."""
    rows = await user_client.select(
        "class_members",
        {
            "class_id": f"eq.{class_id}",
            "user_id": f"eq.{owner_id}",
            "select": "class_id",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a member of this class.",
        )


async def _assert_class_teacher(user_client: UserClient, class_id: str) -> None:
    """Verify the caller is a teacher of the class (is_class_teacher RPC)."""
    is_teacher = await user_client.rpc("is_class_teacher", {"p_class_id": class_id})
    if not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a teacher of this class.",
        )


async def upload_file(
    service: ServiceClient,
    user_client: UserClient,
    owner_id: str,
    space_kind: str,
    space_ref: str | None,
    filename: str,
    mime: str | None,
    data: bytes,
    session_id: str | None = None,
    position_x: float | None = None,
    position_y: float | None = None,
    kind: str = "user_upload",
    api_key: str | None = None,
) -> dict[str, Any]:
    if space_kind not in ("personal", "class"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="space_kind must be 'personal' or 'class'.",
        )
    if kind not in ("user_upload", "class_material"):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="kind must be 'user_upload' or 'class_material'.",
        )
    if kind == "class_material" and space_kind != "class":
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class_material requires space_kind='class'.",
        )
    ref = space_ref or (owner_id if space_kind == "personal" else None)
    if space_kind == "class" and not ref:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="class files require space_ref (class id).",
        )
    # Defense: class_material requires teacher of that class; other class
    # uploads only require membership.
    if space_kind == "class":
        if kind == "class_material":
            await _assert_class_teacher(user_client, ref)
        else:
            await _assert_class_member(user_client, owner_id, ref)
    if not data:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Empty file.",
        )
    overlay = await app_settings.get_overlay()
    max_bytes = app_settings.as_int(
        overlay, "file_max_bytes", settings.file_max_bytes, 1024, 100 * 1024 * 1024
    )
    if len(data) > max_bytes:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File exceeds {max_bytes} bytes.",
        )

    file_id = str(uuid.uuid4())
    safe_name = storage.safe_filename(filename)
    storage_path = f"{owner_id}/{file_id}/{safe_name}"

    try:
        await storage.save(storage_path, data)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Storing upload failed")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not store the file.",
        ) from exc

    try:
        rows = await service.insert(
        "files",
        {
            "id": file_id,
            "owner_id": owner_id,
            "space_kind": space_kind,
            "space_ref": ref,
            "uploader_id": owner_id,
            "kind": kind,
            "storage_path": storage_path,
            "mime": mime,
            "size_bytes": len(data),
            "status": "uploaded",
            "session_id": session_id,
            "position_x": position_x,
            "position_y": position_y,
        },
        )
    except Exception:
        await storage.delete(storage_path)
        raise
    file_row = rows[0]

    # Extract + chunk (+ embed and tag when the caller supplied a Gemini key)
    # inside this request; the key never leaves it. Never raises.
    await file_pipeline.process(service, file_row, data, api_key)
    refreshed = await service.select(
        "files", {"id": f"eq.{file_id}", "select": FILE_SELECT, "limit": "1"}
    )
    return refreshed[0] if refreshed else file_row


async def get_file_tags(client: UserClient, file_id: str) -> list[str]:
    """Tag names of a file the caller can access (own or class material)."""
    result = await client.rpc("get_file_tags", {"p_file_id": file_id})
    if isinstance(result, list):
        return [str(x) for x in result]
    return []


async def _assert_file_owner(
    client: UserClient, owner_id: str, file_id: str
) -> dict[str, Any]:
    """Return the file row, requiring the caller to be its OWNER (not just a
    class member who can read class_material)."""
    file_row = await get_file(client, file_id)  # 404 unless accessible
    if file_row.get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the file owner can do this.",
        )
    return file_row


async def delete_file(client: UserClient, owner_id: str, file_id: str) -> None:
    """Delete a file (owner only): files row (cascades chunks/links/file_tags)
    + orphan concept tags (D29), then the stored bytes.

    The row delete + orphan-tag cleanup run atomically inside the
    `delete_file_cascade` RPC (owner-checked); shared tags (still used
    elsewhere) are preserved. The object is removed after the row, so a failed
    DB delete never leaves a row pointing at missing bytes.
    """
    file_row = await _assert_file_owner(client, owner_id, file_id)
    await client.rpc("delete_file_cascade", {"p_file_id": file_id})
    storage_path = file_row.get("storage_path")
    if storage_path:
        try:
            await storage.delete(storage_path)
        except Exception:  # noqa: BLE001 - an orphan object is harmless
            logger.warning("Stored object removal failed for file=%s", file_id)


async def retry_file(
    service: ServiceClient,
    client: UserClient,
    owner_id: str,
    file_id: str,
    api_key: str,
) -> str:
    """Re-process a file (owner only) inline with the caller's Gemini key.
    Returns the action taken ("reprocessed:<status>" / "reembedded:<status>")."""
    file_row = await _assert_file_owner(client, owner_id, file_id)
    return await file_pipeline.retry(service, file_row, api_key)


async def list_files(
    client: UserClient, space_kind: str, space_ref: str
) -> list[dict[str, Any]]:
    return await client.select(
        "files",
        {
            "space_kind": f"eq.{space_kind}",
            "space_ref": f"eq.{space_ref}",
            "select": FILE_SELECT,
            "order": "created_at.desc",
        },
    )


async def get_file(client: UserClient, file_id: str) -> dict[str, Any]:
    rows = await client.select(
        "files",
        {"id": f"eq.{file_id}", "select": FILE_SELECT, "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found.",
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Visual RAG links (Stage 3b-2)
# ---------------------------------------------------------------------------
LINK_SELECT = "id,file_id,target_node_id,owner_id,created_at"


async def _owned_node_session(
    client: UserClient, owner_id: str, node_id: str
) -> dict[str, Any]:
    """Return the node's session row, ensuring the caller owns that session."""
    rows = await client.select(
        "nodes",
        {"id": f"eq.{node_id}", "select": "id,session_id", "limit": "1"},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Node not found."
        )
    session_id = rows[0]["session_id"]
    srows = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    if not srows or srows[0].get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not own this node's session.",
        )
    return srows[0]


async def add_link(
    client: UserClient, owner_id: str, file_id: str, target_node_id: str
) -> dict[str, Any]:
    # Both the file and the node's session must be the caller's.
    file_row = await get_file(client, file_id)  # 404 unless accessible
    session = await _owned_node_session(client, owner_id, target_node_id)
    # Space isolation: a file may only be linked within its own space.
    if (file_row.get("space_kind") != session.get("space_kind")) or (
        file_row.get("space_ref") != session.get("space_ref")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File and node must belong to the same space.",
        )
    # Idempotent: return the existing link if already present.
    existing = await client.select(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
            "select": LINK_SELECT,
            "limit": "1",
        },
    )
    if existing:
        return existing[0]
    return await client.insert(
        "file_node_links",
        {
            "file_id": file_id,
            "target_node_id": target_node_id,
            "owner_id": owner_id,
        },
    )


async def remove_link(
    client: UserClient, file_id: str, target_node_id: str
) -> None:
    await client.delete(
        "file_node_links",
        {
            "file_id": f"eq.{file_id}",
            "target_node_id": f"eq.{target_node_id}",
        },
    )


async def list_session_file_links(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """Links for any node in the session, with the linked file embedded."""
    node_rows = await client.select(
        "nodes", {"session_id": f"eq.{session_id}", "select": "id"}
    )
    node_ids = [n["id"] for n in node_rows]
    if not node_ids:
        return []
    return await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": (
                "id,file_id,target_node_id,created_at,"
                "files(id,storage_path,mime,status,chunk_total,chunk_done,"
                "session_id,position_x,position_y)"
            ),
            "order": "created_at.desc",
        },
    )


async def set_file_position(
    client: UserClient, file_id: str, position_x: float | None, position_y: float | None
) -> dict[str, Any]:
    """Persist a file-node's coordinates (D13). Owner only (files update rule)."""
    rows = await client.update(
        "files",
        {"id": f"eq.{file_id}"},
        {"position_x": position_x, "position_y": position_y},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="File not found or not yours.",
        )
    return rows[0]


# ---------------------------------------------------------------------------
# Graph-node PLACEMENTS (D58/D59) — display only, decoupled from RAG links.
#
# A placement (file_graph_nodes, 0021) means "show this file as a free node on
# THIS session's graph", with its own coordinates. Independent of file_node_links
# (RAG): placing a file does NOT make it a RAG source, and RAG retrieval still
# reads file_node_links ONLY (rag.linked_file_ids — unchanged). One file can be
# placed on many session graphs. All reads/writes go through the caller's
# access-checked client (owner-only file_graph_nodes rules).
# ---------------------------------------------------------------------------
PLACEMENT_SELECT = (
    "id,file_id,session_id,position_x,position_y,created_at,"
    "files(id,storage_path,mime,kind,status,chunk_total,chunk_done,"
    "space_kind,space_ref)"
)


async def _owned_session(
    client: UserClient, owner_id: str, session_id: str
) -> dict[str, Any]:
    """Return the session row, requiring the caller to OWN it (not just read it)."""
    rows = await client.select(
        "sessions",
        {
            "id": f"eq.{session_id}",
            "select": "id,owner_id,space_kind,space_ref",
            "limit": "1",
        },
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Session not found."
        )
    if rows[0].get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not own this session.",
        )
    return rows[0]


async def add_placement(
    client: UserClient,
    owner_id: str,
    file_id: str,
    session_id: str,
    position_x: float | None,
    position_y: float | None,
) -> dict[str, Any]:
    """Place a file as a node on a session graph (idempotent upsert on
    file_id+session_id). Caller must own both the file and the session, and they
    must share the same space (mirrors add_link isolation)."""
    file_row = await get_file(client, file_id)  # 404 unless accessible
    if file_row.get("owner_id") != owner_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the file owner can place it.",
        )
    session = await _owned_session(client, owner_id, session_id)
    if (file_row.get("space_kind") != session.get("space_kind")) or (
        file_row.get("space_ref") != session.get("space_ref")
    ):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="File and session must belong to the same space.",
        )
    return await client.upsert(
        "file_graph_nodes",
        {
            "file_id": file_id,
            "session_id": session_id,
            "owner_id": owner_id,
            "position_x": position_x,
            "position_y": position_y,
        },
        on_conflict="file_id,session_id",
    )


async def list_placements(
    client: UserClient, session_id: str
) -> list[dict[str, Any]]:
    """Placements on a session graph, with the placed file's display meta joined
    (status/storage_path/chunk progress/kind) for graph file-node rendering."""
    return await client.select(
        "file_graph_nodes",
        {
            "session_id": f"eq.{session_id}",
            "select": PLACEMENT_SELECT,
            "order": "created_at.asc",
        },
    )


async def move_placement(
    client: UserClient,
    file_id: str,
    session_id: str,
    position_x: float | None,
    position_y: float | None,
) -> dict[str, Any]:
    """Update a placement's coordinates after drag (owner only, access layer)."""
    rows = await client.update(
        "file_graph_nodes",
        {"file_id": f"eq.{file_id}", "session_id": f"eq.{session_id}"},
        {"position_x": position_x, "position_y": position_y},
    )
    if not rows:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Placement not found or not yours.",
        )
    return rows[0]


async def remove_placement(
    client: UserClient, file_id: str, session_id: str
) -> None:
    """Remove a file from a session graph (placement only — the file itself and
    any RAG links are untouched; it stays in the space's file list)."""
    await client.delete(
        "file_graph_nodes",
        {"file_id": f"eq.{file_id}", "session_id": f"eq.{session_id}"},
    )
