"""Application settings.

Reads process environment variables first (the Docker container gets them from
docker-compose), then falls back to the repository ROOT `.env` for local runs.
Secrets are never hardcoded.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> parents[0]=app, [1]=backend, [2]=repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
ROOT_ENV = REPO_ROOT / ".env"


class Settings(BaseSettings):
    # --- Database (PostgreSQL + pgvector) ---
    # e.g. postgres://nodi:nodi@db:5432/nodi?sslmode=disable
    database_url: str = ""
    db_pool_min_size: int = 1
    db_pool_max_size: int = 10

    # --- Auth (username + password, session JWT in an httpOnly cookie) ---
    # HS256 signing secret. Empty -> a random per-process secret is generated
    # (sessions then do not survive a restart). Set a long random value.
    jwt_secret: str = ""
    jwt_expire_days: int = 7
    session_cookie_name: str = "nodi_session"
    # Set true when served over HTTPS so the cookie gets the Secure flag.
    cookie_secure: bool = False

    # --- Local file storage (replaces the hosted object storage) ---
    storage_dir: str = "/data/uploads"
    # Seed file bytes copied into storage_dir on startup when missing.
    seed_uploads_dir: str = ""

    # --- AI (Gemini) ---
    # There is NO server-side Gemini key: every AI request carries the user's
    # own key in the `X-Gemini-Key` header (see app/ai_key.py).
    # Chat model (streaming). Label model is a lighter/cheaper flash variant.
    # Runtime override (admin) lands in a later stage; static config for now.
    gemini_chat_model: str = "gemini-2.5-flash"
    gemini_label_model: str = "gemini-2.5-flash-lite"
    # Concept tagging uses the same lightweight tier by default.
    gemini_tag_model: str = "gemini-2.5-flash-lite"
    # Hard cap on auto-generated node labels (design: <= 10 chars).
    node_label_max_chars: int = 10
    # Auto concept tags per node (design: 1..3).
    max_tags_per_node: int = 3

    # --- Navigator (architecture §7; admin-tunable later) ---
    gemini_navigator_model: str = "gemini-2.5-flash"
    navigator_question_count: int = 3  # questions per navigator fire
    navigator_gate_k: int = 3  # min real nodes on the branch to consider firing
    navigator_gate_c: int = 1  # min shared tags on the branch to fire
    # Space firings along a branch: eligible at K, K+period, K+2*period, ...
    navigator_period: int = 3

    # --- ReAct budget (runaway guard) ---
    react_max_steps: int = 5
    react_max_tokens: int = 100_000

    # --- Memory linking (Stage 3a) ---
    # Cap imported (other-branch) nodes injected as reference context per turn.
    memory_max_imported_nodes: int = 12
    # Truncate each imported answer in the reference block (char budget).
    memory_answer_char_cap: int = 400

    # --- File RAG embeddings (Stage 3b-1) ---
    # gemini-embedding-001 supports output_dimensionality (768 here -> the
    # file_chunks.embedding vector(768) column). Reduced dims are not pre-
    # normalized, so the pipeline L2-normalizes before storing.
    gemini_embedding_model: str = "gemini-embedding-001"
    embedding_dimension: int = 768
    embedding_request_max_chunks: int = 32  # per embed_content call
    # Text chunking.
    chunk_size_chars: int = 1200
    chunk_overlap_chars: int = 150
    # Upper bound on a single uploaded file (bytes) — guard before processing.
    file_max_bytes: int = 25 * 1024 * 1024

    # --- File RAG search + tagging (Stage 3b-2) ---
    rag_top_k: int = 5  # chunks retrieved per query from linked files
    file_tag_max: int = 50  # concept tags per file (denser than node 1..3)
    # Chars of file text sampled for tag extraction.
    file_tag_sample_chars: int = 6000

    # --- RAG polish (Stage 3b-3) ---
    # Multimodal model for image OCR (text extraction from images / scans).
    ocr_model: str = "gemini-2.5-flash"
    # File-suggestion ("연결할까요?") tuning.
    # D56: top-N proposed is boostrapped to 1 — suggestions now require a single
    # CONFIDENT top match (was 3, which surfaced borderline extras).
    file_suggestion_top_n: int = 1  # files proposed (1..2)
    file_suggestion_search_k: int = 20  # chunks scanned before grouping by file
    file_suggestion_query_chars: int = 1500  # branch text used as the query
    # D48 content gate (relaxed from D37's 40): a SAFETY FLOOR only — block
    # empty/whitespace-only branch queries. Greetings/small-talk are now caught
    # by the conservative stoplist (_greeting_only) and, decisively, by the
    # distance cutoff + margin below — NOT by a blunt length gate (which used to
    # false-negative short-but-real questions like "미분이 뭐야?").
    file_suggestion_min_query_chars: int = 10
    # DEPRECATED (D63): this key is DEAD — no runtime path reads it. The real
    # suggestion gate is `file_suggestion_suggest_max_distance` (0.38) below.
    # Kept only for non-destructive back-compat; do NOT wire it. Not exposed in
    # the admin console and not seeded by 0022.
    file_suggestion_max_distance: float = 0.50
    # Margin gate: only surface a suggestion when the BEST candidate is at least
    # this much INSIDE the cutoff (best_distance <= cutoff - margin), i.e. only
    # confident matches — borderline ones are not proposed.
    file_suggestion_margin: float = 0.05
    # --- D56: SUGGESTION-ONLY gate (decoupled from RAG injection) ---
    # The proposal query is now the FOCUS node's question (rag._suggestion_query_text),
    # not the whole ancestor chain, so unrelated ancestors no longer pollute it. A
    # STRICTER, suggestion-only cutoff (separate from the 0.50 RAG-injection cutoff)
    # ensures only genuinely-related files surface. Distances are cosine (0=same).
    file_suggestion_suggest_max_distance: float = 0.38
    file_suggestion_suggest_margin: float = 0.05
    # Char cap for the focus-centred suggestion query (focus question + brief
    # parent context + short focus-answer head). Small on purpose (~400..500).
    file_suggestion_suggest_query_chars: int = 450

    # --- App ---
    # Comma-separated list of allowed browser origins (credentials allowed).
    cors_origins: str = "http://localhost:3000"
    environment: str = "development"

    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
