"""Database clients with the PostgREST-style interface the services use.

`UserClient`    — one per request, bound to the caller's user id. Every statement
                  runs in its own transaction with `app.user_id` set, and the
                  access layer (`access.py`) rewrites/checks it, so a caller only
                  ever sees/writes what the former row level security allowed.
`ServiceClient` — trusted system client (no access rules, `app.role='service'`)
                  for internal work: file processing, app_settings overlay,
                  auth bookkeeping. NEVER hand it user-controlled filters without
                  an explicit ownership check first.

Errors: permission failures -> 403; malformed ids -> 422; anything else from
the database -> 502 "Database request failed." (details are logged server-side
only). `DatabaseError.sqlstate` lets callers map specific SQL errors.
"""

from __future__ import annotations

import json
import logging
from typing import Any

import asyncpg
from fastapi import HTTPException, status

from . import access
from .pool import get_catalog, get_pool
from .postgrest import (
    QueryError,
    build_count,
    build_delete,
    build_insert,
    build_rpc,
    build_select,
    build_update,
)

logger = logging.getLogger("nodi.db.client")


class DatabaseError(HTTPException):
    """HTTP-mapped database failure carrying the SQLSTATE (if any)."""

    def __init__(self, status_code: int, detail: str, sqlstate: str | None = None):
        super().__init__(status_code=status_code, detail=detail)
        self.sqlstate = sqlstate


def _forbidden() -> DatabaseError:
    return DatabaseError(
        status.HTTP_403_FORBIDDEN, "Not authorized for this operation.", "42501"
    )


def _map_error(exc: Exception, op: str) -> DatabaseError:
    if isinstance(exc, DatabaseError):
        return exc
    if isinstance(exc, QueryError):
        logger.error("Invalid query for %s: %s", op, exc)
        return DatabaseError(status.HTTP_400_BAD_REQUEST, "Invalid query.")
    sqlstate = getattr(exc, "sqlstate", None)
    if sqlstate == "42501":
        return _forbidden()
    if sqlstate in ("22P02", "22007", "22008", "22003"):
        # invalid uuid / timestamp / number literal (e.g. a client-only id)
        return DatabaseError(
            422, "Invalid identifier or value.", sqlstate
        )
    if isinstance(exc, (OSError, asyncpg.exceptions.CannotConnectNowError)):
        logger.error("Database unavailable during %s: %s", op, exc)
        return DatabaseError(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Database is not available.", sqlstate
        )
    # Constraint / data / explicit-raise errors are usually the caller's input
    # (duplicate username, bad join code, ...) -> warning; the rest is an error.
    level = (
        logging.WARNING
        if sqlstate and sqlstate[:2] in ("22", "23", "P0")
        else logging.ERROR
    )
    logger.log(level, "Database %s failed (%s): %s", op, sqlstate, exc)
    return DatabaseError(
        status.HTTP_502_BAD_GATEWAY, "Database request failed.", sqlstate
    )


class _BaseClient:
    """Shared plumbing: one transaction per call with the identity settings."""

    _user_id: str | None = None
    _service: bool = False

    def _rules(self, table: str) -> access.TableRules | None:
        return None if self._service else access.rules_for(table)

    async def _run(self, op: str, fn):
        pool = await get_pool()
        try:
            async with pool.acquire() as conn:
                async with conn.transaction():
                    await conn.execute(
                        "select set_config('app.user_id', $1, true), "
                        "set_config('app.role', $2, true)",
                        self._user_id or "",
                        "service" if self._service else "user",
                    )
                    return await fn(conn)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 - mapped to an HTTP error
            raise _map_error(exc, op) from exc

    # --- reads -----------------------------------------------------------
    async def select(self, table: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        catalog = await get_catalog()
        try:
            sql, args = build_select(catalog, table, params, self._rules)
        except QueryError as exc:
            raise _map_error(exc, f"select {table}") from exc

        async def go(conn):
            raw = await conn.fetchval(sql, *args)
            return json.loads(raw) if raw else []

        return await self._run(f"select {table}", go)

    # --- writes ----------------------------------------------------------
    async def _insert_rows(
        self,
        table: str,
        rows: list[dict[str, Any]],
        on_conflict: str | None = None,
    ) -> list[dict[str, Any]]:
        catalog = await get_catalog()
        rules = self._rules(table)
        try:
            sql, args = build_insert(
                catalog,
                table,
                rows,
                rules.insert_check if rules else None,
                on_conflict=on_conflict,
                update_using=rules.update_using if rules else None,
                update_check=rules.update_check if rules else None,
                apply_rules=rules is not None,
            )
        except QueryError as exc:
            raise _map_error(exc, f"insert {table}") from exc

        async def go(conn):
            row = await conn.fetchrow(sql, *args)
            data = json.loads(row[0]) if row and row[0] else []
            if rules is not None and not row[1]:
                raise _forbidden()  # rolls the transaction back
            return data

        return await self._run(f"insert {table}", go)

    async def update(
        self, table: str, filters: dict[str, Any], patch: dict[str, Any]
    ) -> list[dict[str, Any]]:
        catalog = await get_catalog()
        rules = self._rules(table)
        if rules is not None and rules.update_columns is not None:
            if not set(patch) <= rules.update_columns:
                raise _forbidden()
        try:
            sql, args = build_update(
                catalog,
                table,
                filters,
                patch,
                rules.update_using if rules else None,
                rules.update_check if rules else None,
                apply_rules=rules is not None,
            )
        except QueryError as exc:
            raise _map_error(exc, f"update {table}") from exc

        async def go(conn):
            row = await conn.fetchrow(sql, *args)
            data = json.loads(row[0]) if row and row[0] else []
            if rules is not None and not row[1]:
                raise _forbidden()
            return data

        return await self._run(f"update {table}", go)

    async def delete(self, table: str, filters: dict[str, Any]) -> list[dict[str, Any]]:
        catalog = await get_catalog()
        rules = self._rules(table)
        try:
            sql, args = build_delete(
                catalog,
                table,
                filters,
                rules.delete if rules else None,
                apply_rules=rules is not None,
            )
        except QueryError as exc:
            raise _map_error(exc, f"delete {table}") from exc

        async def go(conn):
            raw = await conn.fetchval(sql, *args)
            return json.loads(raw) if raw else []

        return await self._run(f"delete {table}", go)

    async def rpc(self, fn: str, args: dict[str, Any]) -> Any:
        if not self._service and fn not in access.USER_RPCS:
            raise _forbidden()
        catalog = await get_catalog()
        try:
            sql, bind, kind = build_rpc(catalog, fn, args)
        except QueryError as exc:
            raise _map_error(exc, f"rpc {fn}") from exc

        async def go(conn):
            raw = await conn.fetchval(sql, *bind)
            if kind == "void" or raw is None:
                return None
            return json.loads(raw)

        return await self._run(f"rpc {fn}", go)


class UserClient(_BaseClient):
    """Access-checked client acting as one authenticated user."""

    def __init__(self, user_id: str):
        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated."
            )
        self._user_id = str(user_id)
        self._service = False

    @classmethod
    def from_user(cls, user: Any) -> "UserClient":
        return cls(user.id)

    async def insert(self, table: str, row: dict[str, Any]) -> dict[str, Any]:
        data = await self._insert_rows(table, [row])
        if not data:
            raise DatabaseError(status.HTTP_502_BAD_GATEWAY, "Database request failed.")
        return data[0]

    async def upsert(
        self, table: str, row: dict[str, Any], on_conflict: str
    ) -> dict[str, Any]:
        """Insert-or-update on the conflict target (access-checked)."""
        data = await self._insert_rows(table, [row], on_conflict=on_conflict)
        if not data:
            # conflicting row exists but the caller may not update it
            raise _forbidden()
        return data[0]


class ServiceClient(_BaseClient):
    """Trusted system client — bypasses the access layer."""

    def __init__(self) -> None:
        self._user_id = None
        self._service = True

    async def insert(
        self, table: str, rows: dict | list[dict], *, returning: bool = True
    ) -> list[dict]:
        batch = rows if isinstance(rows, list) else [rows]
        if not batch:
            return []
        data = await self._insert_rows(table, batch)
        return data if returning else []

    async def count(self, table: str, params: dict[str, Any]) -> int:
        catalog = await get_catalog()
        try:
            sql, args = build_count(catalog, table, params)
        except QueryError as exc:
            raise _map_error(exc, f"count {table}") from exc

        async def go(conn):
            return int(await conn.fetchval(sql, *args) or 0)

        return await self._run(f"count {table}", go)

    # Raw access for internal code that needs plain SQL (auth, file pipeline).
    async def fetch(self, sql: str, *args: Any) -> list[asyncpg.Record]:
        return await self._run("fetch", lambda conn: conn.fetch(sql, *args))

    async def fetchrow(self, sql: str, *args: Any) -> asyncpg.Record | None:
        return await self._run("fetchrow", lambda conn: conn.fetchrow(sql, *args))

    async def execute(self, sql: str, *args: Any) -> str:
        return await self._run("execute", lambda conn: conn.execute(sql, *args))

    async def executemany(self, sql: str, args: list[tuple]) -> None:
        await self._run("executemany", lambda conn: conn.executemany(sql, args))

    async def transaction(self, fn):
        """Run `fn(conn)` inside one service transaction (multi-statement work)."""
        return await self._run("transaction", fn)


_service_client = ServiceClient()


def get_service_client() -> ServiceClient:
    return _service_client
