"use client";

import { useEffect } from "react";
import { useProfile } from "@/lib/hooks";
import { setGeminiKeyUser } from "@/lib/geminiKey";

/**
 * Gemini 키의 계정 범위 동기화(렌더 없음, Providers에 1개).
 * /auth/me 결과(로그인·로그아웃·계정 전환)가 바뀔 때마다 현재 사용자 id를 갱신해
 * 헤더·버튼·표시가 그 계정의 키(nodi-gemini-api-key:<userId>)만 읽게 한다.
 */
export function GeminiKeyScope() {
  const { data: profile, isFetched } = useProfile();
  const userId = profile?.id ?? null;
  useEffect(() => {
    // 첫 조회 전에는 판단 보류(초기값 null 유지) — 조회가 끝나면 확정.
    if (!isFetched && !userId) return;
    setGeminiKeyUser(userId);
  }, [userId, isFetched]);
  return null;
}
