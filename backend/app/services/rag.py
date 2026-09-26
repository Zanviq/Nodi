"""Visual RAG retrieval + chat injection (Stage 3b-2).

A file linked to a node applies to that node and its descendant branch. At chat
time we collect the files linked anywhere on the current head's ancestor chain,
embed the question (RETRIEVAL_QUERY, 768), cosine-search those files' chunks
(pgvector, owner-scoped), and inject the top-K chunks as a SOURCE-LABELLED
reference block ("[연결된 자료에서 참고]") distinct from the live branch and the
Stage-3a memory-link block.

Best-effort: any failure -> no RAG context, never blocks the turn. Reads use the
caller's access-checked client (own files + class materials). The query
embedding uses the caller's own Gemini key (X-Gemini-Key); without it RAG is
skipped.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from ..config import get_settings
from ..db.client import UserClient
from . import app_settings, embedding

logger = logging.getLogger("nodi.rag")
settings = get_settings()


def _vector_literal(vec: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in vec) + "]"


def _file_basename(storage_path: str | None) -> str:
    """Filename from a "{owner}/{file_id}/{name}" storage path."""
    return (storage_path or "").split("/")[-1]


async def linked_file_ids(
    client: UserClient, chain: list[dict[str, Any]]
) -> list[str]:
    """File ids linked to any node on the current branch (head -> root)."""
    node_ids = [n["id"] for n in chain]
    if not node_ids:
        return []
    rows = await client.select(
        "file_node_links",
        {
            "target_node_id": f"in.({','.join(node_ids)})",
            "select": "file_id",
        },
    )
    seen: list[str] = []
    for r in rows:
        fid = r.get("file_id")
        if fid and fid not in seen:
            seen.append(fid)
    return seen


async def search(
    client: UserClient,
    file_ids: list[str],
    query: str,
    k: int | None = None,
    *,
    api_key: str | None,
) -> list[dict[str, Any]]:
    """Cosine top-K chunks from the given (owned) files for the query."""
    if not file_ids or not query.strip() or not api_key:
        return []
    if k is None:
        # RAG-injection path (suggest_files passes its own search_k). D62: the
        # admin-tunable rag_top_k overrides the config default.
        overlay = await app_settings.get_overlay()
        k = app_settings.as_int(overlay, "rag_top_k", settings.rag_top_k, 1, 50)
    vec = await embedding.embed_texts(
        [query], api_key=api_key, task_type="RETRIEVAL_QUERY"
    )
    if not vec:
        return []
    result = await client.rpc(
        "search_file_chunks",
        {
            "p_query_embedding": _vector_literal(vec[0]),
            "p_file_ids": file_ids,
            "p_k": k,
        },
    )
    return result if isinstance(result, list) else []


SNIPPET_CHARS = 300


def _source_label(name: str, seq: Any, page: Any) -> str:
    """Inline provenance label for a chunk, e.g. "note.pdf · #12" (+ page)."""
    parts: list[str] = []
    if name:
        parts.append(name)
    if seq is not None:
        parts.append(f"#{seq}")
    if page is not None:
        parts.append(f"p.{page}")
    return " · ".join(parts)


def build_block(chunks: list[dict[str, Any]], names: dict[str, str]) -> str:
    """Render retrieved chunks as a SOURCE-LABELLED reference block (D32).

    Each line carries its provenance inline so the model — and the saved system
    prompt — show which file·chunk a passage came from.
    """
    if not chunks:
        return ""
    lines = ["[연결된 자료에서 참고]"]
    for c in chunks:
        text = (c.get("chunk_text") or "").strip()
        if not text:
            continue
        meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
        label = _source_label(
            names.get(c.get("file_id"), ""),
            c.get("seq"),
            (meta or {}).get("page"),
        )
        prefix = f"[{label}] " if label else ""
        lines.append(f"- {prefix}{text}")
    return "\n".join(lines) if len(lines) > 1 else ""


def build_sources(
    chunks: list[dict[str, Any]], names: dict[str, str]
) -> list[dict[str, Any]]:
    """Per-chunk provenance metadata (D32/D35): file·#seq·page·distance·snippet."""
    sources: list[dict[str, Any]] = []
    for c in chunks:
        fid = c.get("file_id")
        if not fid:
            continue
        meta = c.get("meta") if isinstance(c.get("meta"), dict) else {}
        sources.append(
            {
                "file_id": fid,
                # D41: keep the chunk id so the "⋯" panel can fetch the full
                # text + neighbours on demand (get_chunk_context). Older nodes
                # saved before this may lack it → frontend treats it as optional.
                "chunk_id": c.get("chunk_id"),
                "name": names.get(fid, ""),
                "seq": c.get("seq"),
                "page": (meta or {}).get("page"),
                "distance": c.get("distance"),
                "snippet": (c.get("chunk_text") or "")[:SNIPPET_CHARS],
            }
        )
    return sources


async def _file_names(
    client: UserClient, file_ids: list[str]
) -> dict[str, str]:
    """Map file_id -> filename (storage_path basename) in one query."""
    if not file_ids:
        return {}
    rows = await client.select(
        "files",
        {
            "id": f"in.({','.join(file_ids)})",
            "select": "id,storage_path",
        },
    )
    return {r["id"]: _file_basename(r.get("storage_path")) for r in rows}


async def build_rag_context(
    client: UserClient,
    chain: list[dict[str, Any]],
    query: str,
    api_key: str | None,
) -> dict[str, Any] | None:
    """Best-effort: assemble the linked-file reference block + source metadata.

    Returns ``{"block": str, "sources": [ {file_id, name, seq, page, distance,
    snippet} ]}`` or ``None`` when there is nothing to inject. Callers use
    ``block`` for the system prompt and ``sources`` for node/log provenance (D32).
    """
    if not api_key:
        return None
    try:
        file_ids = await linked_file_ids(client, chain)
        if not file_ids:
            return None
        chunks = await search(client, file_ids, query, api_key=api_key)
        if not chunks:
            return None
        hit_ids = list({c.get("file_id") for c in chunks if c.get("file_id")})
        names = await _file_names(client, hit_ids)
        block = build_block(chunks, names)
        if not block:
            return None
        return {"block": block, "sources": build_sources(chunks, names)}
    except Exception:  # noqa: BLE001 - RAG must never break chat
        logger.exception("RAG retrieval failed")
        return None


def _branch_query_text(chain: list[dict[str, Any]]) -> str:
    """Use the tail of the branch (recent Q&A) as the RAG-injection query.

    RAG-INJECTION ONLY (build_rag_context path): it searches files already LINKED
    to the branch, so blending the whole chain is safe (low false-positive risk).
    NOTE: file SUGGESTION no longer uses this — see _suggestion_query_text (D56).
    """
    parts: list[str] = []
    for n in reversed(chain):
        if n.get("is_navigator"):
            continue
        q = (n.get("question") or "").strip()
        a = (n.get("answer") or "").strip()
        if q or a:
            parts.append(f"{q}\n{a}")
        if len("\n".join(parts)) >= settings.file_suggestion_query_chars:
            break
    text = "\n".join(reversed(parts))
    return text[: settings.file_suggestion_query_chars]


# D56: char cap for the focus-centred SUGGESTION query (small on purpose).
# D62: the cap is now admin-tunable (file_suggestion_suggest_query_chars) and
# passed in by suggest_files; this constant is the config fallback default.
SUGGEST_QUERY_CHARS = settings.file_suggestion_suggest_query_chars


def _suggestion_query_text(
    chain: list[dict[str, Any]], cap: int = SUGGEST_QUERY_CHARS
) -> str:
    """Focus-centred query for FILE SUGGESTIONS (D56).

    Root cause of unrelated-branch suggestions: the old query blended the WHOLE
    ancestor chain (root->focus) into one ~1500-char embedding, so a topic touched
    anywhere upstream (whose file exists) sat near that file even after the focus
    moved on. Here we use the FOCUS node's question as the main signal, add only
    the immediate parent's question as weak context, and at most the head 200
    chars of the focus answer — capped small (~450). Distant ancestors are
    dropped, so the query reflects "what's being asked right now", not an average
    of the whole branch.
    """
    reals = [n for n in chain if not n.get("is_navigator")]
    if not reals:
        return ""
    focus = reals[-1]
    parts: list[str] = [
        (focus.get("question") or "").strip(),
        (focus.get("answer") or "").strip()[:200],
    ]
    if len(reals) >= 2:
        # Weak parent context (question only) ahead of the focus signal.
        parts.insert(0, (reals[-2].get("question") or "").strip())
    text = "\n".join(p for p in parts if p)
    return text[:cap]


# --- D48: conservative greeting / small-talk stoplist -----------------------
# Intentionally a SMALL KO/EN core subset. Over-listing would re-introduce the
# false-negatives the distance gate (cutoff 0.50 + margin 0.05) already prevents
# — so when in doubt we treat a token as substantive and ALLOW the suggestion.
_GREETING_STOPWORDS: frozenset[str] = frozenset(
    {
        # 한국어 인사·감탄·메타발화
        "안녕", "안녕하세요", "안녕하십니까", "하이", "헬로", "반가워",
        "반가워요", "반갑습니다", "고마워", "고마워요", "고맙습니다", "감사",
        "감사해", "감사해요", "감사합니다", "잘가", "잘자", "바이", "테스트",
        "오케이", "오키", "넵", "응", "음", "누구", "누구야", "누구세요",
        "뭐해", "뭐하니", "심심해",
        # 영어
        "hello", "hi", "hey", "yo", "thanks", "thank", "thx", "ok", "okay",
        "test", "testing", "bye",
    }
)
# Common Korean particle/ending tails — stripped ONLY to re-test against the
# stoplist (e.g. "테스트야" / "누구세요" → "테스트" / "누구"). Conservative.
_KO_PARTICLE_SUFFIXES: tuple[str, ...] = (
    "입니다", "이에요", "예요", "에요", "이야", "야", "요",
)
# Laughter / filler jamo ("ㅋㅋ", "ㅎㅎ", "ㅠㅠ").
_LAUGH_CHARS: frozenset[str] = frozenset("ㅋㅎㅠㅜ")


def _normalize_token(tok: str) -> str:
    """Lowercase + strip surrounding punctuation/space for stoplist matching."""
    return tok.strip().strip(".,!?~…\"'`()[]{}<>:;-").lower()


def _is_greeting_token(tok: str) -> bool:
    """True when a single token is pure greeting/interjection/punctuation."""
    t = _normalize_token(tok)
    if not t:  # punctuation-only token → no substance
        return True
    if t in _GREETING_STOPWORDS:
        return True
    if all(ch in _LAUGH_CHARS for ch in t):  # ㅋㅋ / ㅎㅎ / ㅠㅠ
        return True
    for suf in _KO_PARTICLE_SUFFIXES:  # strip a tail, re-test against stoplist
        if t.endswith(suf) and t[: -len(suf)] in _GREETING_STOPWORDS:
            return True
    return False


def _greeting_only(chain: list[dict[str, Any]]) -> bool:
    """True when the branch's user QUESTIONS are greetings/small-talk only (D48).

    Tokenizes ONLY the question text of non-navigator real nodes (answers are
    ignored), drops the conservative greeting stoplist, and returns True when NO
    substantive token remains. Belt-and-suspenders for greetings whose long
    answer would otherwise slip past the length floor. Ambiguous cases — any
    unknown token, or no question text at all — return False so the suggestion
    is allowed and the distance/margin gate decides (avoids over-blocking).
    """
    saw_token = False
    for n in chain:
        if n.get("is_navigator"):
            continue
        q = (n.get("question") or "").strip()
        if not q:
            continue
        for raw in re.split(r"\s+", q):
            if not raw.strip():
                continue
            saw_token = True
            if not _is_greeting_token(raw):
                return False
    # No question tokens at all → not enough signal to call it a greeting.
    return saw_token


async def suggest_files(
    client: UserClient,
    chain: list[dict[str, Any]],
    space_kind: str,
    space_ref: str,
    api_key: str | None,
) -> list[dict[str, Any]]:
    """Propose files to link when the current branch has NONE linked yet.

    Returns top-N files (grouped by best chunk distance) with a sample chunk.
    Empty if the branch already has linked files or the space has no indexed
    files. Best-effort. Without a Gemini key (needed for the query embedding)
    there is nothing to compare against -> [].
    """
    if not api_key:
        return []
    try:
        # D62/D63: resolve the suggestion gate from the admin overlay (falling
        # back to config). All knobs read here so an admin slider change takes
        # live effect on the next turn.
        overlay = await app_settings.get_overlay()
        # Global on/off: admin can disable file suggestions entirely.
        if not app_settings.as_bool(overlay, "file_suggestion_enabled", True):
            return []
        # Already has linked files on this branch -> no suggestion.
        if await linked_file_ids(client, chain):
            return []
        # Indexed files available in this space (own + class_material, access layer).
        files = await client.select(
            "files",
            {
                "space_kind": f"eq.{space_kind}",
                "space_ref": f"eq.{space_ref}",
                "status": "eq.indexed",
                "select": "id,storage_path,mime,kind",
            },
        )
        if not files:
            return []
        by_id = {f["id"]: f for f in files}
        # D56: focus-centred query (NOT the whole-chain _branch_query_text) so
        # unrelated ancestor topics no longer pull in their files. D62: the cap
        # is admin-tunable.
        suggest_query_chars = app_settings.as_int(
            overlay,
            "file_suggestion_suggest_query_chars",
            settings.file_suggestion_suggest_query_chars,
            100,
            1500,
        )
        query = _suggestion_query_text(chain, suggest_query_chars)
        # D48 content gate (relaxed). Two cheap, conservative pre-filters only;
        # PRECISION is owned by the suggestion-only distance cutoff + margin below.
        #  1) hard floor: skip empty / whitespace-only branch queries (min 10).
        #  2) greeting stoplist: skip when the branch's QUESTIONS are pure
        #     greetings/small-talk (covers greetings whose long answer would
        #     slip past the floor). Short-but-real questions ("미분이 뭐야?") now
        #     reach search and are judged by relevance, not length.
        min_query_chars = app_settings.as_int(
            overlay,
            "file_suggestion_min_query_chars",
            settings.file_suggestion_min_query_chars,
            0,
            500,
        )
        if len(query.strip()) < min_query_chars:
            return []
        if _greeting_only(chain):
            return []
        search_k = app_settings.as_int(
            overlay,
            "file_suggestion_search_k",
            settings.file_suggestion_search_k,
            1,
            100,
        )
        chunks = await search(
            client, list(by_id), query, k=search_k, api_key=api_key
        )
        # Group chunks by file, keep best (smallest) distance + a sample.
        best: dict[str, dict[str, Any]] = {}
        for c in chunks:
            fid = c.get("file_id")
            if fid not in by_id:
                continue
            dist = c.get("distance")
            cur = best.get(fid)
            if cur is None or (dist is not None and dist < cur["distance"]):
                best[fid] = {
                    "file_id": fid,
                    "distance": dist if dist is not None else 1.0,
                    # filename from storage_path "{owner}/{file_id}/{name}".
                    "name": (by_id[fid].get("storage_path") or "").split("/")[-1],
                    "sample": (c.get("chunk_text") or "")[:300],
                    "kind": by_id[fid].get("kind"),
                }
        # Only suggest genuinely-related files. D56: use the SUGGESTION-ONLY
        # cutoff/margin (config, default 0.38/0.05) — STRICTER and decoupled from
        # the older shared 0.50 cutoff, so proposals require a clearly-related top
        # match. Borderline candidates are not proposed.
        max_distance = app_settings.as_float(
            overlay,
            "file_suggestion_suggest_max_distance",
            settings.file_suggestion_suggest_max_distance,
            0.1,
            0.9,
        )
        margin = app_settings.as_float(
            overlay,
            "file_suggestion_suggest_margin",
            settings.file_suggestion_suggest_margin,
            0.0,
            0.5,
        )
        top_n = app_settings.as_int(
            overlay, "file_suggestion_top_n", settings.file_suggestion_top_n, 1, 5
        )
        ranked = sorted(
            (b for b in best.values() if b["distance"] <= max_distance),
            key=lambda x: x["distance"],
        )
        # Margin gate: the best candidate must be clearly inside the cutoff,
        # else propose nothing (borderline matches are not "관련 있어 보여요").
        if not ranked or ranked[0]["distance"] > (max_distance - margin):
            return []
        return ranked[:top_n]
    except Exception:  # noqa: BLE001 - suggestions are optional
        logger.exception("File suggestion failed")
        return []
