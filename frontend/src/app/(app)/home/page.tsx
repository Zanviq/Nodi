"use client";

import { useState } from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare, ChevronRight, Lightbulb, TreeDeciduous } from "lucide-react";
import { profileName, useProfile } from "@/lib/hooks";
import { ApiError } from "@/lib/api";
import {
  isGeminiKeyError,
  useGeminiKeyFirstPrompt,
  useHasGeminiKey,
} from "@/lib/geminiKey";
import { GeminiKeyNotice } from "@/components/settings/GeminiKeyNotice";
import {
  prefetchSessionData,
  useHomeSummary,
  useHomeSuggestions,
} from "@/lib/queries";
import { isRealId } from "@/lib/ids";
import { useStartSession } from "@/lib/useStartSession";
import { ConceptBubbles } from "@/components/home/ConceptBubbles";
import { Overseer } from "@/components/home/Overseer";
import type { HomeRecentSession, OverseerAction, SpaceKind } from "@/lib/types";

/**
 * 홈 화면 (Stage 4a) — 항상 접근 가능한 진입점.
 * 개념 그래프 박스 + 대화 내역 + 질문 박스(가로 버튼 3개) + 총괄 AI.
 */
export default function HomePage() {
  const { data: profile } = useProfile();
  const { data: summary, isLoading: summaryLoading } = useHomeSummary();
  const hasKey = useHasGeminiKey();
  const {
    data: suggestionsData,
    error: suggestionsError,
    isLoading: suggestionsLoading,
  } = useHomeSuggestions(hasKey);
  const suggestionsKeyError =
    suggestionsError instanceof ApiError &&
    isGeminiKeyError(suggestionsError.code)
      ? suggestionsError.message
      : null;
  const { startSeeded, openSession } = useStartSession();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  // 08 G: 최근 대화 hover 시 그 세션 데이터 선반입 → 클릭→워크스페이스 진입이 즉시 채워짐.
  const prefetchRecent = (id: string) => {
    if (isRealId(id)) prefetchSessionData(queryClient, id);
  };

  // AI 기능 첫 진입: 키가 없으면 설정 안내를 한 번 띄운다(닫을 수 있음).
  useGeminiKeyFirstPrompt();

  const displayName = profileName(profile);
  const concepts = summary?.top_concepts ?? [];
  const recent = summary?.recent_sessions ?? [];
  const suggestions = suggestionsData?.suggestions ?? [];

  // iso만으로 결정적 포맷(현재 시각 비교 없음 — 렌더 순수성 유지)
  const formatTime = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
  };

  // space 이름 조회 (recent 세션/액션 표시용)
  const spaceName = (kind: SpaceKind, ref: string | null): string => {
    if (kind === "personal") return "개인 공간";
    const found = summary?.spaces.find(
      (s) => s.space_kind === "class" && s.space_ref === ref,
    );
    return found?.name ?? "학급";
  };

  const SESSION_FAIL_MSG = "세션을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  const handleSuggestion = async (seed: string) => {
    setActionError(null);
    try {
      await startSeeded({ spaceKind: "personal", spaceRef: null, seed });
    } catch {
      setActionError(SESSION_FAIL_MSG);
    }
  };

  const handleOpenRecent = (s: HomeRecentSession) => {
    openSession(s.space_kind, s.space_ref, s.id);
  };

  const handleCreateFromOverseer = async (
    a: Extract<OverseerAction, { action: "create_session" }>,
  ) => {
    setActionError(null);
    try {
      await startSeeded({
        spaceKind: a.space_kind,
        spaceRef: a.space_ref,
        seed: a.seed_question,
      });
    } catch {
      setActionError(SESSION_FAIL_MSG);
    }
  };

  const handleOpenFromOverseer = (sessionId: string) => {
    const s = recent.find((r) => r.id === sessionId);
    if (s) openSession(s.space_kind, s.space_ref, sessionId);
    else openSession("personal", null, sessionId); // 미상이면 개인으로 best-effort
  };

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-6 overflow-auto p-8">
      <header>
        <h1 className="text-2xl font-bold text-fg">
          {displayName ? `${displayName} 님, 환영합니다` : "홈"}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          많이 쓴 개념과 최근 대화를 한눈에. 무엇이든 총괄 AI에게 물어보세요.
        </p>
      </header>

      {actionError && (
        <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
          {actionError}
        </div>
      )}

      {/* 개념 그래프 박스 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated">
        <div className="flex items-center justify-between border-b border-accent-border/30 px-5 py-3">
          <div className="flex items-center gap-2">
            <TreeDeciduous size={16} className="text-accent-deep" />
            <h2 className="text-sm font-semibold text-fg">많이 쓴 개념</h2>
          </div>
          <Link
            href="/concepts"
            className="flex items-center gap-0.5 text-xs font-medium text-fg-muted hover:text-fg"
          >
            개념 나무 자세히 <ChevronRight size={13} />
          </Link>
        </div>
        <div className="h-56 p-2">
          {summaryLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-fg-muted">
              불러오는 중…
            </div>
          ) : concepts.length === 0 ? (
            <div className="flex h-full items-center justify-center text-center text-sm text-fg-muted">
              아직 개념이 없어요. 대화를 시작하면 개념이 자랍니다.
            </div>
          ) : (
            <Link href="/concepts" className="block h-full" title="개념 나무 보기">
              <ConceptBubbles concepts={concepts} />
            </Link>
          )}
        </div>
      </section>

      {/* 질문 박스 — 가로 버튼 3개 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <div className="flex items-center gap-2">
          <Lightbulb size={16} className="text-accent-deep" />
          <h2 className="text-sm font-semibold text-fg">이런 질문 어때요?</h2>
        </div>
        {!hasKey || suggestionsKeyError ? (
          <GeminiKeyNotice
            className="mt-3"
            message={suggestionsKeyError}
          />
        ) : (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          {suggestions.length === 0 && !suggestionsLoading
            ? (
                <div className="col-span-full rounded-lg border border-dashed border-accent-border/50 px-3 py-3 text-center text-xs text-fg-muted">
                  {suggestionsError
                    ? "추천을 불러오지 못했어요."
                    : "지금은 추천할 질문이 없어요. (API 키가 올바른지도 확인해 주세요)"}
                </div>
              )
            : suggestions.length === 0
            ? [0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="rounded-lg border border-dashed border-accent-border/50 px-3 py-3 text-center text-xs text-fg-muted"
                >
                  추천 준비 중…
                </div>
              ))
            : suggestions.slice(0, 3).map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => void handleSuggestion(s.seed_question)}
                  title={s.seed_question}
                  className="rounded-lg border border-accent-border bg-accent px-3 py-3 text-left text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white"
                >
                  {s.question}
                </button>
              ))}
        </div>
        )}
      </section>

      {/* 대화 내역 + 총괄 AI */}
      <div className="grid min-h-[22rem] grid-cols-1 gap-6 lg:grid-cols-2">
        {/* 대화 내역 */}
        <section className="flex min-h-0 flex-col rounded-xl border border-accent-border/30 bg-bg-elevated">
          <div className="border-b border-accent-border/30 px-5 py-3">
            <h2 className="text-sm font-semibold text-fg">최근 대화</h2>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            {summaryLoading ? (
              <p className="px-2 py-3 text-sm text-fg-muted">불러오는 중…</p>
            ) : recent.length === 0 ? (
              <p className="px-2 py-3 text-sm text-fg-muted">
                아직 대화가 없습니다.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {recent.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => handleOpenRecent(s)}
                      onMouseEnter={() => prefetchRecent(s.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent/30"
                    >
                      <span className="shrink-0">
                        {s.emoji || (
                          <MessageSquare
                            size={14}
                            className="opacity-60"
                          />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-fg">
                        {s.title?.trim() || "새 대화"}
                      </span>
                      <span className="shrink-0 text-xs text-fg-muted">
                        {spaceName(s.space_kind, s.space_ref)}
                      </span>
                      <span className="shrink-0 text-xs text-fg-muted/70">
                        {formatTime(s.updated_at)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 총괄 AI */}
        <Overseer
          onCreateSession={handleCreateFromOverseer}
          onOpenSession={handleOpenFromOverseer}
        />
      </div>
    </div>
  );
}
