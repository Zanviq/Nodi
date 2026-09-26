"""Translate the PostgREST-style params used by the services into SQL.

Supported subset (everything the codebase uses):

  select   = "a,b,rel(x,y),rel2(sub(z))"   columns + embedded relations
  filters  = {col: "eq.v" | "neq.v" | "gt.v" | "gte.v" | "lt.v" | "lte.v"
                   | "in.(a,b)" | "ilike.*x*" | "like.*x*" | "is.null|true|false"}
  and      = "(col.op.v,col2.op.v)"
  order    = "col.desc,col2.asc[.nullsfirst|.nullslast]"
  limit / offset

Safety: identifiers are validated against the live schema catalog (unknown
table/column -> error) and emitted double-quoted; values are ALWAYS bound
parameters (passed as text and cast to the column's SQL type), never
interpolated into the SQL string.

Rows come back exactly like PostgREST shaped them: the SELECT is wrapped in
`json_agg(...)`, so uuids/timestamps are JSON strings and jsonb is nested JSON.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any, Callable

from .access import TableRules, predicate
from .pool import Catalog

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_RESERVED = {"select", "order", "limit", "offset", "and", "on_conflict"}
_CMP = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

# Embeddable relations: (from_table, relation) -> (cardinality, local col, remote col)
#   "one"  : many-to-one  -> JSON object (or null)
#   "many" : one-to-many  -> JSON array
RELATIONS: dict[tuple[str, str], tuple[str, str, str]] = {
    ("class_members", "classes"): ("one", "class_id", "id"),
    ("node_tags", "tags"): ("one", "tag_id", "id"),
    ("nodes", "node_tags"): ("many", "id", "node_id"),
    ("file_node_links", "files"): ("one", "file_id", "id"),
    ("file_graph_nodes", "files"): ("one", "file_id", "id"),
}


class QueryError(ValueError):
    """A malformed / non-whitelisted query (programming error, not user input)."""


def q(ident: str) -> str:
    """Double-quote a validated identifier."""
    if not _IDENT_RE.match(ident):
        raise QueryError(f"invalid identifier: {ident!r}")
    return f'"{ident}"'


# ---------------------------------------------------------------------------
# Parameter binding
# ---------------------------------------------------------------------------
def _scalar_text(value: Any, sql_type: str) -> str | None:
    if value is None:
        return None
    if sql_type in ("json", "jsonb"):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


class Params:
    """Collects positional parameters; every value is bound as text + cast."""

    def __init__(self) -> None:
        self.values: list[Any] = []

    def add(self, value: Any, sql_type: str) -> str:
        if sql_type.endswith("[]"):
            elem_type = sql_type[:-2]
            if value is None:
                self.values.append(None)
            else:
                if not isinstance(value, (list, tuple)):
                    raise QueryError("array value expected")
                self.values.append(
                    [None if v is None else _scalar_text(v, elem_type) for v in value]
                )
            return f"${len(self.values)}::text[]::{sql_type}"
        self.values.append(_scalar_text(value, sql_type))
        return f"${len(self.values)}::text::{sql_type}"

    def add_list(self, items: list[str], elem_type: str) -> str:
        self.values.append(list(items))
        return f"${len(self.values)}::text[]::{elem_type}[]"


# ---------------------------------------------------------------------------
# select= parsing
# ---------------------------------------------------------------------------
@dataclass
class SelectTree:
    columns: list[str] = field(default_factory=list)  # may contain "*"
    embeds: list[tuple[str, "SelectTree"]] = field(default_factory=list)


def _split_top(text: str) -> list[str]:
    """Split on commas at parenthesis depth 0."""
    out: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                raise QueryError("unbalanced parentheses")
        if ch == "," and depth == 0:
            out.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    if depth != 0:
        raise QueryError("unbalanced parentheses")
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return [p for p in out if p]


def parse_select(text: str | None) -> SelectTree:
    tree = SelectTree()
    for item in _split_top(text or "*"):
        if "(" in item:
            if not item.endswith(")"):
                raise QueryError(f"bad embed: {item!r}")
            name, inner = item.split("(", 1)
            tree.embeds.append((name.strip(), parse_select(inner[:-1])))
        else:
            tree.columns.append(item)
    return tree


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------
def _parse_in_list(raw: str) -> list[str]:
    raw = raw.strip()
    if not (raw.startswith("(") and raw.endswith(")")):
        raise QueryError("in.() list expected")
    body = raw[1:-1]
    items: list[str] = []
    buf: list[str] = []
    quoted = False
    i = 0
    while i < len(body):
        ch = body[i]
        if quoted:
            if ch == "\\" and i + 1 < len(body):
                buf.append(body[i + 1])
                i += 2
                continue
            if ch == '"':
                quoted = False
            else:
                buf.append(ch)
        elif ch == '"':
            quoted = True
        elif ch == ",":
            items.append("".join(buf).strip())
            buf = []
        else:
            buf.append(ch)
        i += 1
    last = "".join(buf).strip()
    if last or items:
        items.append(last)
    return [x for x in items if x != ""]


def _condition(
    catalog: Catalog, table: str, alias: str, column: str, expr: str, params: Params
) -> str:
    col_type = catalog.column_type(table, column)
    if col_type is None:
        raise QueryError(f"unknown column {table}.{column}")
    if "." not in expr:
        raise QueryError(f"bad filter {column}={expr!r}")
    op, value = expr.split(".", 1)
    ref = f"{alias}.{q(column)}"
    if op in _CMP:
        return f"{ref} {_CMP[op]} {params.add(value, col_type)}"
    if op == "in":
        items = _parse_in_list(value)
        if not items:
            return "false"
        return f"{ref} = any({params.add_list(items, col_type)})"
    if op in ("ilike", "like"):
        pattern = value.replace("*", "%")
        kw = "ilike" if op == "ilike" else "like"
        return f"{ref}::text {kw} {params.add(pattern, 'text')}"
    if op == "is":
        v = value.lower()
        if v == "null":
            return f"{ref} is null"
        if v == "true":
            return f"{ref} is true"
        if v == "false":
            return f"{ref} is false"
        raise QueryError(f"bad is.{value}")
    raise QueryError(f"unsupported operator {op!r}")


def build_where(
    catalog: Catalog, table: str, alias: str, filters: dict[str, str], params: Params
) -> list[str]:
    conds: list[str] = []
    for key, expr in filters.items():
        if key in _RESERVED and key != "and":
            continue
        if key == "and":
            inner = str(expr).strip()
            if not (inner.startswith("(") and inner.endswith(")")):
                raise QueryError("and=(...) expected")
            for part in _split_top(inner[1:-1]):
                bits = part.split(".", 1)
                if len(bits) != 2:
                    raise QueryError(f"bad and-part {part!r}")
                conds.append(
                    _condition(catalog, table, alias, bits[0], bits[1], params)
                )
            continue
        conds.append(_condition(catalog, table, alias, key, str(expr), params))
    return conds


def build_order(catalog: Catalog, table: str, alias: str, order: str | None) -> str:
    if not order:
        return ""
    parts: list[str] = []
    for item in order.split(","):
        bits = [b.strip() for b in item.strip().split(".") if b.strip()]
        if not bits:
            continue
        col = bits[0]
        if catalog.column_type(table, col) is None:
            raise QueryError(f"unknown order column {table}.{col}")
        sql = f"{alias}.{q(col)}"
        for mod in bits[1:]:
            if mod == "asc":
                sql += " asc"
            elif mod == "desc":
                sql += " desc"
            elif mod == "nullsfirst":
                sql += " nulls first"
            elif mod == "nullslast":
                sql += " nulls last"
            else:
                raise QueryError(f"bad order modifier {mod!r}")
        parts.append(sql)
    return (" order by " + ", ".join(parts)) if parts else ""


def _int_param(raw: Any, name: str) -> int:
    try:
        v = int(str(raw))
    except (TypeError, ValueError) as exc:
        raise QueryError(f"bad {name}") from exc
    if v < 0:
        raise QueryError(f"bad {name}")
    return v


# ---------------------------------------------------------------------------
# SELECT
# ---------------------------------------------------------------------------
RuleLookup = Callable[[str], TableRules | None]


class _Aliases:
    def __init__(self) -> None:
        self.n = 0

    def next(self) -> str:
        self.n += 1
        return f"t{self.n}"


def _projection(
    catalog: Catalog,
    table: str,
    alias: str,
    tree: SelectTree,
    rules: RuleLookup,
    aliases: _Aliases,
) -> str:
    cols: list[str] = []
    for c in tree.columns:
        if c == "*":
            cols.append(f"{alias}.*")
            continue
        if catalog.column_type(table, c) is None:
            raise QueryError(f"unknown column {table}.{c}")
        cols.append(f"{alias}.{q(c)}")
    for rel, sub in tree.embeds:
        spec = RELATIONS.get((table, rel))
        if spec is None:
            raise QueryError(f"unknown relation {table}->{rel}")
        card, local, remote = spec
        sub_alias = aliases.next()
        inner_proj = _projection(catalog, rel, sub_alias, sub, rules, aliases)
        where = [f"{sub_alias}.{q(remote)} = {alias}.{q(local)}"]
        r = rules(rel)
        if r is not None:
            where.append(predicate(r.select, sub_alias))
        inner = (
            f"select {inner_proj} from public.{q(rel)} {sub_alias} "
            f"where {' and '.join(where)}"
        )
        if card == "one":
            cols.append(
                f"(select row_to_json(e) from ({inner} limit 1) e) as {q(rel)}"
            )
        else:
            cols.append(
                f"(select coalesce(json_agg(e), '[]'::json) from ({inner}) e) "
                f"as {q(rel)}"
            )
    if not cols:
        raise QueryError("empty select")
    return ", ".join(cols)


def build_select(
    catalog: Catalog,
    table: str,
    params_in: dict[str, Any],
    rules: RuleLookup,
) -> tuple[str, list[Any]]:
    """-> (sql returning one text JSON array, bind values)."""
    if not catalog.has_table(table):
        raise QueryError(f"unknown table {table}")
    params = Params()
    aliases = _Aliases()
    alias = aliases.next()
    tree = parse_select(params_in.get("select"))
    proj = _projection(catalog, table, alias, tree, rules, aliases)
    where = build_where(catalog, table, alias, params_in, params)
    r = rules(table)
    if r is not None:
        where.insert(0, predicate(r.select, alias))
    sql = f"select {proj} from public.{q(table)} {alias}"
    if where:
        sql += " where " + " and ".join(where)
    sql += build_order(catalog, table, alias, params_in.get("order"))
    if params_in.get("limit") is not None:
        sql += f" limit {_int_param(params_in['limit'], 'limit')}"
    if params_in.get("offset") is not None:
        sql += f" offset {_int_param(params_in['offset'], 'offset')}"
    wrapped = f"select coalesce(json_agg(r), '[]'::json)::text from ({sql}) r"
    return wrapped, params.values


def build_count(
    catalog: Catalog, table: str, filters: dict[str, Any]
) -> tuple[str, list[Any]]:
    if not catalog.has_table(table):
        raise QueryError(f"unknown table {table}")
    params = Params()
    where = build_where(catalog, table, "t1", filters, params)
    sql = f"select count(*) from public.{q(table)} t1"
    if where:
        sql += " where " + " and ".join(where)
    return sql, params.values


# ---------------------------------------------------------------------------
# INSERT / UPSERT / UPDATE / DELETE
# ---------------------------------------------------------------------------
def _check_cols(catalog: Catalog, table: str, cols: list[str]) -> None:
    for c in cols:
        if catalog.column_type(table, c) is None:
            raise QueryError(f"unknown column {table}.{c}")


def build_insert(
    catalog: Catalog,
    table: str,
    rows: list[dict[str, Any]],
    check_parts: tuple[str, ...] | None,
    *,
    on_conflict: str | None = None,
    update_using: tuple[str, ...] | None = None,
    update_check: tuple[str, ...] | None = None,
    apply_rules: bool = True,
) -> tuple[str, list[Any]]:
    """-> sql returning (json array text, all_checks_pass bool)."""
    if not catalog.has_table(table):
        raise QueryError(f"unknown table {table}")
    if not rows:
        raise QueryError("no rows")
    cols: list[str] = []
    for r in rows:
        for k in r:
            if k not in cols:
                cols.append(k)
    _check_cols(catalog, table, cols)
    params = Params()
    values_sql: list[str] = []
    for r in rows:
        vals = []
        for c in cols:
            if c in r:
                vals.append(params.add(r[c], catalog.columns[table][c]))
            else:
                vals.append("default")
        values_sql.append("(" + ", ".join(vals) + ")")
    sql = (
        f"insert into public.{q(table)} as t0 ({', '.join(q(c) for c in cols)}) "
        f"values {', '.join(values_sql)}"
    )
    if on_conflict:
        targets = [c.strip() for c in on_conflict.split(",") if c.strip()]
        _check_cols(catalog, table, targets)
        updatable = [c for c in cols if c not in targets]
        if updatable:
            sets = ", ".join(f"{q(c)} = excluded.{q(c)}" for c in updatable)
            sql += f" on conflict ({', '.join(q(c) for c in targets)}) do update set {sets}"
            if apply_rules:
                sql += " where " + predicate(update_using, "t0")
        else:
            sql += f" on conflict ({', '.join(q(c) for c in targets)}) do nothing"
    sql += " returning t0.*"
    if apply_rules:
        checks = [predicate(check_parts, "w")]
        if on_conflict and update_check:
            checks.append(predicate(update_check, "w"))
        check_sql = " and ".join(checks)
    else:
        check_sql = "true"
    wrapped = (
        f"with w as ({sql}) "
        f"select coalesce(json_agg(w), '[]'::json)::text, "
        f"coalesce(bool_and({check_sql}), true) from w"
    )
    return wrapped, params.values


def build_update(
    catalog: Catalog,
    table: str,
    filters: dict[str, Any],
    patch: dict[str, Any],
    using_parts: tuple[str, ...] | None,
    check_parts: tuple[str, ...] | None,
    *,
    apply_rules: bool = True,
) -> tuple[str, list[Any]]:
    if not catalog.has_table(table):
        raise QueryError(f"unknown table {table}")
    if not patch:
        raise QueryError("empty patch")
    _check_cols(catalog, table, list(patch))
    params = Params()
    sets = ", ".join(
        f"{q(c)} = {params.add(v, catalog.columns[table][c])}" for c, v in patch.items()
    )
    where = build_where(catalog, table, "t0", filters, params)
    if apply_rules:
        where.insert(0, predicate(using_parts, "t0"))
    sql = f"update public.{q(table)} as t0 set {sets}"
    if where:
        sql += " where " + " and ".join(where)
    sql += " returning t0.*"
    check_sql = (
        predicate(check_parts, "w") if (apply_rules and check_parts is not None) else "true"
    )
    wrapped = (
        f"with w as ({sql}) "
        f"select coalesce(json_agg(w), '[]'::json)::text, "
        f"coalesce(bool_and({check_sql}), true) from w"
    )
    return wrapped, params.values


def build_delete(
    catalog: Catalog,
    table: str,
    filters: dict[str, Any],
    using_parts: tuple[str, ...] | None,
    *,
    apply_rules: bool = True,
) -> tuple[str, list[Any]]:
    if not catalog.has_table(table):
        raise QueryError(f"unknown table {table}")
    params = Params()
    where = build_where(catalog, table, "t0", filters, params)
    if apply_rules:
        where.insert(0, predicate(using_parts, "t0"))
    sql = f"delete from public.{q(table)} as t0"
    if where:
        sql += " where " + " and ".join(where)
    sql += " returning t0.*"
    wrapped = (
        f"with w as ({sql}) select coalesce(json_agg(w), '[]'::json)::text from w"
    )
    return wrapped, params.values


# ---------------------------------------------------------------------------
# RPC
# ---------------------------------------------------------------------------
def build_rpc(catalog: Catalog, fn: str, args: dict[str, Any]) -> tuple[str, list[Any], str]:
    """-> (sql, bind values, return kind). Named-argument call."""
    candidates = catalog.functions.get(fn) or []
    info = None
    for cand in candidates:
        names = {n for n, _ in cand.args}
        if set(args) <= names:
            info = cand
            break
    if info is None:
        raise QueryError(f"unknown function {fn}({', '.join(args)})")
    params = Params()
    types = dict(info.args)
    call_args = ", ".join(
        f"{q(name)} => {params.add(value, types[name])}" for name, value in args.items()
    )
    call = f"public.{q(fn)}({call_args})"
    if info.returns == "set":
        sql = f"select coalesce(json_agg(r), '[]'::json)::text from {call} r"
    elif info.returns == "row":
        sql = f"select row_to_json(r)::text from {call} r"
    elif info.returns == "void":
        sql = f"select {call}"
    else:
        sql = f"select to_json({call})::text"
    return sql, params.values, info.returns
