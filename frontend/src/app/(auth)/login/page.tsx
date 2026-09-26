"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, login, register } from "@/lib/api";
import { useProfile } from "@/lib/hooks";
import { landingPath } from "@/lib/roleHome";
import type { Profile } from "@/lib/types";

/**
 * 로그인 / 회원가입 (아이디 + 비밀번호).
 * 성공 시 백엔드가 httpOnly 세션 쿠키를 심고, 역할별 착지 경로로 이동한다.
 * 이미 로그인된 상태(/auth/me 200)로 들어오면 바로 착지 경로로 보낸다.
 */
type Mode = "login" | "signup";

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const inputCls =
  "w-full rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent-deep";

export default function LoginPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: me } = useProfile();

  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me) router.replace(landingPath(me));
  }, [me, router]);

  const switchMode = (m: Mode) => {
    setMode(m);
    setError(null);
    setPassword("");
    setConfirm("");
  };

  const onSuccess = (profile: Profile) => {
    // 이전 사용자 캐시가 남지 않도록 비우고 새 프로필을 심는다.
    queryClient.clear();
    queryClient.setQueryData(["profile"], profile);
    router.replace(landingPath(profile));
    router.refresh();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (loading) return;
    setError(null);
    const u = username.trim();

    if (mode === "signup") {
      if (!USERNAME_RE.test(u)) {
        setError("아이디는 3–32자의 영문·숫자·_ . - 만 쓸 수 있어요.");
        return;
      }
      if (password.length < 8) {
        setError("비밀번호는 8자 이상이어야 해요.");
        return;
      }
      if (new TextEncoder().encode(password).length > 72) {
        setError("비밀번호가 너무 길어요(최대 72바이트).");
        return;
      }
      if (password !== confirm) {
        setError("비밀번호 확인이 일치하지 않아요.");
        return;
      }
      if (displayName.trim().length > 50) {
        setError("표시 이름은 50자 이하로 입력해 주세요.");
        return;
      }
    } else if (!u || !password) {
      setError("아이디와 비밀번호를 입력해 주세요.");
      return;
    }

    setLoading(true);
    try {
      const profile =
        mode === "login"
          ? await login(u, password)
          : await register({
              username: u,
              password,
              display_name: displayName.trim() || undefined,
            });
      onSuccess(profile);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "invalid_credentials") {
          setError("아이디 또는 비밀번호가 올바르지 않아요.");
        } else if (err.code === "username_taken") {
          setError("이미 사용 중인 아이디예요.");
        } else {
          setError(err.message);
        }
      } else {
        setError("서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.");
      }
      setLoading(false);
    }
  };

  const tabCls = (active: boolean) =>
    `flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
      active ? "bg-bg-elevated text-fg shadow-sm" : "text-fg-muted hover:text-fg"
    }`;

  return (
    <div className="rounded-2xl border border-accent-border/30 bg-bg-elevated p-8 shadow-sm">
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-xl font-bold text-accent-fg">
          n
        </div>
        <h1 className="text-xl font-bold text-fg">
          {mode === "login" ? "nodi 로그인" : "nodi 회원가입"}
        </h1>
        <p className="mt-1 text-sm text-fg-muted">
          AI 대화를 노드·트리로 시각화하는 서비스
        </p>
      </div>

      <div
        role="tablist"
        aria-label="로그인 또는 회원가입"
        className="mt-6 flex gap-1 rounded-lg bg-accent/30 p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "login"}
          onClick={() => switchMode("login")}
          className={tabCls(mode === "login")}
        >
          로그인
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signup"}
          onClick={() => switchMode("signup")}
          className={tabCls(mode === "signup")}
        >
          회원가입
        </button>
      </div>

      <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3" noValidate>
        <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
          아이디
          <input
            type="text"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={mode === "signup" ? "영문·숫자 3–32자" : "아이디"}
            className={inputCls}
          />
        </label>

        {mode === "signup" && (
          <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
            표시 이름 (선택)
            <input
              type="text"
              name="display_name"
              autoComplete="nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="비워두면 아이디로 표시돼요"
              className={inputCls}
            />
          </label>
        )}

        <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
          비밀번호
          <input
            type="password"
            name="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={mode === "signup" ? "8자 이상" : "비밀번호"}
            className={inputCls}
          />
        </label>

        {mode === "signup" && (
          <label className="flex flex-col gap-1 text-xs font-medium text-fg-muted">
            비밀번호 확인
            <input
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="비밀번호 다시 입력"
              className={inputCls}
            />
          </label>
        )}

        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="mt-1 w-full rounded-lg border border-accent-border bg-accent px-4 py-2.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          {loading
            ? mode === "login"
              ? "로그인 중…"
              : "가입 중…"
            : mode === "login"
              ? "로그인"
              : "가입하고 시작하기"}
        </button>
      </form>

      {mode === "login" && (
        <p className="mt-4 rounded-lg border border-dashed border-accent-border/50 px-3 py-2 text-center text-xs text-fg-muted">
          데모 계정: <span className="font-mono text-fg">demo</span> /{" "}
          <span className="font-mono text-fg">demo1234</span>
        </p>
      )}
    </div>
  );
}
