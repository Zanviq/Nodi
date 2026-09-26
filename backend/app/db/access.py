"""Per-table permission rules for `UserClient` (replaces row level security).

The historical schema enforced permissions with Postgres row level security
policies. The database no longer has any; instead every `UserClient` statement
is rewritten here:

  SELECT         -> `WHERE (<select rule>) AND (<filters>)`
  UPDATE/DELETE  -> `WHERE (<using rule>) AND (<filters>)` (hidden rows are
                    simply not affected, exactly like before)
  INSERT/UPDATE  -> the written rows are re-checked against the <check rule>
                    inside the same transaction; a violation rolls back and
                    answers 403.
  embedded reads -> the embedded table's SELECT rule is applied too.

A command with NO rule is denied (SELECT/UPDATE/DELETE see zero rows, INSERT
answers 403), matching "no policy = no access". Rules are SQL predicates over
the row alias `{t}`; the caller identity is `app.current_user_id()`, which the
client sets per transaction (`set_config('app.user_id', ..., true)`). Helper
predicates (is_class_member / is_class_teacher / can_access_session /
is_admin) are the same SQL functions the policies used.

MIGRATED POLICIES (latest effective version after 0003 hardening, 0013 guard
and the 0024 initplan rewrite; policies of the same command are OR-combined):

  profiles        SELECT  profiles_select_own        id = uid
                  SELECT  profiles_select_admin      is_admin()
                  UPDATE  profiles_update_own        using/check id = uid
                          + 0003 column grant: only display_name, avatar_url
                  (no INSERT/DELETE policy — profile rows are created at register)
  classes         SELECT  classes_select_member      teacher_id = uid OR is_class_member(id)
                  INSERT  classes_insert_teacher     teacher_id = uid AND caller role = 'teacher'
                  UPDATE  classes_update_teacher     using/check teacher_id = uid
  class_members   SELECT  class_members_select       user_id = uid OR is_class_member(class_id)
                  DELETE  class_members_delete_self  user_id = uid
                  (class_members_insert_self dropped in 0003: join via join_class_by_code)
  sessions        SELECT  sessions_select            owner_id = uid OR (class AND is_class_teacher(space_ref))
                  SELECT  sessions_select_admin      is_admin()
                  INSERT  sessions_insert_owner      owner_id = uid AND (personal OR is_class_member(space_ref))
                  UPDATE  sessions_update_owner      using/check owner_id = uid
                  DELETE  sessions_delete_owner      owner_id = uid
  nodes           SELECT  nodes_select               can_access_session(session_id)
                  INSERT  nodes_insert_owner         session owned by uid
                  UPDATE  nodes_update_owner         using: session owned by uid (check = using)
                  DELETE  nodes_delete_owner         session owned by uid
  tags            ALL 4   tags_{select,insert,update,delete}_own   owner_id = uid
  node_tags       SELECT  node_tags_select           node's session can_access_session()
                  INSERT  node_tags_insert_owner     node's session owned by uid
                  DELETE  node_tags_delete_owner     node's session owned by uid
  ai_sessions     SELECT  ai_sessions_select_own     owner_id = uid
                  SELECT  ai_sessions_select_admin   is_admin()
                  INSERT  ai_sessions_insert_own     owner_id = uid
  ai_steps        SELECT  ai_steps_select_own        parent ai_session owned by uid
                  SELECT  ai_steps_select_admin      is_admin()
                  INSERT  ai_steps_insert_own        parent ai_session owned by uid
  app_settings    SELECT/INSERT/UPDATE  app_settings_admin_{select,insert,update}  is_admin()
  files           SELECT  files_select_own           owner_id = uid
                  SELECT  files_select_class         class_material AND is_class_member(space_ref)
                  INSERT  files_insert_own           owner_id = uid AND (not class_material OR is_class_teacher(space_ref))
                  UPDATE  files_update_own           using/check owner_id = uid
                  DELETE  files_delete_own           owner_id = uid
  file_chunks     SELECT  file_chunks_select_own     parent file owned by uid
                  SELECT  file_chunks_select_class   parent file is class_material of a class uid belongs to
                  (writes: system client only)
  jobs            SELECT  jobs_select_own            owner_id = uid OR is_admin()
  file_node_links SELECT/INSERT/DELETE  file_node_links_*_own   owner_id = uid
  file_tags       SELECT  file_tags_select_own       parent file owned by uid
  ai_logs         SELECT  ai_logs_select_own         owner_id = uid
                  SELECT  ai_logs_select_admin       is_admin()
                  INSERT  ai_logs_insert_own         owner_id = uid
  file_graph_nodes ALL 4  fgn_{select,insert,update,delete}_own    owner_id = uid
  users           (new) no user access at all — only the auth code touches it.

Dropped with the platform (no equivalent needed): the storage.objects policies
files_objects_{select,insert,delete}_own (files are served only through the
backend, which checks ownership), and the realtime publication on ai_logs.
"""

from __future__ import annotations

from dataclasses import dataclass, field

UID = "(select app.current_user_id())"
IS_ADMIN = "public.is_admin()"


@dataclass(frozen=True)
class TableRules:
    select: tuple[str, ...] = ()
    insert_check: tuple[str, ...] = ()
    update_using: tuple[str, ...] = ()
    # None -> the UPDATE has no WITH CHECK (only USING applies).
    update_check: tuple[str, ...] | None = None
    delete: tuple[str, ...] = ()
    # When set, UPDATE may only touch these columns (column-level grant).
    update_columns: frozenset[str] | None = field(default=None)


def _own(col: str = "owner_id") -> str:
    return f"{{t}}.{col} = {UID}"


_SESSION_OWNED = (
    "exists (select 1 from public.sessions s "
    "where s.id = {t}.session_id and s.owner_id = " + UID + ")"
)
_NODE_SESSION_OWNED = (
    "exists (select 1 from public.nodes n join public.sessions s "
    "on s.id = n.session_id where n.id = {t}.node_id and s.owner_id = " + UID + ")"
)
_AI_SESSION_OWNED = (
    "exists (select 1 from public.ai_sessions s "
    "where s.id = {t}.ai_session_id and s.owner_id = " + UID + ")"
)
_FILE_OWNED = (
    "exists (select 1 from public.files f "
    "where f.id = {t}.file_id and f.owner_id = " + UID + ")"
)
_FILE_CLASS_MATERIAL = (
    "exists (select 1 from public.files f where f.id = {t}.file_id "
    "and f.kind = 'class_material' and public.is_class_member(f.space_ref))"
)


RULES: dict[str, TableRules] = {
    "profiles": TableRules(
        select=(_own("id"), IS_ADMIN),
        update_using=(_own("id"),),
        update_check=(_own("id"),),
        update_columns=frozenset({"display_name", "avatar_url"}),
    ),
    "classes": TableRules(
        select=(_own("teacher_id"), "public.is_class_member({t}.id)"),
        insert_check=(
            _own("teacher_id")
            + " and exists (select 1 from public.profiles p where p.id = "
            + UID
            + " and p.role = 'teacher')",
        ),
        update_using=(_own("teacher_id"),),
        update_check=(_own("teacher_id"),),
    ),
    "class_members": TableRules(
        select=(_own("user_id"), "public.is_class_member({t}.class_id)"),
        delete=(_own("user_id"),),
    ),
    "sessions": TableRules(
        select=(
            _own(),
            "({t}.space_kind = 'class' and public.is_class_teacher({t}.space_ref))",
            IS_ADMIN,
        ),
        insert_check=(
            _own()
            + " and ({t}.space_kind = 'personal' "
            "or public.is_class_member({t}.space_ref))",
        ),
        update_using=(_own(),),
        update_check=(_own(),),
        delete=(_own(),),
    ),
    "nodes": TableRules(
        select=("public.can_access_session({t}.session_id)",),
        insert_check=(_SESSION_OWNED,),
        update_using=(_SESSION_OWNED,),
        update_check=(_SESSION_OWNED,),
        delete=(_SESSION_OWNED,),
    ),
    "tags": TableRules(
        select=(_own(),),
        insert_check=(_own(),),
        update_using=(_own(),),
        update_check=(_own(),),
        delete=(_own(),),
    ),
    "node_tags": TableRules(
        select=(
            "exists (select 1 from public.nodes n where n.id = {t}.node_id "
            "and public.can_access_session(n.session_id))",
        ),
        insert_check=(_NODE_SESSION_OWNED,),
        delete=(_NODE_SESSION_OWNED,),
    ),
    "ai_sessions": TableRules(
        select=(_own(), IS_ADMIN),
        insert_check=(_own(),),
    ),
    "ai_steps": TableRules(
        select=(_AI_SESSION_OWNED, IS_ADMIN),
        insert_check=(_AI_SESSION_OWNED,),
    ),
    "app_settings": TableRules(
        select=(IS_ADMIN,),
        insert_check=(IS_ADMIN,),
        update_using=(IS_ADMIN,),
        update_check=(IS_ADMIN,),
    ),
    "files": TableRules(
        select=(
            _own(),
            "({t}.kind = 'class_material' and public.is_class_member({t}.space_ref))",
        ),
        insert_check=(
            _own()
            + " and ({t}.kind <> 'class_material' "
            "or public.is_class_teacher({t}.space_ref))",
        ),
        update_using=(_own(),),
        update_check=(_own(),),
        delete=(_own(),),
    ),
    "file_chunks": TableRules(
        select=(_FILE_OWNED, _FILE_CLASS_MATERIAL),
    ),
    "jobs": TableRules(
        select=(_own() + " or " + IS_ADMIN,),
    ),
    "file_node_links": TableRules(
        select=(_own(),),
        insert_check=(_own(),),
        delete=(_own(),),
    ),
    "file_tags": TableRules(
        select=(_FILE_OWNED,),
    ),
    "ai_logs": TableRules(
        select=(_own(), IS_ADMIN),
        insert_check=(_own(),),
    ),
    "file_graph_nodes": TableRules(
        select=(_own(),),
        insert_check=(_own(),),
        update_using=(_own(),),
        update_check=(_own(),),
        delete=(_own(),),
    ),
    # New in the self-hosted schema: never readable/writable through UserClient.
    "users": TableRules(),
}

# RPCs a UserClient may call (everything else is refused). The functions keep
# their own internal ownership checks (they read app.current_user_id()).
USER_RPCS: frozenset[str] = frozenset(
    {
        "add_node_connection",
        "admin_set_user_role",
        "admin_token_usage",
        "append_chat_node",
        "can_access_session",
        "class_students",
        "create_class",
        "delete_file_cascade",
        "get_chunk_context",
        "get_file_tags",
        "is_admin",
        "is_class_member",
        "is_class_teacher",
        "join_class_by_code",
        "mark_onboarded",
        "remove_node_connection",
        "search_file_chunks",
        "set_node_positions_bulk",
        "tag_cooccurrence",
        "teacher_class_overview",
        "teacher_classes",
        "upsert_file_tags",
        "upsert_node_tags",
    }
)


def rules_for(table: str) -> TableRules:
    # Unknown tables get no rules at all -> deny everything.
    return RULES.get(table, TableRules())


def predicate(parts: tuple[str, ...] | None, alias: str) -> str:
    """OR-combine rule parts for a row alias. Empty -> `false` (deny)."""
    if not parts:
        return "false"
    return "(" + " or ".join(f"({p.format(t=alias)})" for p in parts) + ")"
