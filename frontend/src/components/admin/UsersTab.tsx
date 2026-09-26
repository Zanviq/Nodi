"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listAdminUsers, setUserRole } from "@/lib/api";
import type { AdminUser, UserRole } from "@/lib/types";

const ROLES: UserRole[] = ["student", "teacher", "admin"];

/** 권한 탭: 사용자 목록 + role 변경. 본인 강등은 백엔드 403 → 에러 표시. */
export function UsersTab({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const { data: users, isLoading, isError } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: listAdminUsers,
  });
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRole = async (user: AdminUser, role: UserRole) => {
    if (role === user.role) return;
    setError(null);
    setSavingId(user.id);
    try {
      await setUserRole(user.id, role);
      await queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (e) {
      setError(
        user.id === currentUserId
          ? "본인 role은 강등할 수 없습니다."
          : `role 변경 실패: ${(e as Error).message}`,
      );
    } finally {
      setSavingId(null);
    }
  };

  if (isLoading)
    return <p className="text-sm text-[#9a948a]">사용자 불러오는 중…</p>;
  if (isError)
    return <p className="text-sm text-[#e0796a]">사용자를 불러오지 못했습니다.</p>;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">사용자 권한</h2>
      {error && (
        <div className="rounded border border-[#e0796a]/40 bg-[#e0796a]/10 px-3 py-2 text-sm text-[#e0796a]">
          {error}
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-[#221e17] text-left text-xs uppercase text-[#9a948a]">
            <tr>
              <th className="px-3 py-2">아이디</th>
              <th className="px-3 py-2">이름</th>
              <th className="px-3 py-2">가입일</th>
              <th className="px-3 py-2">권한</th>
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => (
              <tr key={u.id} className="border-t border-white/5">
                <td className="px-3 py-2">
                  {u.username || u.email || u.id.slice(0, 8)}
                  {u.id === currentUserId && (
                    <span className="ml-1 text-xs text-[#9a948a]">(나)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-[#cfc9bd]">
                  {u.display_name || "—"}
                </td>
                <td className="px-3 py-2 text-[#9a948a]">
                  {new Date(u.created_at).toLocaleDateString("ko-KR")}
                </td>
                <td className="px-3 py-2">
                  <select
                    value={ROLES.includes(u.role as UserRole) ? (u.role as UserRole) : "student"}
                    disabled={savingId === u.id}
                    onChange={(e) => handleRole(u, e.target.value as UserRole)}
                    className="rounded border border-white/15 bg-[#1b1813] px-2 py-1 text-sm text-[#e7e3d8] disabled:opacity-50"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
