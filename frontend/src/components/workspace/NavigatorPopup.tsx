"use client";

import { useEffect } from "react";
import { Compass, X, Send } from "lucide-react";
import type { NodeRow } from "@/lib/types";
import { useHasGeminiKey } from "@/lib/geminiKey";
import { GeminiKeyNotice } from "@/components/settings/GeminiKeyNotice";

/**
 * D40: 네비게이터 노드 클릭 시 뜨는 팝업.
 * 질문 + node.navigator_meta.rationale("이 질문으로 얻을 수 있는 내용") + [질문하기]/[닫기].
 * 클릭 시 추가 AI 호출 없음(저장된 rationale 사용). [질문하기]는 provisional 단일경로.
 */
export function NavigatorPopup({
  node,
  busy,
  onAsk,
  onClose,
}: {
  node: NodeRow;
  busy: boolean;
  onAsk: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hasKey = useHasGeminiKey();
  const question = node.navigator_question ?? node.question ?? "";
  const rationale = node.navigator_meta?.rationale?.trim();

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl border border-accent-border/50 bg-bg-elevated p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-accent-deep">
            <Compass size={14} /> 추천 질문
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

        <p className="text-sm font-medium leading-relaxed text-fg">{question}</p>

        {rationale ? (
          <div className="mt-3 rounded-lg border border-accent-border/30 bg-accent/10 px-3 py-2">
            <p className="text-[11px] font-medium text-accent-deep">
              이 질문으로 얻을 수 있는 내용
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
              {rationale}
            </p>
          </div>
        ) : null}

        {!hasKey && <GeminiKeyNotice compact className="mt-3" />}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl border border-accent-border/50 px-3 py-1.5 text-sm text-fg-muted transition-colors hover:text-fg disabled:opacity-60"
          >
            닫기
          </button>
          <button
            type="button"
            onClick={onAsk}
            disabled={busy || !hasKey}
            className="flex items-center gap-1 rounded-xl bg-accent-deep px-4 py-1.5 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            <Send size={14} />
            {busy ? "전송 중…" : "질문하기"}
          </button>
        </div>
      </div>
    </div>
  );
}
