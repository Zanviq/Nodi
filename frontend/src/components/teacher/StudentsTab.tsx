"use client";

import { useState } from "react";
import { User, MessageSquare } from "lucide-react";
import { useClassStudents, useStudentClassSessions } from "@/lib/queries";
import { ReadOnlyThread } from "./ReadOnlyThread";

/**
 * 학생 탭: 학급 학생 목록 → 학생 선택 → 그 학생의 학급 세션 목록 → 세션 선택 → 읽기 전용 대화.
 */
export function StudentsTab({ classId }: { classId: string }) {
  const { data: students, isLoading } = useClassStudents(classId);
  const [studentId, setStudentId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const { data: sessions } = useStudentClassSessions(classId, studentId);

  const selectStudent = (id: string) => {
    setStudentId(id);
    setSessionId(null);
  };

  return (
    <div className="grid h-full min-h-0 grid-cols-[220px_240px_minmax(0,1fr)]">
      {/* 학생 목록 */}
      <div className="min-h-0 overflow-auto border-r border-accent-border/30 p-2">
        <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          학생
        </div>
        {isLoading ? (
          <p className="px-2 py-2 text-sm text-fg-muted">불러오는 중…</p>
        ) : !students || students.length === 0 ? (
          <p className="px-2 py-2 text-sm text-fg-muted">학생이 없습니다.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {students.map((s) => {
              const active = s.user_id === studentId;
              return (
                <li key={s.user_id}>
                  <button
                    type="button"
                    onClick={() => selectStudent(s.user_id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      active ? "bg-accent text-accent-fg" : "text-fg hover:bg-accent/30"
                    }`}
                  >
                    <User size={14} className="shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="block truncate">
                        {s.display_name || s.username || s.user_id.slice(0, 8)}
                      </span>
                      {s.display_name && s.username ? (
                        <span className="block truncate text-[11px] text-fg-muted">
                          @{s.username}
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 세션 목록 */}
      <div className="min-h-0 overflow-auto border-r border-accent-border/30 p-2">
        <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">
          학급 대화
        </div>
        {!studentId ? (
          <p className="px-2 py-2 text-sm text-fg-muted">학생을 선택하세요.</p>
        ) : !sessions || sessions.length === 0 ? (
          <p className="px-2 py-2 text-sm text-fg-muted">대화가 없습니다.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {sessions.map((s) => {
              const active = s.id === sessionId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setSessionId(s.id)}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
                      active ? "bg-accent text-accent-fg" : "text-fg hover:bg-accent/30"
                    }`}
                  >
                    <MessageSquare size={14} className="shrink-0 opacity-70" />
                    <span className="truncate">{s.title?.trim() || "새 대화"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 읽기 전용 대화 */}
      <div className="min-h-0 overflow-auto">
        {sessionId ? (
          <ReadOnlyThread sessionId={sessionId} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            세션을 선택하면 대화를 열람합니다.
          </div>
        )}
      </div>
    </div>
  );
}
