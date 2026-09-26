"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, completeOnboarding, joinClassByCode } from "@/lib/api";
import { useMyClasses, useProfile } from "@/lib/hooks";

/**
 * 온보딩(학급코드) — 최초 가입 1회만(D18).
 * "연결할 학급이 있습니까?" → 학급코드 입력 → POST /auth/me/classes/join.
 * 시작 시 complete-onboarding 호출(이후 로그인엔 안 뜸).
 */
export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: myClasses = [] } = useMyClasses();
  const { data: profile } = useProfile();

  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 이미 온보딩 완료한 사용자가 직접 들어오면 홈으로
  useEffect(() => {
    if (profile?.onboarded) router.replace("/home");
  }, [profile?.onboarded, router]);

  const handleJoin = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setError(null);
    setLoading(true);

    try {
      await joinClassByCode(trimmed);
    } catch (e) {
      // 404 invalid_join_code = 잘못된/없는 코드
      if (e instanceof ApiError && e.code === "invalid_join_code") {
        setError("유효하지 않은 학급 코드입니다. 다시 확인해 주세요.");
      } else {
        setError("학급 연결 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.");
      }
      setLoading(false);
      return;
    }

    setCode("");
    await queryClient.invalidateQueries({ queryKey: ["my-classes"] });
    setLoading(false);
  };

  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 shadow-sm">
      <h1 className="text-xl font-bold text-fg">시작하기</h1>
      <p className="mt-2 text-sm text-fg-muted">연결할 학급이 있습니까?</p>

      <div className="mt-5">
        <label className="text-xs font-medium text-fg-muted" htmlFor="join-code">
          학급 코드 (선택)
        </label>
        <div className="mt-1 flex gap-2">
          <input
            id="join-code"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoin();
            }}
            placeholder="예: ABC123"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleJoin}
            disabled={loading || !code.trim()}
            className="rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
          >
            연결
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </div>

      {/* 연결된 학급 목록 */}
      {myClasses.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {myClasses.map((m) => (
            <li
              key={m.class_id}
              className="flex items-center gap-2 rounded-lg border border-positive/40 bg-positive/5 px-3 py-2 text-sm text-fg"
            >
              <span className="h-2 w-2 rounded-full bg-positive" />
              {m.classes?.name ?? "연결된 학급"}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          disabled={starting}
          onClick={async () => {
            setStarting(true);
            try {
              await completeOnboarding();
            } catch {
              /* 실패해도 진입은 진행(다음 로그인에 재시도 가능) */
            }
            await queryClient.invalidateQueries({ queryKey: ["profile"] });
            router.push("/home");
            router.refresh();
          }}
          className="w-full rounded-lg border border-accent-border bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          {starting
            ? "시작하는 중…"
            : myClasses.length > 0
              ? "완료하고 시작"
              : "학급 없이 시작"}
        </button>
      </div>
    </div>
  );
}
