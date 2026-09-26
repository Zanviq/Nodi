"""Teacher control panel (Stage 4b) — teacher role only, NO conversation space.

A teacher manages classes: view students, read each student's class-scoped
conversation sessions, and upload class materials (embedded once, then RAG-
shared with all class members). Teachers do not have a chat workspace — there is
no teacher chat endpoint here.

Auth: every endpoint requires app role 'teacher' (gate) AND per-class
is_class_teacher (data scope, enforced in the RPCs / access layer).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from ..auth.deps import CurrentUser, Profile, get_current_user, require_role
from ..services import files as files_svc
from ..db.client import UserClient

router = APIRouter(prefix="/teacher", tags=["teacher"])

# Gate: caller must be an app-role 'teacher'. Per-class authority is checked by
# is_class_teacher() inside the RPCs / access layer.
require_teacher = require_role("teacher")

SESSION_SELECT = (
    "id,owner_id,space_kind,space_ref,title,emoji,root_node_id,"
    "current_head_id,created_at,updated_at"
)


async def _assert_teaches(client: UserClient, class_id: str) -> None:
    is_teacher = await client.rpc("is_class_teacher", {"p_class_id": class_id})
    if not is_teacher:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You are not a teacher of this class.",
        )


@router.get("/classes")
async def list_classes(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Classes the caller teaches, with student counts."""
    client = UserClient.from_user(user)
    result = await client.rpc("teacher_classes", {})
    return result if isinstance(result, list) else []


@router.get("/classes/overview")
async def list_class_overview(
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Teacher console HOME data (D67): one row per class the caller teaches,
    each with student_count, material_count and last_activity_at.

    Delegates to the teacher_class_overview() RPC, which
    self-guards via is_class_teacher(c.id) — so a teacher sees only their own
    classes. The legacy /classes (dropdown) endpoint is unchanged.
    """
    client = UserClient.from_user(user)
    result = await client.rpc("teacher_class_overview", {})
    return result if isinstance(result, list) else []


class CreateClassBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.post("/classes", status_code=status.HTTP_201_CREATED)
async def create_class(
    body: CreateClassBody,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> dict[str, Any]:
    """Create a class owned by the calling teacher (D33).

    Delegates to the `create_class` RPC: it re-checks the
    teacher app-role, inserts the class (teacher_id = caller, unique join_code),
    and enrolls the caller as a class teacher. Returns the new class row
    (id, name, join_code, teacher_id, created_at). Students join later with the
    join_code via the existing onboarding/profile flow."""
    client = UserClient.from_user(user)
    result = await client.rpc("create_class", {"p_name": body.name})
    if isinstance(result, list):
        return result[0] if result else {}
    return result


@router.get("/classes/{class_id}/students")
async def list_students(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Students of a class the caller teaches (RPC guards via is_class_teacher)."""
    client = UserClient.from_user(user)
    result = await client.rpc("class_students", {"p_class_id": class_id})
    return result if isinstance(result, list) else []


@router.get("/classes/{class_id}/students/{user_id}/sessions")
async def list_student_sessions(
    class_id: str,
    user_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """A student's sessions in THIS class space (teacher read rule R2).

    Open a session's nodes via GET /sessions/{id} (teacher access allowed).
    """
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    return await client.select(
        "sessions",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{class_id}",
            "owner_id": f"eq.{user_id}",
            "select": SESSION_SELECT,
            "order": "updated_at.desc",
        },
    )


@router.get("/classes/{class_id}/materials")
async def list_materials(
    class_id: str,
    user: CurrentUser = Depends(get_current_user),
    _: Profile = Depends(require_teacher),
) -> list[dict[str, Any]]:
    """Class-material files for the class + their embedding status."""
    client = UserClient.from_user(user)
    await _assert_teaches(client, class_id)
    return await client.select(
        "files",
        {
            "space_kind": "eq.class",
            "space_ref": f"eq.{class_id}",
            "kind": "eq.class_material",
            "select": files_svc.FILE_SELECT,
            "order": "created_at.desc",
        },
    )
