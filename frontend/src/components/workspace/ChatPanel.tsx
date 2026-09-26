"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import {
  Send,
  GitFork,
  Paperclip,
  Layers,
  X,
  MoreHorizontal,
  GitBranch,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { sessionKey, useFileSuggestions, useSessionDetail } from "@/lib/queries";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useWorkspacePrefs } from "@/store/useWorkspacePrefs";
import { getChunkContext, getSession } from "@/lib/api";
import { ancestorChain, buildById, pathIdSet } from "@/lib/tree";
import type { WorkspaceChat } from "@/lib/useWorkspaceChat";
import { isGeminiKeyError, useHasGeminiKey } from "@/lib/geminiKey";
import { GeminiKeyNotice } from "@/components/settings/GeminiKeyNotice";
import type {
  ChunkContext,
  FileLink,
  NodeRow,
  RagSource,
  ReferenceSource,
} from "@/lib/types";

/**
 * 대화 패널(중): 포커스 노드 기준 조상체인 스레드 표시 + 입력.
 * 실제 SSE 전송/스트리밍 상태는 공유 컨트롤러(chat)에서 관리한다.
 * 현재 분기 자료 연결은 RAG 배너로, 브랜치 참조(D15)는 토글+개수로 가시화.
 */
export function ChatPanel({
  chat,
  fileLinks,
  trackMode,
  referenceNodeIds,
  onToggleTrackMode,
  onClearTracks,
  onLinkFile,
}: {
  chat: WorkspaceChat;
  fileLinks: FileLink[];
  trackMode: boolean;
  referenceNodeIds: string[];
  onToggleTrackMode: () => void;
  onClearTracks: () => void;
  onLinkFile: (fileId: string, nodeId: string) => void;
}) {
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeNodeId = useWorkspaceStore((s) => s.activeNodeId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  const { data: detail, isLoading } = useSessionDetail(activeSessionId);

  const [input, setInput] = useState("");
  const hasKey = useHasGeminiKey();
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // 멀티라인 자동 확장(스크롤바는 CSS로 숨김) — D12
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [input]);

  // 세션이 바뀌면 포커스 노드를 그 세션의 현재 head로 초기화
  const sessionId = detail?.session?.id;
  useEffect(() => {
    if (detail?.session) {
      setActiveNode(detail.session.current_head_id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const nodes: NodeRow[] = detail?.nodes ?? [];
  const byId = buildById(nodes);
  const thread = ancestorChain(activeNodeId, byId);
  const branching = nodes.some(
    (n) => n.parent_id === activeNodeId && !n.is_navigator,
  );

  // 현재 분기(루트→포커스 노드 경로)에 연결된 자료 개수 (자손 분기에도 적용되므로 조상 포함)
  const branchPath = pathIdSet(activeNodeId, byId);
  const linkedFileCount = new Set(
    fileLinks
      .filter((l) => branchPath.has(l.target_node_id))
      .map((l) => l.file_id),
  ).size;

  // D37/D47: 제안 enable 게이트.
  // 설정 on + 이 세션 미dismiss + 연결파일 0 + 분기에 실질 내용 있을 때만(잡담 방엔 호출도 안 함).
  const fileSuggestionEnabled = useWorkspacePrefs((s) => s.fileSuggestionEnabled);
  const isSuggestionDismissed = useWorkspacePrefs((s) => s.isSuggestionDismissed);
  const dismissSuggestion = useWorkspacePrefs((s) => s.dismissSuggestion);
  const dismissed = activeSessionId
    ? isSuggestionDismissed(activeSessionId)
    : false;
  // D48: 클라 1차 게이트 완화 — "질문 길이 합 ≥20"이 짧은 실질 질문("미분이 뭐야?")을
  // 막던 false-negative 제거. 분기에 question.trim() 2자+ 비네비 실노드가 1개라도 있으면
  // 서버에 도달시키고, 잡담 차단은 백엔드 거리게이트+stoplist(D48)가 담당.
  const branchHasSubstance = thread.some(
    (n) => !n.is_navigator && (n.question?.trim().length ?? 0) >= 2,
  );
  const suggestionEnabled =
    linkedFileCount === 0 &&
    fileSuggestionEnabled &&
    !dismissed &&
    branchHasSubstance;

  const { data: suggestions } = useFileSuggestions(
    activeSessionId,
    activeNodeId,
    suggestionEnabled,
  );
  const showSuggestions =
    suggestionEnabled && !!suggestions && suggestions.length > 0;

  // 새 메시지/스트리밍 시 하단으로 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread.length, chat.streamAnswer, chat.streaming]);

  // 브랜치 참조: head 제외 추가 선택 수
  const extraTrackCount = referenceNodeIds.filter(
    (id) => id !== activeNodeId,
  ).length;

  const handleSend = async () => {
    // D39: 스트리밍 중엔 입력을 지우지 않고 early-return(미리 써둔 질문 보존).
    if (chat.streaming) return;
    const q = input.trim();
    if (!q) return;
    setInput("");
    const refs =
      trackMode && referenceNodeIds.length > 0 ? referenceNodeIds : undefined;
    const { ok } = await chat.send(q, activeNodeId, { referenceNodeIds: refs });
    if (!ok) setInput(q); // 실패 시 원문 복원
    else if (trackMode) onClearTracks(); // 일회성: 전송 후 초기화(D15)
  };

  if (!activeSessionId) {
    return (
      <section className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-center">
        <p className="text-sm text-fg-muted">
          왼쪽에서 대화를 선택하거나 &quot;새 대화&quot;로 시작하세요.
        </p>
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col">
      {/* 스레드 */}
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {isLoading ? (
          <p className="text-sm text-fg-muted">불러오는 중…</p>
        ) : thread.length === 0 && !chat.streaming ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-fg-muted">
            첫 질문을 입력해 대화를 시작하세요.
          </div>
        ) : (
          <div className="mx-auto flex max-w-2xl flex-col gap-5">
            {thread.map((n) => (
              <ExchangeBubble
                key={n.id}
                node={n}
                active={n.id === activeNodeId}
                onFocus={() => setActiveNode(n.id)}
                sessionNodes={nodes}
                currentSessionId={activeSessionId}
              />
            ))}

            {chat.streaming && (
              <div className="flex flex-col gap-2">
                <UserBubble text={chat.draftQ} />
                <AnswerBubble>
                  {chat.streamAnswer ? (
                    <ReactMarkdown>{chat.streamAnswer}</ReactMarkdown>
                  ) : (
                    <span className="text-fg-muted">생각하는 중…</span>
                  )}
                </AnswerBubble>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* 입력 */}
      <div className="border-t border-accent-border/30 px-6 py-4">
        {linkedFileCount > 0 && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-[#2a7d7a]">
            <Paperclip size={13} />연결된 자료 {linkedFileCount}개 — 이 분기의
            답변에 참고됩니다.
          </div>
        )}
        {showSuggestions && activeNodeId && (
          <div className="mx-auto mb-2 max-w-2xl rounded-lg border border-[#2a7d7a]/40 bg-[#2a7d7a]/5 px-3 py-2">
            <div className="flex items-center gap-1.5 text-xs text-[#2a7d7a]">
              <Paperclip size={13} />이 자료가 관련 있어 보여요 — 연결할까요?
              <button
                type="button"
                onClick={() =>
                  activeSessionId && dismissSuggestion(activeSessionId)
                }
                title="이 대화에서 제안 숨기기"
                className="ml-auto text-[#2a7d7a]/70 hover:text-[#2a7d7a]"
              >
                <X size={13} />
              </button>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions!.slice(0, 3).map((s) => (
                <button
                  key={s.file_id}
                  type="button"
                  onClick={() => onLinkFile(s.file_id, activeNodeId)}
                  title={s.sample ?? undefined}
                  className="max-w-[16rem] truncate rounded-md border border-[#2a7d7a]/50 bg-bg px-2 py-1 text-[11px] text-fg transition-colors hover:bg-[#2a7d7a]/10"
                >
                  📎 {s.sample?.trim() || s.kind || "이 자료 연결"}
                </button>
              ))}
            </div>
          </div>
        )}
        {branching && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-warning">
            <GitFork size={13} />이 노드에서 새 분기를 만듭니다.
          </div>
        )}
        {trackMode && (
          <div className="mx-auto mb-2 flex max-w-2xl items-center gap-1.5 text-xs text-accent-deep">
            <Layers size={13} />브랜치 참조 {extraTrackCount}개 선택됨 — 이번
            질문에만 비교 참조됩니다.
            <button
              type="button"
              onClick={onClearTracks}
              className="ml-1 flex items-center gap-0.5 text-fg-muted hover:text-fg"
            >
              <X size={11} />해제
            </button>
          </div>
        )}
        {!hasKey ? (
          <GeminiKeyNotice compact className="mx-auto mb-2 max-w-2xl" />
        ) : chat.error && isGeminiKeyError(chat.errorCode) ? (
          <GeminiKeyNotice
            compact
            message={chat.error}
            className="mx-auto mb-2 max-w-2xl"
          />
        ) : chat.error ? (
          <div className="mx-auto mb-2 max-w-2xl text-xs text-danger">
            {chat.error}
          </div>
        ) : null}
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <button
            type="button"
            onClick={onToggleTrackMode}
            title="브랜치 참조: 여러 분기를 이번 질문에만 비교 참조"
            className={`flex shrink-0 items-center justify-center rounded-xl border p-2 transition-colors ${
              trackMode
                ? "border-accent-deep bg-accent text-accent-fg"
                : "border-accent-border/50 text-fg-muted hover:text-fg"
            }`}
          >
            <Layers size={16} />
          </button>
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder={
              chat.streaming
                ? "답변 생성 중 — 다음 질문을 미리 입력할 수 있어요"
                : "질문을 입력하세요"
            }
            className="no-scrollbar max-h-40 flex-1 resize-none overflow-y-auto rounded-xl border border-accent-border/50 bg-bg-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={chat.streaming || !input.trim() || !hasKey}
            title={
              !hasKey
                ? "Gemini API 키를 입력하면 사용할 수 있어요"
                : chat.streaming
                  ? "답변 생성 중에는 전송할 수 없어요"
                  : undefined
            }
            className="flex items-center gap-1 rounded-xl bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            <Send size={15} />
            전송
          </button>
        </div>
      </div>
    </section>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-4 py-2 text-sm text-accent-fg">
        {text}
      </div>
    </div>
  );
}

function AnswerBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-start">
      <div className="markdown-body max-w-[85%] rounded-2xl rounded-tl-sm border border-accent-border/30 bg-bg-elevated px-4 py-2 text-sm text-fg">
        {children}
      </div>
    </div>
  );
}

function TagChips({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-start gap-1 pl-1">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full border border-accent-border/50 bg-accent/30 px-2 py-0.5 text-[11px] font-medium text-accent-fg"
        >
          #{t}
        </span>
      ))}
    </div>
  );
}

// ── D41: 질문 토큰 오버랩 근사 하이라이트 ──────────────────────────────
const STOPWORDS = new Set([
  "그리고", "그러나", "하지만", "또는", "또한", "그래서", "때문", "위해",
  "에서", "으로", "에게", "에는", "이다", "있다", "없다", "하는", "한다",
  "the", "and", "for", "with", "that", "this", "from", "what", "how",
  "은", "는", "이", "가", "을", "를", "의", "에", "와", "과", "도", "만",
]);

function normalizeToken(t: string): string {
  return t.toLowerCase().replace(/[^0-9a-z가-힣]/gi, "");
}

function questionTokenSet(question: string): Set<string> {
  const set = new Set<string>();
  for (const raw of question.split(/\s+/)) {
    const n = normalizeToken(raw);
    if (n.length >= 2 && !STOPWORDS.has(n)) set.add(n);
  }
  return set;
}

/** 질문 토큰과 겹치는 어절을 <mark>로 감싼 근사 하이라이트. */
function HighlightedText({
  text,
  question,
}: {
  text: string;
  question: string;
}) {
  const tokens = questionTokenSet(question);
  if (tokens.size === 0) return <>{text}</>;
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) => {
        const n = normalizeToken(part);
        const hit = n.length >= 2 && tokens.has(n);
        return hit ? (
          <mark
            key={i}
            className="rounded bg-[#fcf58b] px-0.5 text-fg"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        );
      })}
    </>
  );
}

/** D41: 출처 청크 전문 + 인접 청크 + 근사 하이라이트(온디맨드 조회). */
function ChunkDetail({
  chunkId,
  question,
}: {
  chunkId: string;
  question: string;
}) {
  const [showPrev, setShowPrev] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const {
    data: ctx,
    isLoading: loading,
    isError: error,
  } = useQuery<ChunkContext>({
    queryKey: ["chunk-context", chunkId],
    queryFn: () => getChunkContext(chunkId, 1),
    staleTime: 5 * 60 * 1000,
  });

  if (loading)
    return (
      <div className="rounded-md border border-[#2a7d7a]/30 bg-[#2a7d7a]/5 px-2 py-1.5 text-[11px] text-fg-muted">
        원문 불러오는 중…
      </div>
    );
  if (error || !ctx)
    return (
      <div className="rounded-md border border-danger/30 bg-danger/5 px-2 py-1.5 text-[11px] text-danger">
        원문을 불러오지 못했습니다.
      </div>
    );

  return (
    <div className="rounded-md border border-[#2a7d7a]/30 bg-[#2a7d7a]/5 px-2.5 py-2 text-[11px] leading-relaxed">
      <div className="mb-1 flex items-center gap-1.5 font-medium text-[#2a7d7a]">
        📄 {ctx.name ?? "자료"}
        {ctx.seq != null ? <span>· #{ctx.seq}</span> : null}
        {ctx.page != null ? <span>· p.{ctx.page}</span> : null}
        <span className="ml-auto text-[10px] font-normal text-fg-muted">
          관련 부분(근사)
        </span>
      </div>

      {ctx.prev_text ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowPrev((v) => !v);
          }}
          className="mb-1 flex items-center gap-0.5 text-[10px] text-fg-muted hover:text-fg"
        >
          {showPrev ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          이전 청크
        </button>
      ) : null}
      {showPrev && ctx.prev_text ? (
        <p className="mb-1 whitespace-pre-wrap border-l-2 border-[#2a7d7a]/20 pl-2 text-fg-muted">
          {ctx.prev_text}
        </p>
      ) : null}

      <p className="whitespace-pre-wrap text-fg">
        <HighlightedText text={ctx.chunk_text} question={question} />
      </p>

      {ctx.next_text ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowNext((v) => !v);
          }}
          className="mt-1 flex items-center gap-0.5 text-[10px] text-fg-muted hover:text-fg"
        >
          {showNext ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          다음 청크
        </button>
      ) : null}
      {showNext && ctx.next_text ? (
        <p className="mt-1 whitespace-pre-wrap border-l-2 border-[#2a7d7a]/20 pl-2 text-fg-muted">
          {ctx.next_text}
        </p>
      ) : null}
    </div>
  );
}

/** D32/D41: RAG 출처 칩 + snippet 펼침 + chunk_id 있으면 ⋯ 전문 패널. 청록(C.file) 톤. */
function RagSourceChips({
  sources,
  question,
}: {
  sources: RagSource[];
  question: string;
}) {
  const [open, setOpen] = useState<number | null>(null); // snippet 펼침
  const [detail, setDetail] = useState<number | null>(null); // ⋯ 전문 패널
  if (sources.length === 0) return null;
  const active = open != null ? sources[open] : null;
  const detailSrc = detail != null ? sources[detail] : null;
  return (
    <div className="flex flex-col gap-1 pl-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className="text-[10px] font-medium text-[#2a7d7a]">출처</span>
        {sources.map((s, i) => {
          const label = `${s.name ?? "자료"}${
            s.seq != null ? ` #${s.seq}` : ""
          }${s.page != null ? ` · p.${s.page}` : ""}`;
          return (
            <span
              key={`${s.file_id}-${s.seq ?? "x"}-${i}`}
              className={`inline-flex items-center rounded-md border text-[10px] transition-colors ${
                open === i || detail === i
                  ? "border-[#2a7d7a] bg-[#2a7d7a]/15 text-[#2a7d7a]"
                  : "border-[#2a7d7a]/50 bg-[#2a7d7a]/5 text-[#2a7d7a]"
              }`}
            >
              <button
                type="button"
                title={s.snippet ?? undefined}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(open === i ? null : i);
                }}
                className="max-w-[14rem] truncate px-1.5 py-0.5 hover:brightness-110"
              >
                📄 {label}
              </button>
              {s.chunk_id ? (
                <button
                  type="button"
                  title="원문 보기"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDetail(detail === i ? null : i);
                  }}
                  className="border-l border-[#2a7d7a]/30 px-1 py-0.5 hover:brightness-110"
                >
                  <MoreHorizontal size={12} />
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {active?.snippet && detail == null && (
        <div className="whitespace-pre-wrap rounded-md border border-[#2a7d7a]/30 bg-[#2a7d7a]/5 px-2 py-1 text-[11px] leading-relaxed text-fg-muted">
          {active.snippet}
        </div>
      )}
      {detailSrc?.chunk_id && (
        <ChunkDetail chunkId={detailSrc.chunk_id} question={question} />
      )}
    </div>
  );
}

/** D46: 참조 브랜치 체인 컨텍스트 팝업. 같은 세션=캐시, 다른 세션=getSession 조회. */
function BranchContextPopup({
  source,
  sessionNodes,
  currentSessionId,
  onClose,
}: {
  source: ReferenceSource;
  sessionNodes: NodeRow[];
  currentSessionId: string | null;
  onClose: () => void;
}) {
  const sameSession = source.session_id === currentSessionId;
  const { data: fetched, isLoading, isError } = useQuery({
    queryKey: sessionKey(source.session_id),
    queryFn: () => getSession(source.session_id),
    enabled: !sameSession,
    retry: false, // D49: 실패 시 재시도 지연 없이 즉시 에러 상태로(무한 로딩처럼 보이지 않게)
  });
  const sourceNodes = sameSession ? sessionNodes : fetched?.nodes ?? null;
  const loading = !sameSession && isLoading;
  // D49: 다른 세션 조회가 에러로 끝나면 무한 "불러오는 중…" 대신 명시적 에러 상태.
  const errored = !sameSession && isError;
  const chain = useMemo(() => {
    if (!sourceNodes) return null;
    const byId = buildById(sourceNodes);
    // leaf_id 기준 조상 체인(루트→leaf). 없으면 node_ids 순서대로.
    const c = ancestorChain(source.leaf_id, byId);
    if (c.length > 0) return c;
    return source.node_ids
      .map((id) => byId.get(id))
      .filter((n): n is NodeRow => !!n);
  }, [sourceNodes, source.leaf_id, source.node_ids]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-lg flex-col rounded-2xl border border-[#9a5ea3]/50 bg-bg-elevated shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#9a5ea3]/30 px-4 py-2.5">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-[#9a5ea3]">
            <GitBranch size={14} /> 참조 브랜치 · {source.label}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-muted hover:text-fg"
            aria-label="닫기"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {loading ? (
            <p className="text-sm text-fg-muted">불러오는 중…</p>
          ) : errored ? (
            <p className="text-sm text-fg-muted">
              브랜치 내용을 불러오지 못했습니다.
            </p>
          ) : chain == null || chain.length === 0 ? (
            <p className="text-sm text-fg-muted">
              브랜치 내용을 불러올 수 없습니다.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {chain.map((n) => (
                <div key={n.id} className="flex flex-col gap-1">
                  <p className="text-xs font-medium text-fg">{n.question}</p>
                  <p className="whitespace-pre-wrap rounded-lg bg-[#9a5ea3]/5 px-2.5 py-1.5 text-xs leading-relaxed text-fg-muted">
                    {n.answer || "…"}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** D46: 답변 박스 우측 하단 참조 브랜치 칩 + 브랜치 버튼(보라 비교 톤). */
function ReferenceSourceChips({
  sources,
  sessionNodes,
  currentSessionId,
}: {
  sources: ReferenceSource[];
  sessionNodes: NodeRow[];
  currentSessionId: string | null;
}) {
  const [popup, setPopup] = useState<ReferenceSource | null>(null);
  if (sources.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1 pr-1">
      <span className="text-[10px] font-medium text-[#9a5ea3]">참조 브랜치</span>
      {sources.map((s, i) => (
        <button
          key={`${s.leaf_id}-${i}`}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setPopup(s);
          }}
          title="이 브랜치의 대화 맥락 보기"
          className="flex max-w-[15rem] items-center gap-1 truncate rounded-md border border-[#9a5ea3]/50 bg-[#9a5ea3]/5 px-1.5 py-0.5 text-[10px] text-[#9a5ea3] transition-colors hover:bg-[#9a5ea3]/10"
        >
          <GitBranch size={11} />
          <span className="truncate">{s.label}</span>
        </button>
      ))}
      {popup && (
        <BranchContextPopup
          source={popup}
          sessionNodes={sessionNodes}
          currentSessionId={currentSessionId}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}

function ExchangeBubble({
  node,
  active,
  onFocus,
  sessionNodes,
  currentSessionId,
}: {
  node: NodeRow;
  active: boolean;
  onFocus: () => void;
  sessionNodes: NodeRow[];
  currentSessionId: string | null;
}) {
  return (
    <div
      title={active ? undefined : "클릭하면 이 노드로 이동"}
      className={`flex cursor-pointer flex-col gap-2 rounded-xl p-2 transition-colors ${
        active ? "bg-accent/15" : "hover:bg-fg/[0.05]"
      }`}
      onClick={onFocus}
    >
      <UserBubble text={node.question} />
      <AnswerBubble>
        {node.answer ? (
          <ReactMarkdown>{node.answer}</ReactMarkdown>
        ) : node.is_navigator && node.navigator_question ? (
          <span className="text-fg-muted">
            제안된 질문: {node.navigator_question}
          </span>
        ) : (
          <span className="text-fg-muted">…</span>
        )}
      </AnswerBubble>
      {node.tags && node.tags.length > 0 ? <TagChips tags={node.tags} /> : null}
      {node.rag_sources && node.rag_sources.length > 0 ? (
        <RagSourceChips sources={node.rag_sources} question={node.question} />
      ) : null}
      {node.reference_sources && node.reference_sources.length > 0 ? (
        <ReferenceSourceChips
          sources={node.reference_sources}
          sessionNodes={sessionNodes}
          currentSessionId={currentSessionId}
        />
      ) : null}
    </div>
  );
}
