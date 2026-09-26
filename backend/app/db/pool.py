"""Shared asyncpg pool + schema catalog.

The pool is created once in the FastAPI lifespan (`init_pool`) and closed on
shutdown (`close_pool`). At startup we also introspect the `public` schema into
a `Catalog` (table -> column -> SQL type, and RPC function signatures). The
PostgREST translator uses it to (a) whitelist identifiers — only real tables /
columns / functions can ever appear in generated SQL — and (b) cast every bound
parameter to the right SQL type (values are always passed as parameters, never
interpolated).
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

import asyncpg
from fastapi import HTTPException, status

from ..config import get_settings

logger = logging.getLogger("nodi.db")
settings = get_settings()

_pool: asyncpg.Pool | None = None
_catalog: "Catalog | None" = None
_catalog_lock = asyncio.Lock()


@dataclass
class FuncInfo:
    name: str
    # IN arguments in declaration order: (name, sql type)
    args: list[tuple[str, str]]
    # 'void' | 'set' | 'row' | 'scalar'
    returns: str


@dataclass
class Catalog:
    columns: dict[str, dict[str, str]] = field(default_factory=dict)
    functions: dict[str, list[FuncInfo]] = field(default_factory=dict)

    def column_type(self, table: str, column: str) -> str | None:
        return self.columns.get(table, {}).get(column)

    def has_table(self, table: str) -> bool:
        return table in self.columns


_COLUMNS_SQL = """
select c.relname as table_name,
       a.attname as column_name,
       format_type(a.atttypid, a.atttypmod) as data_type
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
 where c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p', 'v')
   and a.attnum > 0
   and not a.attisdropped
 order by c.relname, a.attnum
"""

_FUNCS_SQL = """
select p.proname,
       p.proretset,
       t.typtype::text as typtype,
       t.typname,
       p.proargnames,
       p.proargmodes::text[] as proargmodes,
       (select array_agg(format_type(u.o, null) order by u.i)
          from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[]))
               with ordinality as u(o, i)) as argtypes
  from pg_proc p
  join pg_type t on t.oid = p.prorettype
 where p.pronamespace = 'public'::regnamespace
   and p.prokind = 'f'
"""


async def _load_catalog(conn: asyncpg.Connection) -> Catalog:
    cat = Catalog()
    for r in await conn.fetch(_COLUMNS_SQL):
        cat.columns.setdefault(r["table_name"], {})[r["column_name"]] = r["data_type"]
    for r in await conn.fetch(_FUNCS_SQL):
        names = list(r["proargnames"] or [])
        modes = list(r["proargmodes"] or [])
        types = list(r["argtypes"] or [])
        args: list[tuple[str, str]] = []
        for i, typ in enumerate(types):
            mode = modes[i] if i < len(modes) else "i"
            if mode not in ("i", "b"):  # skip OUT / TABLE columns
                continue
            name = names[i] if i < len(names) else ""
            args.append((name, typ))
        if r["typname"] == "void":
            kind = "void"
        elif r["proretset"]:
            kind = "set"
        elif r["typtype"] == "c":
            kind = "row"
        else:
            kind = "scalar"
        cat.functions.setdefault(r["proname"], []).append(
            FuncInfo(name=r["proname"], args=args, returns=kind)
        )
    return cat


async def init_pool() -> None:
    """Create the shared pool (idempotent). Failure is logged, not fatal: the
    app still boots and DB-backed endpoints answer 503 until the DB is up."""
    global _pool
    if _pool is not None:
        return
    if not settings.database_url:
        logger.error("DATABASE_URL is not configured; database access disabled.")
        return
    try:
        _pool = await asyncpg.create_pool(
            dsn=settings.database_url,
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
            command_timeout=60,
        )
        await get_catalog()
        logger.info("Database pool ready.")
    except Exception:  # noqa: BLE001 - never crash the app on boot
        logger.exception("Could not connect to the database at startup.")


async def close_pool() -> None:
    global _pool, _catalog
    if _pool is not None:
        await _pool.close()
    _pool = None
    _catalog = None


async def get_pool() -> asyncpg.Pool:
    if _pool is None:
        await init_pool()
    if _pool is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database is not available.",
        )
    return _pool


async def get_catalog(refresh: bool = False) -> Catalog:
    """Schema catalog (loaded once; `refresh=True` re-reads it)."""
    global _catalog
    if _catalog is not None and not refresh:
        return _catalog
    async with _catalog_lock:
        if _catalog is not None and not refresh:
            return _catalog
        pool = _pool
        if pool is None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Database is not available.",
            )
        async with pool.acquire() as conn:
            _catalog = await _load_catalog(conn)
        if not _catalog.columns:
            logger.error("No tables found in schema 'public' — migrations applied?")
        return _catalog
