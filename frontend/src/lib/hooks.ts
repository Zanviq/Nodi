"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, listMyClasses, logout } from "@/lib/api";
import type { MyClass, Profile } from "@/lib/types";

// D24: 프로필/학급은 잘 안 바뀌므로 staleTime/gcTime을 길게 둬 내비게이션마다
// 재조회하지 않는다. 로그인/로그아웃/이름변경/학급가입 시 명시적으로 invalidate/clear.
const PROFILE_STALE = 5 * 60 * 1000; // 5분
const PROFILE_GC = 30 * 60 * 1000; // 30분

/** 로그인 사용자의 프로필 (GET /auth/me, 401이면 null). */
export function useProfile() {
  return useQuery({
    queryKey: ["profile"],
    queryFn: (): Promise<Profile | null> => getMe(),
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
    retry: false,
  });
}

/** 로그인 사용자가 가입한 학급 목록 (GET /auth/me/classes). */
export function useMyClasses() {
  return useQuery({
    queryKey: ["my-classes"],
    queryFn: (): Promise<MyClass[]> => listMyClasses(),
    staleTime: PROFILE_STALE,
    gcTime: PROFILE_GC,
  });
}

/**
 * 로그아웃: 쿠키 삭제(POST /auth/logout) → react-query 캐시 전체 비움 → /login.
 * 전체 페이지 이동으로 이전 사용자 메모리 상태가 남지 않게 한다.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await logout();
    queryClient.clear();
    window.location.assign("/login");
  }, [queryClient]);
}

/** 표시 이름 우선, 없으면 아이디. */
export function profileName(p: Profile | null | undefined): string | null {
  return p?.display_name?.trim() || p?.username || null;
}
