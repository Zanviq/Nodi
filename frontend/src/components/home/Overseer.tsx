"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Send, Sparkles, Plus, ArrowRight } from "lucide-react";
import { streamOverseer } from "@/lib/api";
import {
  isGeminiKeyError,
  openGeminiKeyDialog,
  useHasGeminiKey,
} from "@/lib/geminiKey";
import { GeminiKeyNotice } from "@/components/settings/GeminiKeyNotice";
import type { OverseerAction } from "@/lib/types";

/**
 * 총괄 AI(overseer) — 홈의 단발 Q/A. SSE 토큰 누적 + done.actions를 액션 버튼으로.
 * create_session → 새 세션+시드 시작, open_session → 해당 세션 열기(부모가 처리).
 */
interface Msg {
  role: "user" | "assistant";
  text: string;
  actions?: OverseerAction[];
}

export function Overseer({
  onCreateSession,
  onOpenSession,
}: {
  onCreateSession: (
    action: Extract<OverseerAction, { action: "create_session" }>,
  ) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [error, setError] = useState<{ text: string; code: string | null } | null>(
    null,
  );
  const hasKey = useHasGeminiKey();

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streamText, streaming]);

  const handleSend = async () => {
    const q = input.trim();
    if (!q || streaming || !hasKey) return;
    setError(null);
    setInput("");
    setMessages((m) => [...m, { role: "user", text: q }]);
    setStreaming(true);
    setStreamText("");

    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";
    let finished = false;

    await streamOverseer(
      q,
      {
        onToken: (delta) => {
          acc += delta;
          setStreamText(acc);
        },
        onDone: (data) => {
          setMessages((m) => [
            ...m,
            { role: "assistant", text: acc, actions: data.actions },
          ]);
          finished = true;
          setStreaming(false);
          setStreamText("");
        },
        onError: (detail, code) => {
          finished = true;
          setError({ text: detail, code });
          if (isGeminiKeyError(code)) openGeminiKeyDialog(detail);
          setStreaming(false);
          setStreamText("");
        },
      },
      controller.signal,
    );

    // done·error 없이 스트림이 끝났으면(프록시 절단 등) 입력 잠금을 풀고 안내한다.
    if (!finished && !controller.signal.aborted) {
      if (acc) {
        setMessages((m) => [...m, { role: "assistant", text: acc }]);
      }
      setError({ text: "응답이 중단됐어요. 다시 시도해 주세요.", code: null });
      setStreaming(false);
      setStreamText("");
    }
  };

  return (
    <section className="flex h-full min-h-0 flex-col rounded-xl border border-accent-border/30 bg-bg-elevated">
      <div className="flex items-center gap-2 border-b border-accent-border/30 px-4 py-2.5">
        <Sparkles size={15} className="text-accent-deep" />
        <span className="text-sm font-semibold text-fg">총괄 AI</span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {messages.length === 0 && !streaming ? (
          <p className="py-6 text-center text-sm text-fg-muted">
            무엇이든 물어보세요. 공간을 살펴 새 대화방을 만들거나 기존 대화로
            안내해 드릴게요.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent px-3 py-1.5 text-sm text-accent-fg">
                    {m.text}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex flex-col gap-2">
                  <div className="markdown-body max-w-[90%] rounded-2xl rounded-tl-sm border border-accent-border/30 bg-bg px-3 py-1.5 text-sm text-fg">
                    <ReactMarkdown>{m.text}</ReactMarkdown>
                  </div>
                  {m.actions && m.actions.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {m.actions.map((a, j) =>
                        a.action === "create_session" ? (
                          <button
                            key={j}
                            type="button"
                            onClick={() => onCreateSession(a)}
                            className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white"
                          >
                            <Plus size={13} />
                            {a.label}
                          </button>
                        ) : (
                          <button
                            key={j}
                            type="button"
                            onClick={() => onOpenSession(a.session_id)}
                            className="flex items-center gap-1 rounded-lg border border-accent-border/60 px-2.5 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-accent/30"
                          >
                            <ArrowRight size={13} />
                            {a.label}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              ),
            )}

            {streaming && (
              <div className="markdown-body max-w-[90%] rounded-2xl rounded-tl-sm border border-accent-border/30 bg-bg px-3 py-1.5 text-sm text-fg">
                {streamText ? (
                  <ReactMarkdown>{streamText}</ReactMarkdown>
                ) : (
                  <span className="text-fg-muted">생각하는 중…</span>
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-accent-border/30 p-3">
        {!hasKey ? (
          <GeminiKeyNotice compact className="mb-2" />
        ) : error && isGeminiKeyError(error.code) ? (
          <GeminiKeyNotice compact message={error.text} className="mb-2" />
        ) : error ? (
          <p className="mb-2 text-xs text-danger">{error.text}</p>
        ) : null}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder="총괄 AI에게 물어보기"
            disabled={streaming}
            className="max-h-32 flex-1 resize-none rounded-xl border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={streaming || !input.trim() || !hasKey}
            className="flex items-center gap-1 rounded-xl bg-accent-deep px-3 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </section>
  );
}
