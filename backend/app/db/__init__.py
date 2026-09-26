"""PostgreSQL access layer (asyncpg).

- `pool`      : shared asyncpg pool + schema catalog (created in the FastAPI lifespan)
- `postgrest` : translator for the PostgREST-style params used across the services
- `access`    : per-table permission rules (formerly row level security policies)
- `client`    : `UserClient` (access-checked, per caller) / `ServiceClient` (system)
"""
