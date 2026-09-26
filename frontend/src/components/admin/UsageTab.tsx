"use client";

import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { getAdminUsage } from "@/lib/api";
import type { AdminUsage } from "@/lib/types";

/** 사용량 탭: 사용자별 토큰/스텝(부분 집계 안내 포함). */
export function UsageTab() {
  const { data, isLoading, isError } = useQuery<AdminUsage>({
    queryKey: ["admin", "usage"],
    queryFn: getAdminUsage,
  });

  if (isLoading)
    return <p className="text-sm text-[#9a948a]">사용량 불러오는 중…</p>;
  if (isError)
    return <p className="text-sm text-[#e0796a]">사용량을 불러오지 못했습니다.</p>;

  const rows = data?.by_user ?? [];

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold text-[#e7e3d8]">사용량</h2>
      {(data?.partial || data?.note) && (
        <div className="flex items-start gap-2 rounded border border-white/10 bg-[#221e17] px-3 py-2 text-xs text-[#9a948a]">
          <Info size={14} className="mt-0.5 shrink-0 text-[#9a948a]" />
          <span>
            {data?.note ||
              "현재 ReAct 스킬 단계만 집계됩니다(채팅·태깅 토큰 미포함). 저장공간/임베딩 사용량은 파일 도입 후 제공."}
          </span>
        </div>
      )}
      <div className="overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full text-sm">
          <thead className="bg-[#221e17] text-left text-xs uppercase text-[#9a948a]">
            <tr>
              <th className="px-3 py-2">사용자</th>
              <th className="px-3 py-2 text-right">토큰</th>
              <th className="px-3 py-2 text-right">스텝 수</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-3 py-4 text-center text-[#9a948a]">
                  집계된 사용량이 없습니다.
                </td>
              </tr>
            ) : (
              rows.map((u) => (
                <tr key={u.owner_id} className="border-t border-white/5">
                  <td className="px-3 py-2">
                    {u.display_name || u.username || u.email || u.owner_id}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {u.total_tokens.toLocaleString()}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#cfc9bd]">
                    {u.step_count.toLocaleString()}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
