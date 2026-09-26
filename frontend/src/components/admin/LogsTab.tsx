"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  Radio,
  X,
  Copy,
  Check,
  AlertTriangle,
  Layers,
  FileText,
  GitBranch,
} from "lucide-react";
import { getAdminLogDetail, getAdminLogs, listAdminUsers } from "@/lib/api";
import type {
  AdminLog,
  AdminLogDetail,
  AdminLogsResponse,
  AdminTrace,
  AdminUser,
  LogContextBlock,
  LogContexts,
  RagSource,
} from "@/lib/types";

const LIMIT = 20;
/** 신규 턴 폴링 주기(탭이 보일 때만). */
const POLL_MS = 5000;

/** 사용자 표시: 이름 → 아이디 → id. */
function userLabel(u: AdminUser | undefined, fallback: string): string {
  return u?.display_name?.trim() || u?.username || u?.email || fallback;
}

/**
 * 로그 탭(D25→D34): 채팅 턴 단위 ai_logs 실시간 모니터 + 턴 상세 슬라이드오버.
 * 과거 조회(사용자/날짜 필터·페이지네이션) + 5초 폴링(after=최신 created_at)으로 신규 턴 추가.
 * 행 클릭 → 우측 상세 드로어(시스템 프롬프트 하이라이트·컨텍스트 블록·트레이스).
 */
export function LogsTab() {
  const [userId, setUserId] = useState<string>("");
  const [since, setSince] = useState<string>("");
  const [until, setUntil] = useState<string>("");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<AdminLog[]>([]);
  const [visible, setVisible] = useState(true);

  const { data: users } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });

  const { data, isLoading, isError } = useQuery<AdminLogsResponse>({
    queryKey: ["admin", "logs", userId || null, since || null, until || null, offset],
    queryFn: () =>
      getAdminLogs({
        userId: userId || null,
        since: since || null,
        until: until || null,
        limit: LIMIT,
        offset,
      }),
  });

  // 탭 가시성: 숨겨져 있으면 폴링을 멈춘다.
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const logs = data?.logs ?? [];
  // 라이브 추가분은 첫 페이지에서만, 현재 필터에 맞는 것만, 중복 제거
  const liveExtra =
    offset === 0
      ? liveLogs.filter(
          (l) =>
            (!userId || l.owner_id === userId) &&
            !logs.some((x) => x.id === l.id),
        )
      : [];
  const display = [...liveExtra, ...logs];

  // 보유한 가장 최신 로그의 created_at(폴링 기준점).
  const newest = display.reduce<string | null>(
    (acc, l) => (acc && acc >= l.created_at ? acc : l.created_at),
    null,
  );
  const polling = visible && offset === 0 && !isLoading;

  const pollInFlight = useRef(false);

  // ── 폴링: after=<최신 created_at>로 더 새로운 턴만 받아 맨 위에 합친다(id 중복 제거) ──
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      // 이전 폴링이 아직 진행 중이면 이번 주기는 건너뛴다(요청 중첩 방지).
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      try {
        const res = await getAdminLogs({
          userId: userId || null,
          since: since || null,
          until: until || null,
          after: newest,
          limit: 50,
          offset: 0,
        });
        if (cancelled || res.logs.length === 0) return;
        setLiveLogs((prev) => {
          const seen = new Set(prev.map((x) => x.id));
          const fresh = res.logs.filter((x) => !seen.has(x.id));
          return fresh.length ? [...fresh, ...prev].slice(0, 100) : prev;
        });
      } catch {
        /* 일시 오류는 다음 주기에 재시도 */
      } finally {
        pollInFlight.current = false;
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [polling, userId, since, until, newest]);

  // 필터가 바뀌면 이전 필터로 모은 신규분은 버리고 첫 페이지부터.
  const resetPage = () => {
    setOffset(0);
    setLiveLogs([]);
  };
  const emailFor = (ownerId: string) =>
    userLabel(users?.find((u) => u.id === ownerId), ownerId);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[#e7e3d8]">채팅 턴 로그</h2>
        <span
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            polling
              ? "bg-[#e0796a]/20 text-[#e0796a]"
              : "bg-white/5 text-[#9a948a]"
          }`}
          title={
            polling
              ? `${POLL_MS / 1000}초마다 새 턴을 확인합니다`
              : "첫 페이지에서 탭이 보일 때만 자동 새로고침합니다"
          }
        >
          <Radio size={11} />
          {polling ? `자동 새로고침 ${POLL_MS / 1000}초` : "자동 새로고침 일시정지"}
        </span>

        <select
          value={userId}
          onChange={(e) => {
            setUserId(e.target.value);
            resetPage();
          }}
          className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8]"
        >
          <option value="">전체 사용자</option>
          {(users ?? []).map((u) => (
            <option key={u.id} value={u.id}>
              {userLabel(u, u.id)}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-xs text-[#9a948a]">
          시작
          <input
            type="date"
            value={since}
            onChange={(e) => {
              setSince(e.target.value);
              resetPage();
            }}
            className="rounded border border-white/15 bg-[#1b1813] px-1.5 py-1 text-[#e7e3d8]"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-[#9a948a]">
          끝
          <input
            type="date"
            value={until}
            onChange={(e) => {
              setUntil(e.target.value);
              resetPage();
            }}
            className="rounded border border-white/15 bg-[#1b1813] px-1.5 py-1 text-[#e7e3d8]"
          />
        </label>
      </div>

      {isLoading ? (
        <p className="text-sm text-[#9a948a]">로그 불러오는 중…</p>
      ) : isError ? (
        <p className="text-sm text-[#e0796a]">로그를 불러오지 못했습니다.</p>
      ) : display.length === 0 ? (
        <p className="text-sm text-[#9a948a]">로그가 없습니다.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {display.map((l) => (
            <LogRow
              key={l.id}
              log={l}
              isLive={liveExtra.some((x) => x.id === l.id)}
              selected={selectedId === l.id}
              onSelect={() => setSelectedId(l.id)}
              userEmail={emailFor(l.owner_id)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        <button
          type="button"
          onClick={() => setOffset((o) => Math.max(0, o - LIMIT))}
          disabled={offset === 0}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          이전
        </button>
        <span className="text-xs text-[#9a948a]">
          {logs.length === 0 ? 0 : offset + 1}–{offset + logs.length}
        </span>
        <button
          type="button"
          onClick={() => setOffset((o) => o + LIMIT)}
          disabled={logs.length < LIMIT}
          className="rounded border border-white/15 px-3 py-1 text-sm text-[#e7e3d8] disabled:opacity-40"
        >
          다음
        </button>
      </div>

      {selectedId && (
        <TurnDetailDrawer
          logId={selectedId}
          emailFor={emailFor}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function LogRow({
  log,
  isLive,
  selected,
  onSelect,
  userEmail,
}: {
  log: AdminLog;
  isLive: boolean;
  selected: boolean;
  onSelect: () => void;
  userEmail: string;
}) {
  const hasError = (log.errors?.length ?? 0) > 0;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-[#e0a32e]/60 bg-[#2c2820]"
          : "border-white/10 bg-[#25211a] hover:border-white/20"
      }`}
    >
      {isLive && (
        <span className="rounded bg-[#e0796a]/20 px-1.5 py-0.5 text-[10px] font-medium text-[#e0796a]">
          NEW
        </span>
      )}
      <span className="rounded bg-[#e0a32e]/20 px-1.5 py-0.5 text-xs font-medium text-[#fcf58b]">
        {log.kind || "chat"}
      </span>
      {hasError && (
        <AlertTriangle size={13} className="shrink-0 text-[#e0796a]" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm text-[#cfc9bd]">
        {log.question || "(질문 없음)"}
      </span>
      <span className="shrink-0 text-xs text-[#9a948a]">{userEmail}</span>
      <span className="shrink-0 text-xs text-[#9a948a]">
        {log.token_estimate != null ? `${log.token_estimate} tok` : ""}
      </span>
      <span className="shrink-0 text-xs text-[#9a948a]">
        {new Date(log.created_at).toLocaleString("ko-KR")}
      </span>
      <ChevronRight size={15} className="shrink-0 text-[#9a948a]" />
    </button>
  );
}

// ── 블록 종류별 색/라벨 (본문 하이라이트와 카드 헤더가 일치) ──────────
const BLOCK_STYLE: Record<
  string,
  { label: string; color: string; bg: string }
> = {
  system_base: { label: "기본 지시", color: "#b6b0a4", bg: "rgba(182,176,164,0.18)" },
  memory_link: { label: "기억 연결", color: "#d98a3d", bg: "rgba(194,112,42,0.28)" },
  rag: { label: "자료 (RAG)", color: "#3fb0aa", bg: "rgba(42,125,122,0.30)" },
  comparison: { label: "비교 참조", color: "#bd86c4", bg: "rgba(154,94,163,0.30)" },
};
function blockStyle(kind: string) {
  return (
    BLOCK_STYLE[kind] ?? {
      label: kind,
      color: "#8fa0bf",
      bg: "rgba(126,138,160,0.25)",
    }
  );
}

// ── D34 턴 상세 드로어 ────────────────────────────────────────────────
function TurnDetailDrawer({
  logId,
  emailFor,
  onClose,
}: {
  logId: string;
  emailFor: (ownerId: string) => string;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useQuery<AdminLogDetail>({
    queryKey: ["admin", "log-detail", logId],
    queryFn: () => getAdminLogDetail(logId),
  });

  // ESC 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const log = data?.log;
  const contexts: LogContexts = log?.contexts ?? {};
  const blocks: LogContextBlock[] = Array.isArray(contexts.blocks)
    ? (contexts.blocks as LogContextBlock[])
    : [];
  const hasStructured = blocks.length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label="턴 상세"
    >
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="relative ml-auto flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-white/10 bg-[#1b1813] shadow-2xl">
        <header className="flex shrink-0 items-center gap-2 border-b border-white/10 bg-[#221e17] px-4 py-3">
          <span className="rounded bg-[#e0a32e]/20 px-1.5 py-0.5 text-xs font-medium text-[#fcf58b]">
            {log?.kind || "chat"}
          </span>
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-[#e7e3d8]">
            턴 상세
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="rounded p-1 text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
          >
            <X size={18} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {isLoading ? (
            <p className="text-sm text-[#9a948a]">상세 불러오는 중…</p>
          ) : isError || !log ? (
            <p className="text-sm text-[#e0796a]">상세를 불러오지 못했습니다.</p>
          ) : (
            <div className="flex flex-col gap-5">
              {/* 1) 개요 */}
              <Overview log={log} email={emailFor(log.owner_id)} />

              {/* 2) 시스템 프롬프트 + 하이라이트 */}
              <SystemPromptView
                prompt={log.system_prompt ?? ""}
                blocks={blocks}
                structured={hasStructured}
                contexts={contexts}
              />

              {/* 3) 컨텍스트 블록 카드 (구조화일 때만) */}
              {hasStructured && <ContextBlocks blocks={blocks} />}

              {/* 4) 파이프라인 / ReAct 타임라인 */}
              <Timeline
                skillCalls={log.skill_calls ?? []}
                traces={data?.traces ?? []}
              />

              {/* 5) 오류 */}
              {(log.errors?.length ?? 0) > 0 && (
                <Errors errors={log.errors ?? []} />
              )}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function Overview({ log, email }: { log: AdminLog; email: string }) {
  const hasError = (log.errors?.length ?? 0) > 0;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#9a948a]">
        <span>{new Date(log.created_at).toLocaleString("ko-KR")}</span>
        <span>· {email}</span>
        {log.session_id && (
          <span className="font-mono">· session {log.session_id.slice(0, 8)}</span>
        )}
        {log.token_estimate != null && <span>· {log.token_estimate} tok</span>}
        <span
          className={`rounded-full px-2 py-0.5 ${
            hasError
              ? "bg-[#e0796a]/20 text-[#e0796a]"
              : "bg-[#9bbf6a]/20 text-[#9bbf6a]"
          }`}
        >
          {hasError ? "오류 있음" : "정상"}
        </span>
      </div>
      <Field label="질문">{log.question}</Field>
      <Field label="답변">{log.answer}</Field>
    </section>
  );
}

function SystemPromptView({
  prompt,
  blocks,
  structured,
  contexts,
}: {
  prompt: string;
  blocks: LogContextBlock[];
  structured: boolean;
  contexts: LogContexts;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* 무시 */
    }
  };

  const kinds = Array.from(
    new Set(
      blocks
        .filter((b) => Array.isArray(b.prompt_span))
        .map((b) => b.kind),
    ),
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
          시스템 프롬프트
        </h3>
        {prompt && (
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-1 rounded border border-white/15 px-1.5 py-0.5 text-[10px] text-[#9a948a] transition-colors hover:text-[#e7e3d8]"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? "복사됨" : "복사"}
          </button>
        )}
      </div>

      {/* 범례 / 구버전 폴백 */}
      {structured ? (
        kinds.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {kinds.map((k) => {
              const st = blockStyle(k);
              return (
                <span
                  key={k}
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: st.bg, color: st.color }}
                >
                  {st.label}
                </span>
              );
            })}
          </div>
        )
      ) : (
        <LegacyContexts contexts={contexts} />
      )}

      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-[#15120d] p-3 font-mono text-[11px] leading-relaxed text-[#cfc9bd]">
        {structured ? highlightPrompt(prompt, blocks) : prompt}
      </pre>
    </section>
  );
}

/** prompt_span 구간을 kind별 색으로 하이라이트(겹침은 안전하게 순차 클램프). */
function highlightPrompt(prompt: string, blocks: LogContextBlock[]) {
  const spans = blocks
    .filter(
      (b): b is LogContextBlock & { prompt_span: [number, number] } =>
        Array.isArray(b.prompt_span) && b.prompt_span.length === 2,
    )
    .map((b) => ({ start: b.prompt_span[0], end: b.prompt_span[1], kind: b.kind }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const out: React.ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    const start = Math.max(s.start, cursor);
    const end = Math.min(s.end, prompt.length);
    if (start >= end) return; // 겹침/범위밖 → 건너뜀
    if (start > cursor) {
      out.push(<span key={`plain-${i}`}>{prompt.slice(cursor, start)}</span>);
    }
    const st = blockStyle(s.kind);
    out.push(
      <mark
        key={`mark-${i}`}
        title={st.label}
        className="rounded px-0.5"
        style={{ backgroundColor: st.bg, color: st.color }}
      >
        {prompt.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < prompt.length) {
    out.push(<span key="plain-tail">{prompt.slice(cursor)}</span>);
  }
  return out;
}

function ContextBlocks({ blocks }: { blocks: LogContextBlock[] }) {
  const ordered = [...blocks].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
        컨텍스트 블록 ({ordered.length})
      </h3>
      <div className="flex flex-col gap-2">
        {ordered.map((b, i) => (
          <BlockCard key={`${b.kind}-${b.order}-${i}`} block={b} />
        ))}
      </div>
    </section>
  );
}

function BlockCard({ block }: { block: LogContextBlock }) {
  const [open, setOpen] = useState(false);
  const st = blockStyle(block.kind);
  const Icon =
    block.kind === "rag"
      ? FileText
      : block.kind === "memory_link"
        ? GitBranch
        : Layers;
  const ragSources = (block.sources ?? []) as RagSource[];
  return (
    <div
      className="overflow-hidden rounded-lg border bg-[#221e17]"
      style={{ borderColor: st.color + "55" }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ backgroundColor: st.bg }}
      >
        <Icon size={14} style={{ color: st.color }} />
        <span className="text-xs font-semibold" style={{ color: st.color }}>
          {st.label}
        </span>
        {block.source && (
          <span className="truncate text-[11px] text-[#9a948a]">
            {block.source}
          </span>
        )}
        <span className="ml-auto text-[10px] text-[#9a948a]">
          #{block.order}
        </span>
      </div>

      <div className="flex flex-col gap-2 px-3 py-2 text-xs">
        {/* RAG 출처 표 */}
        {ragSources.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[11px]">
              <thead>
                <tr className="text-[#9a948a]">
                  <th className="py-1 pr-2 font-medium">파일</th>
                  <th className="py-1 pr-2 font-medium">#seq</th>
                  <th className="py-1 pr-2 font-medium">page</th>
                  <th className="py-1 pr-2 font-medium">dist</th>
                  <th className="py-1 font-medium">snippet</th>
                </tr>
              </thead>
              <tbody>
                {ragSources.map((s, i) => (
                  <tr key={`${s.file_id}-${s.seq ?? "x"}-${i}`} className="align-top">
                    <td className="py-1 pr-2 text-[#cfc9bd]">{s.name ?? "—"}</td>
                    <td className="py-1 pr-2 text-[#9a948a]">{s.seq ?? "—"}</td>
                    <td className="py-1 pr-2 text-[#9a948a]">{s.page ?? "—"}</td>
                    <td className="py-1 pr-2 text-[#9a948a]">
                      {s.distance != null ? s.distance.toFixed(3) : "—"}
                    </td>
                    <td className="py-1 text-[#9a948a]">
                      <span className="line-clamp-2">{s.snippet ?? ""}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* 기억연결 / 비교참조 node_ids */}
        {block.node_ids && block.node_ids.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-[#9a948a]">노드</span>
            {block.node_ids.map((id) => (
              <span
                key={id}
                className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-[#cfc9bd]"
              >
                {id.slice(0, 8)}
              </span>
            ))}
          </div>
        )}

        {/* 원문(접기/펼치기) */}
        {block.raw_text && (
          <div>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-[11px] text-[#9a948a] underline-offset-2 hover:underline"
            >
              {open ? "원문 접기" : "원문 펼치기"}
            </button>
            {open && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[#15120d] p-2 font-mono text-[11px] text-[#cfc9bd]">
                {block.raw_text}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Timeline({
  skillCalls,
  traces,
}: {
  skillCalls: unknown[];
  traces: AdminTrace[];
}) {
  if (skillCalls.length === 0 && traces.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-[#9a948a]">
        파이프라인 / ReAct
      </h3>

      {skillCalls.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {skillCalls.map((c, i) => (
            <span
              key={i}
              className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-[#cfc9bd]"
            >
              {summarizeSkill(c)}
            </span>
          ))}
        </div>
      )}

      {traces.map((t) => (
        <div
          key={t.id}
          className="rounded-lg border border-white/10 bg-[#221e17] p-2"
        >
          <div className="mb-1 flex items-center gap-2 text-[11px] text-[#9a948a]">
            <span className="rounded bg-[#9a5ea3]/20 px-1.5 py-0.5 font-medium text-[#bd86c4]">
              {t.kind || "trace"}
            </span>
            <span>{new Date(t.created_at).toLocaleTimeString("ko-KR")}</span>
            <span className="ml-auto">{(t.ai_steps?.length ?? 0)} steps</span>
          </div>
          <ol className="flex flex-col gap-1">
            {(t.ai_steps ?? []).map((s) => (
              <li
                key={s.seq}
                className="rounded bg-[#15120d] px-2 py-1 text-[11px] text-[#cfc9bd]"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[#9a948a]">#{s.seq}</span>
                  {s.skill && (
                    <span className="font-medium text-[#fcf58b]">{s.skill}</span>
                  )}
                  {s.tokens != null && (
                    <span className="ml-auto text-[#9a948a]">{s.tokens} tok</span>
                  )}
                </div>
                {s.thought && (
                  <p className="mt-0.5 line-clamp-2 text-[#9a948a]">{s.thought}</p>
                )}
                {s.observation != null && (
                  <p className="mt-0.5 line-clamp-2 text-[#9a948a]">
                    → {preview(s.observation, 160)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function Errors({ errors }: { errors: unknown[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-center gap-1 text-xs font-semibold text-[#e0796a]">
        <AlertTriangle size={13} /> 오류 ({errors.length})
      </h3>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-[#15120d] p-2 font-mono text-[11px] text-[#e0796a]">
        {preview(errors, 1200)}
      </pre>
    </section>
  );
}

/** 구버전(boolean) contexts 폴백: 사용된 컨텍스트 플래그 칩만. */
function LegacyContexts({ contexts }: { contexts: LogContexts }) {
  const entries = Object.entries(contexts).filter(([k]) => k !== "blocks" && k !== "history");
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[10px] text-[#9a948a]">구버전 로그 — 플래그만 표시</p>
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span
            key={k}
            className={`rounded-full px-2 py-0.5 text-[10px] ${
              v
                ? "bg-[#9bbf6a]/20 text-[#9bbf6a]"
                : "bg-white/5 text-[#9a948a]"
            }`}
          >
            {k}: {String(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  if (!children) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-[#9a948a]">
        {label}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[#221e17] p-2 text-xs text-[#cfc9bd]">
        {children}
      </pre>
    </div>
  );
}

function summarizeSkill(c: unknown): string {
  if (c && typeof c === "object") {
    const o = c as Record<string, unknown>;
    const name = (o.skill ?? o.name ?? o.kind) as string | undefined;
    const count = o.count as number | undefined;
    if (name) return count != null ? `${name} (${count})` : name;
  }
  return preview(c, 40);
}

function preview(v: unknown, max = 400): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + "…" : s;
}
