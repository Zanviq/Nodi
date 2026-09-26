"use client";

import { KeyRound } from "lucide-react";
import { GEMINI_KEY_NOTICE, openGeminiKeyDialog } from "@/lib/geminiKey";

/**
 * AI 기능 자리에 쓰는 인라인 안내: "Gemini API 키를 입력하면 사용할 수 있어요" + [키 입력].
 * message를 주면 그 문구(예: 백엔드 오류 메시지)를 대신 보여준다.
 */
export function GeminiKeyNotice({
  message,
  className = "",
  compact = false,
}: {
  message?: string | null;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-accent-border/50 bg-accent/25 px-3 ${
        compact ? "py-1.5 text-xs" : "py-2 text-sm"
      } text-accent-fg ${className}`}
    >
      <KeyRound size={compact ? 12 : 14} className="shrink-0 text-accent-deep" />
      <span className="min-w-0 flex-1">{message || GEMINI_KEY_NOTICE}</span>
      <button
        type="button"
        onClick={() => openGeminiKeyDialog()}
        className="shrink-0 rounded-md border border-accent-border bg-bg-elevated px-2 py-0.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent"
      >
        키 입력
      </button>
    </div>
  );
}
