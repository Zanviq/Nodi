-- migrate:up
-- ============================================================================
-- nodi — baseline schema (plain PostgreSQL 16 + pgvector)
--
-- Squashes the historical migrations 0001..0026 into ONE Postgres-native
-- baseline reproducing their FINAL effective schema:
--   * tables / columns / constraints / indexes (incl. the FK covering indexes);
--   * SQL functions in their latest version.
--
-- Differences from the historical chain (intentional):
--   * Accounts live in `public.users` (username + bcrypt hash). `profiles.id`
--     references `users(id)`; the profile row is created by the register
--     endpoint in the same transaction (no signup trigger).
--   * No row level security, policies, role grants, storage buckets or
--     realtime publication. Permission rules are enforced by the backend access
--     layer (backend/app/db/access.py), which reproduces the former policies.
--   * The caller identity is read from the transaction-local setting
--     `app.user_id` via `app.current_user_id()`. The backend sets it with
--     `select set_config('app.user_id', <uuid>, true)` before every query/RPC.
--     System (worker) calls set `app.role = 'service'` instead (`app.is_service()`).
--   * files.status gains 'needs_key': text is stored/chunked but embeddings were
--     skipped because no Gemini key was supplied with the upload.
--   * set_node_positions_bulk checks session ownership itself (it used to rely
--     on row level security as SECURITY INVOKER).
-- ============================================================================

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 0. Request identity helpers
-- ---------------------------------------------------------------------------
create schema if not exists app;

-- Current caller (uuid) for this transaction, or NULL when unset.
create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('app.user_id', true), '')::uuid;
$$;

-- True when the current transaction runs as the trusted system/worker client.
create or replace function app.is_service()
returns boolean
language sql
stable
as $$
    select coalesce(current_setting('app.role', true), '') = 'service';
$$;

-- ---------------------------------------------------------------------------
-- 1. users (login accounts) + profiles (app-level profile, 1:1)
-- ---------------------------------------------------------------------------
create table public.users (
    id            uuid primary key default gen_random_uuid(),
    username      text not null,
    password_hash text not null,
    created_at    timestamptz not null default now()
);

create unique index users_username_lower_uniq on public.users (lower(username));

create table public.profiles (
    id            uuid primary key references public.users (id) on delete cascade,
    email         text,
    -- APP role: student | teacher | admin
    role          text not null default 'student'
                    check (role in ('student', 'teacher', 'admin')),
    display_name  text,
    avatar_url    text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now(),
    onboarded     boolean not null default false
);

-- ---------------------------------------------------------------------------
-- 2. classes / class_members
-- ---------------------------------------------------------------------------
create table public.classes (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    join_code   text not null unique,
    teacher_id  uuid references public.profiles (id) on delete set null,
    created_at  timestamptz not null default now()
);

create table public.class_members (
    class_id      uuid not null references public.classes (id) on delete cascade,
    user_id       uuid not null references public.profiles (id) on delete cascade,
    role_in_class text not null default 'student'
                    check (role_in_class in ('student', 'teacher')),
    created_at    timestamptz not null default now(),
    primary key (class_id, user_id)
);

-- ---------------------------------------------------------------------------
-- 3. sessions / nodes (conversation tree)
-- ---------------------------------------------------------------------------
create table public.sessions (
    id              uuid primary key default gen_random_uuid(),
    owner_id        uuid not null references public.profiles (id) on delete cascade,
    space_kind      text not null default 'personal'
                      check (space_kind in ('personal', 'class')),
    -- personal -> owner's user id; class -> classes.id
    space_ref       uuid,
    title           text,
    emoji           text,
    root_node_id    uuid,
    current_head_id uuid,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table public.nodes (
    id                 uuid primary key default gen_random_uuid(),
    session_id         uuid not null references public.sessions (id) on delete cascade,
    parent_id          uuid references public.nodes (id) on delete cascade,
    question           text,
    answer             text,
    label              text,
    position_x         double precision,
    position_y         double precision,
    is_navigator       boolean not null default false,
    navigator_question text,
    connections        uuid[] not null default '{}',
    attachments        jsonb  not null default '{}'::jsonb,
    created_at         timestamptz not null default now(),
    rag_sources        jsonb not null default '[]'::jsonb,
    navigator_meta     jsonb not null default '{}'::jsonb,
    reference_sources  jsonb not null default '[]'::jsonb
);

alter table public.sessions
    add constraint sessions_root_node_id_fkey
        foreign key (root_node_id) references public.nodes (id) on delete set null,
    add constraint sessions_current_head_id_fkey
        foreign key (current_head_id) references public.nodes (id) on delete set null;

-- ---------------------------------------------------------------------------
-- 4. concept tags
-- ---------------------------------------------------------------------------
create table public.tags (
    id          uuid primary key default gen_random_uuid(),
    owner_id    uuid not null references public.profiles (id) on delete cascade,
    space_kind  text not null default 'personal'
                  check (space_kind in ('personal', 'class')),
    space_ref   uuid,
    name        text not null,
    usage_count integer not null default 0,
    created_at  timestamptz not null default now(),
    norm_name   text
);

create table public.node_tags (
    node_id    uuid not null references public.nodes (id) on delete cascade,
    tag_id     uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (node_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- 5. AI traces (ReAct) + runtime settings
-- ---------------------------------------------------------------------------
create table public.ai_sessions (
    id         uuid primary key default gen_random_uuid(),
    owner_id   uuid not null references public.profiles (id) on delete cascade,
    session_id uuid references public.sessions (id) on delete set null,
    kind       text not null,
    created_at timestamptz not null default now()
);

create table public.ai_steps (
    id            uuid primary key default gen_random_uuid(),
    ai_session_id uuid not null references public.ai_sessions (id) on delete cascade,
    seq           integer not null,
    thought       text,
    skill         text,
    input         jsonb not null default '{}'::jsonb,
    observation   jsonb not null default '{}'::jsonb,
    tokens        integer,
    created_at    timestamptz not null default now()
);

create table public.app_settings (
    key        text primary key,
    value      jsonb not null,
    updated_at timestamptz not null default now(),
    updated_by uuid references public.profiles (id) on delete set null
);

-- ---------------------------------------------------------------------------
-- 6. files / chunks (pgvector) / jobs / RAG links / file tags / placements
-- ---------------------------------------------------------------------------
create table public.files (
    id           uuid primary key default gen_random_uuid(),
    owner_id     uuid not null references public.profiles (id) on delete cascade,
    space_kind   text not null default 'personal'
                   check (space_kind in ('personal', 'class')),
    space_ref    uuid,
    uploader_id  uuid references public.profiles (id) on delete set null,
    kind         text not null default 'user_upload'
                   check (kind in ('user_upload', 'class_material')),
    storage_path text not null,
    mime         text,
    size_bytes   bigint,
    status       text not null default 'uploaded'
                   check (status in ('uploaded', 'splitting', 'embedding',
                                     'indexed', 'partial', 'failed', 'needs_key')),
    chunk_total  integer not null default 0,
    chunk_done   integer not null default 0,
    error        text,
    created_at   timestamptz not null default now(),
    updated_at   timestamptz not null default now(),
    session_id   uuid references public.sessions (id) on delete set null,
    position_x   double precision,
    position_y   double precision
);

create table public.file_chunks (
    id         uuid primary key default gen_random_uuid(),
    file_id    uuid not null references public.files (id) on delete cascade,
    seq        integer not null,
    chunk_text text not null,
    embedding  vector(768),
    status     text not null default 'pending'
                 check (status in ('pending', 'embedded', 'failed')),
    meta       jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    unique (file_id, seq)
);

create table public.jobs (
    id            uuid primary key default gen_random_uuid(),
    owner_id      uuid references public.profiles (id) on delete cascade,
    kind          text not null
                    check (kind in ('embedding_split', 'embedding_batch')),
    target_id     uuid,
    parent_job_id uuid references public.jobs (id) on delete cascade,
    batch_range   jsonb,
    status        text not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'failed')),
    error         text,
    progress      integer not null default 0,
    attempts      integer not null default 0,
    space_ref     uuid,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

create table public.file_node_links (
    id             uuid primary key default gen_random_uuid(),
    file_id        uuid not null references public.files (id) on delete cascade,
    target_node_id uuid not null references public.nodes (id) on delete cascade,
    owner_id       uuid not null references public.profiles (id) on delete cascade,
    created_at     timestamptz not null default now(),
    unique (file_id, target_node_id)
);

create table public.file_tags (
    file_id    uuid not null references public.files (id) on delete cascade,
    tag_id     uuid not null references public.tags (id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (file_id, tag_id)
);

create table public.ai_logs (
    id             uuid primary key default gen_random_uuid(),
    owner_id       uuid not null references public.profiles (id) on delete cascade,
    session_id     uuid references public.sessions (id) on delete set null,
    node_id        uuid references public.nodes (id) on delete set null,
    kind           text not null default 'chat',
    system_prompt  text,
    question       text,
    answer         text,
    contexts       jsonb not null default '{}'::jsonb,
    skill_calls    jsonb not null default '[]'::jsonb,
    errors         jsonb not null default '[]'::jsonb,
    token_estimate integer,
    created_at     timestamptz not null default now()
);

create table public.file_graph_nodes (
    id          uuid primary key default gen_random_uuid(),
    file_id     uuid not null references public.files (id)    on delete cascade,
    session_id  uuid not null references public.sessions (id) on delete cascade,
    owner_id    uuid not null references public.profiles (id) on delete cascade,
    position_x  double precision,
    position_y  double precision,
    created_at  timestamptz not null default now(),
    unique (file_id, session_id)
);

-- ---------------------------------------------------------------------------
-- 7. Indexes
-- ---------------------------------------------------------------------------
create index idx_nodes_session_id      on public.nodes (session_id);
create index idx_nodes_parent_id       on public.nodes (parent_id);
create index idx_sessions_owner_id     on public.sessions (owner_id);
create index idx_sessions_space        on public.sessions (space_kind, space_ref);
create index idx_class_members_user_id on public.class_members (user_id);

create unique index tags_owner_space_name_uniq
    on public.tags (owner_id, space_kind, space_ref, lower(name));
create unique index tags_owner_space_norm_uniq
    on public.tags (owner_id, space_kind, space_ref, norm_name);
create index idx_tags_owner_space  on public.tags (owner_id, space_kind, space_ref);
create index idx_node_tags_tag_id  on public.node_tags (tag_id);
create index idx_node_tags_node_id on public.node_tags (node_id);

create index idx_ai_sessions_owner   on public.ai_sessions (owner_id);
create index idx_ai_sessions_session on public.ai_sessions (session_id);
create index idx_ai_steps_session    on public.ai_steps (ai_session_id, seq);

create index idx_files_owner    on public.files (owner_id);
create index idx_files_space    on public.files (space_kind, space_ref);
create index idx_files_session  on public.files (session_id);
create index idx_files_uploader on public.files (uploader_id);

create index idx_file_chunks_file   on public.file_chunks (file_id, seq);
create index idx_file_chunks_status on public.file_chunks (status);
create index idx_file_chunks_embedding
    on public.file_chunks using hnsw (embedding vector_cosine_ops);

create index idx_jobs_status on public.jobs (status, created_at);
create index idx_jobs_owner  on public.jobs (owner_id);
create index idx_jobs_target on public.jobs (target_id);

create index idx_file_node_links_node on public.file_node_links (target_node_id);
create index idx_file_node_links_file on public.file_node_links (file_id);
create index idx_fnl_owner            on public.file_node_links (owner_id);
create index idx_file_tags_tag        on public.file_tags (tag_id);

create index idx_ai_logs_owner_created   on public.ai_logs (owner_id, created_at desc);
create index idx_ai_logs_created         on public.ai_logs (created_at desc);
create index idx_ai_logs_session         on public.ai_logs (session_id);
create index idx_ai_logs_session_created on public.ai_logs (session_id, created_at desc);
create index idx_ai_logs_node            on public.ai_logs (node_id);

create index idx_fgn_session on public.file_graph_nodes (session_id);
create index idx_fgn_file    on public.file_graph_nodes (file_id);
create index idx_fgn_owner   on public.file_graph_nodes (owner_id);

create index idx_sessions_current_head on public.sessions (current_head_id);
create index idx_sessions_root_node    on public.sessions (root_node_id);
create index idx_classes_teacher       on public.classes (teacher_id);

-- ---------------------------------------------------------------------------
-- 8. Membership / access predicates (used by the backend access layer + RPCs)
-- ---------------------------------------------------------------------------
create or replace function public.is_class_member(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = app.current_user_id()
    );
$$;

create or replace function public.is_class_teacher(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.class_members cm
        where cm.class_id = p_class_id
          and cm.user_id  = app.current_user_id()
          and cm.role_in_class = 'teacher'
    )
    or exists (
        select 1 from public.classes c
        where c.id = p_class_id
          and c.teacher_id = app.current_user_id()
    );
$$;

-- Owner, or TEACHER of the session's class (students do not see each other's).
create or replace function public.can_access_session(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1
        from public.sessions s
        where s.id = p_session_id
          and (
                s.owner_id = app.current_user_id()
             or (s.space_kind = 'class' and public.is_class_teacher(s.space_ref))
          )
    );
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = app.current_user_id() and role = 'admin'
    );
$$;

-- ---------------------------------------------------------------------------
-- 9. Class join / creation
-- ---------------------------------------------------------------------------
create or replace function public.join_class_by_code(p_code text)
returns public.class_members
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid      uuid := app.current_user_id();
    v_class_id uuid;
    v_row      public.class_members;
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;

    select id into v_class_id
    from public.classes
    where join_code = p_code;

    if v_class_id is null then
        raise exception 'invalid_join_code' using errcode = 'P0002';
    end if;

    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_class_id, v_uid, 'student')
    on conflict (class_id, user_id) do nothing;

    select * into v_row
    from public.class_members
    where class_id = v_class_id and user_id = v_uid;

    return v_row;
end;
$$;

-- 6 chars from a confusable-free alphabet (no I/L/O/0/1), drawn from
-- pgcrypto's CSPRNG (gen_random_bytes) rather than random().
create or replace function public.nodi_gen_join_code()
returns text
language sql
volatile
set search_path = public
as $$
    select string_agg(
        substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
               1 + (get_byte(b.bytes, i - 1) % 31), 1),
        ''
    )
    from (select gen_random_bytes(6) as bytes) b,
         generate_series(1, 6) as i;
$$;

create or replace function public.create_class(p_name text)
returns public.classes
language plpgsql
security definer
set search_path = public
as $$
declare
    v_uid   uuid := app.current_user_id();
    v_role  text;
    v_name  text := nullif(btrim(p_name), '');
    v_code  text;
    v_row   public.classes;
    v_tries int := 0;
begin
    if v_uid is null then
        raise exception 'not_authenticated' using errcode = '28000';
    end if;
    select role into v_role from public.profiles where id = v_uid;
    if v_role is distinct from 'teacher' then
        raise exception 'teacher role required' using errcode = 'insufficient_privilege';
    end if;
    if v_name is null then
        raise exception 'class name required' using errcode = 'check_violation';
    end if;

    loop
        v_tries := v_tries + 1;
        v_code := public.nodi_gen_join_code();
        begin
            insert into public.classes (name, join_code, teacher_id)
            values (v_name, v_code, v_uid)
            returning * into v_row;
            exit;
        exception when unique_violation then
            if v_tries >= 8 then
                raise exception 'could not allocate a unique join code'
                    using errcode = 'unique_violation';
            end if;
        end;
    end loop;

    insert into public.class_members (class_id, user_id, role_in_class)
    values (v_row.id, v_uid, 'teacher')
    on conflict (class_id, user_id) do nothing;

    return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Chat tree RPCs
-- ---------------------------------------------------------------------------
-- Insert one (Q+A) node AND advance the session head/root atomically.
create or replace function public.append_chat_node(
    p_session_id uuid,
    p_parent_id  uuid,
    p_question   text,
    p_answer     text,
    p_label      text default null
)
returns public.nodes
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner    uuid;
    v_has_root uuid;
    v_node     public.nodes;
begin
    select owner_id, root_node_id
      into v_owner, v_has_root
      from public.sessions
     where id = p_session_id
     for update;

    if v_owner is null then
        raise exception 'session not found' using errcode = 'no_data_found';
    end if;
    if v_owner is distinct from app.current_user_id() then
        raise exception 'not session owner' using errcode = 'insufficient_privilege';
    end if;

    if p_parent_id is not null then
        if not exists (
            select 1 from public.nodes n
            where n.id = p_parent_id and n.session_id = p_session_id
        ) then
            raise exception 'parent node not in session'
                using errcode = 'foreign_key_violation';
        end if;
    end if;

    insert into public.nodes (session_id, parent_id, question, answer, label)
    values (p_session_id, p_parent_id, p_question, p_answer, p_label)
    returning * into v_node;

    update public.sessions
       set current_head_id = v_node.id,
           root_node_id     = coalesce(root_node_id, v_node.id),
           updated_at       = now()
     where id = p_session_id;

    return v_node;
end;
$$;

create or replace function public.add_node_connection(
    p_node_id        uuid,
    p_source_node_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_conn uuid[];
begin
    if p_node_id = p_source_node_id then
        raise exception 'cannot connect a node to itself'
            using errcode = 'check_violation';
    end if;

    select n.connections
      into v_conn
      from public.nodes n
      join public.sessions s on s.id = n.session_id
     where n.id = p_node_id and s.owner_id = app.current_user_id()
     for update of n;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    if not exists (
        select 1
          from public.nodes n2
          join public.sessions s2 on s2.id = n2.session_id
         where n2.id = p_source_node_id and s2.owner_id = app.current_user_id()
    ) then
        raise exception 'source node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;

    v_conn := coalesce(v_conn, array[]::uuid[]);
    if not (p_source_node_id = any (v_conn)) then
        update public.nodes
           set connections = array_append(connections, p_source_node_id)
         where id = p_node_id
         returning connections into v_conn;
    end if;

    return v_conn;
end;
$$;

create or replace function public.remove_node_connection(
    p_node_id        uuid,
    p_source_node_id uuid
)
returns uuid[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_conn uuid[];
begin
    update public.nodes n
       set connections = array_remove(n.connections, p_source_node_id)
      from public.sessions s
     where n.id = p_node_id
       and s.id = n.session_id
       and s.owner_id = app.current_user_id()
     returning n.connections into v_conn;
    if not found then
        raise exception 'target node not found or not owned'
            using errcode = 'insufficient_privilege';
    end if;
    return v_conn;
end;
$$;

-- Persist many node coordinates in one statement. Non-uuid ids / non-numeric
-- coordinates are skipped BEFORE any ::uuid cast. Only nodes of a session owned
-- by the caller are updated (ownership check formerly done by row security).
create or replace function public.set_node_positions_bulk(
    p_session_id uuid,
    p_positions  jsonb   -- [{"node_id": uuid, "x": number, "y": number}, ...]
)
returns integer
language sql
set search_path = public
as $$
    with input as (
        select e
          from jsonb_array_elements(coalesce(p_positions, '[]'::jsonb)) e
         where (e->>'node_id') ~*
                 '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           and jsonb_typeof(e->'x') = 'number'
           and jsonb_typeof(e->'y') = 'number'
    ),
    upd as (
        update public.nodes n
           set position_x = (i.e->>'x')::double precision,
               position_y = (i.e->>'y')::double precision
          from input i
         where n.id = (i.e->>'node_id')::uuid
           and n.session_id = p_session_id
           and exists (
               select 1 from public.sessions s
                where s.id = p_session_id
                  and s.owner_id = app.current_user_id()
           )
        returning n.id
    )
    select count(*)::int from upd;
$$;

-- ---------------------------------------------------------------------------
-- 11. Concept tags
-- ---------------------------------------------------------------------------
-- NFKC -> lower -> collapse whitespace -> strip surrounding punctuation/space.
create or replace function public.nodi_norm_tag(p_in text)
returns text
language sql
immutable
set search_path = public
as $$
    select nullif(
        btrim(
            regexp_replace(
                regexp_replace(
                    lower(normalize(coalesce(p_in, ''), NFKC)),
                    '\s+', ' ', 'g'
                ),
                '^[[:punct:][:space:]]+|[[:punct:][:space:]]+$', '', 'g'
            )
        ),
        ''
    );
$$;

create or replace function public.upsert_node_tags(
    p_node_id    uuid,
    p_session_id uuid,
    p_names      text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner  uuid;
    v_kind   text;
    v_ref    uuid;
    v_name   text;
    v_norm   text;
    v_tag_id uuid;
    v_stored text;
    v_result text[] := '{}';
begin
    select owner_id, space_kind, space_ref
      into v_owner, v_kind, v_ref
      from public.sessions
     where id = p_session_id;

    if v_owner is null then
        raise exception 'session not found' using errcode = 'no_data_found';
    end if;
    if v_owner is distinct from app.current_user_id() then
        raise exception 'not session owner' using errcode = 'insufficient_privilege';
    end if;
    if not exists (
        select 1 from public.nodes n
        where n.id = p_node_id and n.session_id = p_session_id
    ) then
        raise exception 'node not in session' using errcode = 'foreign_key_violation';
    end if;

    foreach v_name in array coalesce(p_names, array[]::text[]) loop
        v_name := nullif(btrim(v_name), '');
        if v_name is null then
            continue;
        end if;
        v_norm := public.nodi_norm_tag(v_name);
        if v_norm is null then
            continue;
        end if;

        v_tag_id := null;
        select id, name into v_tag_id, v_stored
          from public.tags
         where owner_id = v_owner
           and space_kind = v_kind
           and space_ref is not distinct from v_ref
           and norm_name = v_norm
         limit 1;

        if v_tag_id is null then
            insert into public.tags (owner_id, space_kind, space_ref, name, norm_name, usage_count)
            values (v_owner, v_kind, v_ref, v_name, v_norm, 0)
            on conflict (owner_id, space_kind, space_ref, norm_name) do update
                set name = public.tags.name
            returning id, name into v_tag_id, v_stored;
        end if;

        insert into public.node_tags (node_id, tag_id)
        values (p_node_id, v_tag_id)
        on conflict (node_id, tag_id) do nothing;

        if found then
            update public.tags
               set usage_count = usage_count + 1
             where id = v_tag_id;
        end if;

        v_result := array_append(v_result, v_stored);
    end loop;

    return v_result;
end;
$$;

create or replace function public.tag_cooccurrence(
    p_space_kind text,
    p_space_ref  uuid
)
returns table (
    tag_a  uuid,
    tag_b  uuid,
    name_a text,
    name_b text,
    count  bigint
)
language sql
stable
security definer
set search_path = public
as $$
    select na.tag_id, nb.tag_id, t1.name, t2.name, count(*)::bigint
      from public.node_tags na
      join public.node_tags nb
        on na.node_id = nb.node_id and na.tag_id < nb.tag_id
      join public.tags t1 on t1.id = na.tag_id
      join public.tags t2 on t2.id = nb.tag_id
     where t1.owner_id = app.current_user_id()
       and t2.owner_id = app.current_user_id()
       and t1.space_kind = p_space_kind
       and t2.space_kind = p_space_kind
       and t1.space_ref is not distinct from p_space_ref
       and t2.space_ref is not distinct from p_space_ref
     group by na.tag_id, nb.tag_id, t1.name, t2.name
     order by count(*) desc;
$$;

-- ---------------------------------------------------------------------------
-- 12. Profiles / admin
-- ---------------------------------------------------------------------------
create or replace function public.mark_onboarded()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
    update public.profiles
       set onboarded = true, updated_at = now()
     where id = app.current_user_id();
    return found;
end;
$$;

create or replace function public.admin_set_user_role(
    p_user_id uuid,
    p_role    text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
    v_row public.profiles;
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    if p_role not in ('student', 'teacher', 'admin') then
        raise exception 'invalid role' using errcode = 'check_violation';
    end if;
    if p_user_id = app.current_user_id() and p_role <> 'admin' then
        raise exception 'cannot change your own admin role'
            using errcode = 'check_violation';
    end if;

    update public.profiles
       set role = p_role, updated_at = now()
     where id = p_user_id
     returning * into v_row;
    if not found then
        raise exception 'user not found' using errcode = 'no_data_found';
    end if;
    return v_row;
end;
$$;

-- Token totals per user (ai_steps.tokens: ReAct skill steps only — PARTIAL).
create or replace function public.admin_token_usage()
returns table (
    owner_id     uuid,
    email        text,
    username     text,
    display_name text,
    total_tokens bigint,
    step_count   bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
    if not public.is_admin() then
        raise exception 'admin only' using errcode = 'insufficient_privilege';
    end if;
    return query
        select s.owner_id,
               p.email,
               u.username,
               p.display_name,
               coalesce(sum(st.tokens), 0)::bigint as total_tokens,
               count(st.*)::bigint as step_count
          from public.ai_sessions s
          join public.ai_steps st on st.ai_session_id = s.id
          left join public.profiles p on p.id = s.owner_id
          left join public.users u on u.id = s.owner_id
         group by s.owner_id, p.email, u.username, p.display_name
         order by total_tokens desc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. Teacher console
-- ---------------------------------------------------------------------------
create or replace function public.teacher_classes()
returns table (
    id            uuid,
    name          text,
    join_code     text,
    created_at    timestamptz,
    student_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
    select c.id,
           c.name,
           c.join_code,
           c.created_at,
           (
               select count(*)
                 from public.class_members m
                where m.class_id = c.id and m.role_in_class = 'student'
           )::bigint as student_count
      from public.classes c
     where public.is_class_teacher(c.id)
     order by c.created_at desc;
$$;

create or replace function public.class_students(p_class_id uuid)
returns table (
    user_id       uuid,
    email         text,
    username      text,
    display_name  text,
    avatar_url    text,
    role_in_class text,
    joined_at     timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select cm.user_id,
           p.email,
           u.username,
           p.display_name,
           p.avatar_url,
           cm.role_in_class,
           cm.created_at
      from public.class_members cm
      join public.profiles p on p.id = cm.user_id
      left join public.users u on u.id = cm.user_id
     where cm.class_id = p_class_id
       and cm.role_in_class = 'student'
       and public.is_class_teacher(p_class_id)
     order by p.display_name nulls last, cm.created_at;
$$;

create or replace function public.teacher_class_overview()
returns table (
    id               uuid,
    name             text,
    join_code        text,
    created_at       timestamptz,
    student_count    bigint,
    material_count   bigint,
    last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
    select c.id,
           c.name,
           c.join_code,
           c.created_at,
           (
               select count(*)
                 from public.class_members m
                where m.class_id = c.id
                  and m.role_in_class = 'student'
           )::bigint as student_count,
           (
               select count(*)
                 from public.files f
                where f.kind = 'class_material'
                  and f.space_kind = 'class'
                  and f.space_ref = c.id
           )::bigint as material_count,
           greatest(
               (
                   select max(s.updated_at)
                     from public.sessions s
                    where s.space_kind = 'class'
                      and s.space_ref = c.id
               ),
               (
                   select max(f.created_at)
                     from public.files f
                    where f.kind = 'class_material'
                      and f.space_kind = 'class'
                      and f.space_ref = c.id
               )
           ) as last_activity_at
      from public.classes c
     where public.is_class_teacher(c.id)
     order by last_activity_at desc nulls last, c.created_at desc;
$$;

-- ---------------------------------------------------------------------------
-- 14. Files: tags, search, chunk context, delete cascade
-- ---------------------------------------------------------------------------
-- Callable by the file OWNER or the system client (app.is_service()).
create or replace function public.upsert_file_tags(
    p_file_id uuid,
    p_names   text[]
)
returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner  uuid;
    v_kind   text;
    v_ref    uuid;
    v_name   text;
    v_norm   text;
    v_tag_id uuid;
    v_stored text;
    v_result text[] := '{}';
    v_count  int := 0;
begin
    select owner_id, space_kind, space_ref
      into v_owner, v_kind, v_ref
      from public.files
     where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if not app.is_service() and v_owner is distinct from app.current_user_id() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    foreach v_name in array coalesce(p_names, array[]::text[]) loop
        exit when v_count >= 50;
        v_name := nullif(btrim(v_name), '');
        if v_name is null then
            continue;
        end if;
        v_norm := public.nodi_norm_tag(v_name);
        if v_norm is null then
            continue;
        end if;

        v_tag_id := null;
        select id, name into v_tag_id, v_stored
          from public.tags
         where owner_id = v_owner
           and space_kind = v_kind
           and space_ref is not distinct from v_ref
           and norm_name = v_norm
         limit 1;

        if v_tag_id is null then
            insert into public.tags (owner_id, space_kind, space_ref, name, norm_name, usage_count)
            values (v_owner, v_kind, v_ref, v_name, v_norm, 0)
            on conflict (owner_id, space_kind, space_ref, norm_name) do update
                set name = public.tags.name
            returning id, name into v_tag_id, v_stored;
        end if;

        insert into public.file_tags (file_id, tag_id)
        values (p_file_id, v_tag_id)
        on conflict (file_id, tag_id) do nothing;

        if found then
            update public.tags
               set usage_count = usage_count + 1
             where id = v_tag_id;
        end if;

        v_result := array_append(v_result, v_stored);
        v_count := v_count + 1;
    end loop;

    return v_result;
end;
$$;

-- Cosine top-K over chunks of files the caller may read (own, or class
-- material of a class the caller belongs to).
create or replace function public.search_file_chunks(
    p_query_embedding vector(768),
    p_file_ids        uuid[],
    p_k               int default 5
)
returns table (
    file_id    uuid,
    chunk_id   uuid,
    seq        int,
    chunk_text text,
    distance   double precision,
    meta       jsonb
)
language sql
stable
security definer
set search_path = public
as $$
    select fc.file_id,
           fc.id,
           fc.seq,
           fc.chunk_text,
           (fc.embedding <=> p_query_embedding)::double precision as distance,
           fc.meta
      from public.file_chunks fc
      join public.files f on f.id = fc.file_id
     where fc.file_id = any (p_file_ids)
       and (
            f.owner_id = app.current_user_id()
         or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
       )
       and fc.status = 'embedded'
       and fc.embedding is not null
     order by fc.embedding <=> p_query_embedding
     limit greatest(1, p_k);
$$;

create or replace function public.get_chunk_context(
    p_chunk_id  uuid,
    p_neighbors int default 1
)
returns table (
    file_id    uuid,
    name       text,
    seq        int,
    page       int,
    chunk_text text,
    prev_text  text,
    next_text  text
)
language sql
stable
security definer
set search_path = public
as $$
    with target as (
        select fc.id, fc.file_id, fc.seq, fc.chunk_text, fc.meta
          from public.file_chunks fc
          join public.files f on f.id = fc.file_id
         where fc.id = p_chunk_id
           and (
                f.owner_id = app.current_user_id()
             or (f.kind = 'class_material' and public.is_class_member(f.space_ref))
           )
    )
    select t.file_id,
           split_part(
               f.storage_path, '/',
               array_length(string_to_array(f.storage_path, '/'), 1)
           ) as name,
           t.seq,
           case
               when t.meta->>'page' ~ '^[0-9]+$' then (t.meta->>'page')::int
               else null
           end as page,
           t.chunk_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq - p_neighbors) as prev_text,
           (select c.chunk_text from public.file_chunks c
              where c.file_id = t.file_id and c.seq = t.seq + p_neighbors) as next_text
      from target t
      join public.files f on f.id = t.file_id;
$$;

create or replace function public.get_file_tags(p_file_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
    v_owner uuid;
    v_kind  text;
    v_ref   uuid;
    v_names text[];
begin
    select owner_id, kind, space_ref
      into v_owner, v_kind, v_ref
      from public.files
     where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if v_owner is distinct from app.current_user_id()
       and not (v_kind = 'class_material' and public.is_class_member(v_ref)) then
        raise exception 'not allowed' using errcode = 'insufficient_privilege';
    end if;

    select coalesce(array_agg(t.name order by t.name), array[]::text[])
      into v_names
      from public.file_tags ft
      join public.tags t on t.id = ft.tag_id
     where ft.file_id = p_file_id;
    return v_names;
end;
$$;

-- Owner-only file delete + orphan-tag cleanup (shared tags are preserved).
create or replace function public.delete_file_cascade(p_file_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    v_owner   uuid;
    v_tag_ids uuid[];
begin
    select owner_id into v_owner from public.files where id = p_file_id;
    if v_owner is null then
        raise exception 'file not found' using errcode = 'no_data_found';
    end if;
    if v_owner is distinct from app.current_user_id() then
        raise exception 'not file owner' using errcode = 'insufficient_privilege';
    end if;

    select coalesce(array_agg(tag_id), '{}')
      into v_tag_ids
      from public.file_tags
     where file_id = p_file_id;

    delete from public.files where id = p_file_id;

    if array_length(v_tag_ids, 1) is not null then
        update public.tags t
           set usage_count = (
                (select count(*) from public.node_tags nt where nt.tag_id = t.id)
              + (select count(*) from public.file_tags ft where ft.tag_id = t.id)
           )
         where t.id = any (v_tag_ids);

        delete from public.tags t
         where t.id = any (v_tag_ids)
           and not exists (select 1 from public.node_tags nt where nt.tag_id = t.id)
           and not exists (select 1 from public.file_tags ft where ft.tag_id = t.id);
    end if;
end;
$$;

-- migrate:down
drop function if exists public.delete_file_cascade(uuid);
drop function if exists public.get_file_tags(uuid);
drop function if exists public.get_chunk_context(uuid, int);
drop function if exists public.search_file_chunks(vector, uuid[], int);
drop function if exists public.upsert_file_tags(uuid, text[]);
drop function if exists public.teacher_class_overview();
drop function if exists public.class_students(uuid);
drop function if exists public.teacher_classes();
drop function if exists public.admin_token_usage();
drop function if exists public.admin_set_user_role(uuid, text);
drop function if exists public.mark_onboarded();
drop function if exists public.tag_cooccurrence(text, uuid);
drop function if exists public.upsert_node_tags(uuid, uuid, text[]);
drop function if exists public.nodi_norm_tag(text);
drop function if exists public.set_node_positions_bulk(uuid, jsonb);
drop function if exists public.remove_node_connection(uuid, uuid);
drop function if exists public.add_node_connection(uuid, uuid);
drop function if exists public.append_chat_node(uuid, uuid, text, text, text);
drop function if exists public.create_class(text);
drop function if exists public.nodi_gen_join_code();
drop function if exists public.join_class_by_code(text);
drop function if exists public.is_admin();
drop function if exists public.can_access_session(uuid);
drop function if exists public.is_class_teacher(uuid);
drop function if exists public.is_class_member(uuid);

drop table if exists public.file_graph_nodes;
drop table if exists public.ai_logs;
drop table if exists public.file_tags;
drop table if exists public.file_node_links;
drop table if exists public.jobs;
drop table if exists public.file_chunks;
drop table if exists public.files;
drop table if exists public.app_settings;
drop table if exists public.ai_steps;
drop table if exists public.ai_sessions;
drop table if exists public.node_tags;
drop table if exists public.tags;
alter table if exists public.sessions
    drop constraint if exists sessions_root_node_id_fkey,
    drop constraint if exists sessions_current_head_id_fkey;
drop table if exists public.nodes;
drop table if exists public.sessions;
drop table if exists public.class_members;
drop table if exists public.classes;
drop table if exists public.profiles;
drop table if exists public.users;

drop schema if exists app cascade;
