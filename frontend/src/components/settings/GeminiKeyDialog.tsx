"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ExternalLink, KeyRound, Trash2, X } from "lucide-react";
import {
  maskGeminiKey,
  removeGeminiKey,
  saveGeminiKey,
  useGeminiKey,
  useGeminiKeyDialog,
} from "@/lib/geminiKey";

const ISSUE_URL = "https://aistudio.google.com/apikey";

/**
 * Gemini API 키 설정 다이얼로그(전역 1개, Providers에 마운트).
 * - 키는 이 브라우저(localStorage)에만 저장되고 서버에는 저장되지 않는다.
 * - 화면에는 마지막 4자만 보인다(입력 칸도 password 타입).
 * - 닫기 가능(차단벽 아님).
 */
export function GeminiKeyDialog() {
  const open = useGeminiKeyDialog((s) => s.open);
  if (!open) return null;
  return <GeminiKeyDialogBody />;
}

function GeminiKeyDialogBody() {
  const reason = useGeminiKeyDialog((s) => s.reason);
  const closeDialog = useGeminiKeyDialog((s) => s.closeDialog);
  const current = useGeminiKey();
  const queryClient = useQueryClient();
  // 키가 바뀌면 키에 의존하는 AI 조회(홈 추천·자료 제안)를 다시 불러온다.
  const refreshAiQueries = () => {
    void queryClient.invalidateQueries({ queryKey: ["home", "suggestions"] });
    void queryClient.invalidateQueries({ queryKey: ["file-suggestions"] });
  };
  const [draft, setDraft] = useState("");
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeDialog]);

  const handleSave = () => {
    const v = draft.trim();
    if (!v) return;
    // 인쇄 가능한 ASCII만(제로폭·전각 문자 등은 헤더에 실을 수 없어 fetch가 실패한다).
    if (!/^[\x21-\x7E]+$/.test(v) || v.length < 20 || v.length > 200) {
      setMsg({ text: "키 형식이 올바르지 않아요. 다시 확인해 주세요.", error: true });
      return;
    }
    if (!saveGeminiKey(v)) {
      setMsg({
        text: "키를 저장할 수 없어요. 로그인 상태와 브라우저 저장소 설정을 확인해 주세요.",
        error: true,
      });
      return;
    }
    setDraft("");
    refreshAiQueries();
    setMsg({ text: "저장되었습니다. 이제 AI 기능을 쓸 수 있어요.", error: false });
  };

  const handleRemove = () => {
    removeGeminiKey();
    refreshAiQueries();
    setDraft("");
    setMsg({ text: "이 브라우저에서 키를 삭제했습니다.", error: false });
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4"
      onClick={closeDialog}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="gemini-key-title"
        className="w-full max-w-md rounded-2xl border border-accent-border/50 bg-bg-elevated p-5 text-fg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2
            id="gemini-key-title"
            className="flex items-center gap-1.5 text-base font-semibold"
          >
            <KeyRound size={16} className="text-accent-deep" />
            Gemini API 키
          </h2>
          <button
            type="button"
            onClick={closeDialog}
            aria-label="닫기"
            className="text-fg-muted hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        {reason && (
          <p className="mt-3 rounded-lg border border-accent-border/40 bg-accent/30 px-3 py-2 text-sm text-accent-fg">
            {reason}
          </p>
        )}

        <p className="mt-3 text-sm leading-relaxed text-fg-muted">
          nodi의 AI 대화·추천 기능은 본인의 Gemini API 키로 동작해요. 키는{" "}
          <strong className="font-semibold text-fg">이 브라우저에만 저장</strong>
          되며 서버에는 저장되지 않아요. AI 요청을 보낼 때만 함께 전송됩니다.
        </p>
        <a
          href={ISSUE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent-deep hover:underline"
        >
          Google AI Studio에서 키 발급받기 <ExternalLink size={13} />
        </a>

        <div className="mt-4 rounded-lg border border-accent-border/30 bg-bg px-3 py-2 text-sm">
          <span className="text-fg-muted">현재 키: </span>
          {current ? (
            <span className="font-mono text-fg">{maskGeminiKey(current)}</span>
          ) : (
            <span className="text-fg-muted">설정되지 않음</span>
          )}
        </div>

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            handleSave();
          }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setMsg(null);
            }}
            autoComplete="off"
            spellCheck={false}
            aria-label="Gemini API 키"
            placeholder={current ? "새 키로 교체" : "API 키 붙여넣기"}
            className="min-w-0 flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {current ? "교체" : "저장"}
          </button>
        </form>

        {msg && (
          <p className={`mt-2 text-xs ${msg.error ? "text-danger" : "text-positive"}`}>
            {msg.text}
          </p>
        )}

        <div className="mt-4 flex items-center justify-between">
          {current ? (
            <button
              type="button"
              onClick={handleRemove}
              className="flex items-center gap-1 text-xs font-medium text-danger hover:underline"
            >
              <Trash2 size={12} /> 이 브라우저에서 키 삭제
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={closeDialog}
            className="rounded-lg border border-accent-border/50 px-3 py-1.5 text-sm text-fg-muted transition-colors hover:text-fg"
          >
            닫기
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-fg-muted">
          키는 이 브라우저에 계정별로 저장돼요(다른 계정은 사용할 수 없어요). 로그아웃해도
          남아 있으니 공용 PC라면 사용 후 삭제해 주세요.
        </p>
      </div>
    </div>
  );
}
