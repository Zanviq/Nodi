# nodi backend

FastAPI + PostgreSQL 16 (pgvector). Username/password accounts with an httpOnly
session cookie, local file storage, and Gemini called with **each user's own
API key** (sent per request in the `X-Gemini-Key` header — the server stores no
AI key).

## Run with Docker (recommended)

From the repository root:

```bash
cp .env.example .env
docker compose up -d --build db migrate backend
```

- `db` — `pgvector/pgvector:pg16` (volume `db-data`)
- `migrate` — dbmate: applies `db/migrations/*` (table `schema_migrations`),
  then the one-time demo seed `db/seed/*` (table `seed_migrations`)
- `backend` — this app on `http://localhost:8000` (`/docs` for OpenAPI);
  uploads live in the `uploads` volume

Demo accounts (seeded): `demo` / `teacher` / `admin`, password `demo1234`.

## Run locally (without Docker)

```bash
cd backend
python -m venv .venv && . .venv/bin/activate   # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
export DATABASE_URL=postgres://nodi:nodi@localhost:5432/nodi?sslmode=disable
export STORAGE_DIR=./.data/uploads
uvicorn app.main:app --reload --port 8000
```

Settings come from environment variables first, then the repository-root
`.env` (see `.env.example`).

## Layout

- `app/db/` — asyncpg pool, schema catalog, a translator for the PostgREST-style
  query params the services use (`postgrest.py`), and the **access layer**
  (`access.py`) that enforces every per-table permission rule (who may read /
  insert / update / delete which rows). `UserClient` runs as the caller;
  `ServiceClient` is the trusted system client.
- `app/auth/` — bcrypt password hashing, session JWT (HS256) in the
  `nodi_session` cookie, role guards.
- `app/ai_key.py` — the `X-Gemini-Key` header dependency, error codes
  (`gemini_key_required` / `gemini_key_invalid` / `gemini_quota_exceeded`) and a
  log filter that redacts the key.
- `app/services/file_pipeline.py` — text extraction (PDF/text, image OCR with a
  key), chunking, embeddings (`gemini-embedding-001`, 768-d, L2-normalized) and
  file tagging, run inside the upload/retry request.
- `app/services/storage.py` — local storage under `STORAGE_DIR`
  (`{owner_id}/{file_id}/{name}`, path-traversal guarded).

## Endpoints (summary)

Auth: `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`,
`GET|PATCH /auth/me`, `GET /auth/me/classes`, `POST /auth/me/classes/join`,
`POST /auth/complete-onboarding`, `GET /auth/me/navigator-defaults`.

Workspace: `/sessions` (CRUD, tree, `PUT /{id}/node-positions` bulk),
`/nodes` (navigator cleanup, position, memory-link connections), `/tags`,
`/files` (upload, list, tags, links, retry, chunk context),
`/home/summary`, `/home/suggestions`*, `POST /chat/stream`* (SSE),
`POST /overseer/stream`* (SSE). `*` = needs `X-Gemini-Key`.

Teacher (`role=teacher`): `/teacher/classes`, `/teacher/classes/overview`,
students, a student's class sessions, materials. Admin (`role=admin`):
`/admin/users`, role change, `/admin/settings`, `/admin/usage`,
`/admin/logs` (poll with `after=`), `/admin/logs/{id}`, `/admin/traces`.

## Migrations

`db/migrations/20260926000000_baseline.sql` is the squashed schema (tables,
indexes, SQL functions). Add new changes as new dbmate files
(`-- migrate:up` / `-- migrate:down`). SQL functions read the caller from
`app.current_user_id()`, which the backend sets per transaction.
