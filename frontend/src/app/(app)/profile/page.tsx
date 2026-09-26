"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { ApiError, joinClassByCode, updateMe } from "@/lib/api";
import { useLogout, useMyClasses, useProfile } from "@/lib/hooks";
import {
  maskGeminiKey,
  openGeminiKeyDialog,
  useGeminiKey,
} from "@/lib/geminiKey";

/**
 * 프로필 설정.
 * - 본인 profile 로드(username/display_name/role)
 * - 이름 변경(PATCH /auth/me)
 * - 학급 추가(POST /auth/me/classes/join) + 내 학급 목록
 * - Gemini API 키(이 브라우저에만 저장) 설정
 * - 로그아웃(POST /auth/logout)
 */
export default function ProfilePage() {
  const queryClient = useQueryClient();
  const handleLogout = useLogout();
  const geminiKey = useGeminiKey();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const { data: myClasses = [] } = useMyClasses();

  // 이름 입력: react-query의 profile.display_name을 기본값으로 두고,
  // 사용자가 편집을 시작하면 nameDraft가 우선한다(effect 동기화 없이 파생값).
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const name = nameDraft ?? profile?.display_name ?? "";
  const [savingName, setSavingName] = useState(false);
  const [nameMsg, setNameMsg] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [classMsg, setClassMsg] = useState<string | null>(null);

  const handleSaveName = async () => {
    const trimmed = name.trim();
    if (!trimmed || !profile) return;

    setNameMsg(null);
    setSavingName(true);
    try {
      const updated = await updateMe(trimmed.slice(0, 50));
      queryClient.setQueryData(["profile"], updated);
      setNameDraft(null);
      setNameMsg("저장되었습니다.");
    } catch {
      setNameMsg("이름을 저장하지 못했습니다.");
    }
    setSavingName(false);
  };

  const handleJoinClass = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setClassMsg(null);
    setJoining(true);
    try {
      await joinClassByCode(trimmed);
    } catch (e) {
      if (e instanceof ApiError && e.code === "invalid_join_code") {
        setClassMsg("유효하지 않은 학급 코드입니다.");
      } else {
        setClassMsg("학급 연결에 실패했습니다.");
      }
      setJoining(false);
      return;
    }

    setCode("");
    setClassMsg("학급에 연결되었습니다.");
    await queryClient.invalidateQueries({ queryKey: ["my-classes"] });
    setJoining(false);
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">프로필 설정</h1>
          <p className="mt-1 text-sm text-fg-muted">
            {profileLoading
              ? "불러오는 중…"
              : profile?.username
                ? `@${profile.username}${profile.role ? ` · ${profile.role}` : ""}`
                : "이름과 가입 학급을 관리합니다."}
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg border border-danger/50 px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/10"
        >
          로그아웃
        </button>
      </header>

      {/* 이름 변경 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">이름 변경</h2>
        <p className="mt-1 text-xs text-fg-muted">
          표시 이름(display_name)을 수정합니다.
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={50}
            placeholder="표시 이름"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleSaveName}
            disabled={savingName || !name.trim()}
            className="rounded-lg bg-accent-deep px-4 py-2 text-sm font-medium text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            저장
          </button>
        </div>
        {nameMsg && <p className="mt-2 text-xs text-fg-muted">{nameMsg}</p>}
      </section>

      {/* Gemini API 키 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-fg">
          <KeyRound size={14} className="text-accent-deep" />
          Gemini API 키
        </h2>
        <p className="mt-1 text-xs text-fg-muted">
          AI 대화·추천은 본인의 Gemini API 키로 동작합니다. 키는 이 브라우저에만
          저장되며 서버에는 저장되지 않습니다.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <span className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm">
            {geminiKey ? (
              <span className="font-mono text-fg">{maskGeminiKey(geminiKey)}</span>
            ) : (
              <span className="text-fg-muted">설정되지 않음</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => openGeminiKeyDialog()}
            className="rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white"
          >
            {geminiKey ? "변경·삭제" : "키 입력"}
          </button>
        </div>
      </section>

      {/* 학급 추가 */}
      <section className="rounded-xl border border-accent-border/30 bg-bg-elevated p-5">
        <h2 className="text-sm font-semibold text-fg">학급 추가</h2>
        <p className="mt-1 text-xs text-fg-muted">
          학급 코드를 입력해 새 학급에 연결합니다. (온보딩과 동일 메커니즘)
        </p>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleJoinClass();
            }}
            placeholder="학급 코드"
            className="flex-1 rounded-lg border border-accent-border/50 bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-muted"
          />
          <button
            type="button"
            onClick={handleJoinClass}
            disabled={joining || !code.trim()}
            className="rounded-lg border border-accent-border bg-accent px-4 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
          >
            연결
          </button>
        </div>
        {classMsg && <p className="mt-2 text-xs text-fg-muted">{classMsg}</p>}

        {/* 내 학급 목록 */}
        <div className="mt-4">
          <div className="text-xs font-medium text-fg-muted">내 학급</div>
          {myClasses.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">
              연결된 학급이 없습니다.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1.5">
              {myClasses.map((m) => (
                <li
                  key={m.class_id}
                  className="flex items-center justify-between rounded-lg border border-accent-border/30 bg-bg px-3 py-2 text-sm text-fg"
                >
                  <span>{m.classes?.name ?? "학급"}</span>
                  {m.role_in_class && (
                    <span className="text-xs text-fg-muted">
                      {m.role_in_class}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
