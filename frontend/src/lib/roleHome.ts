import type { Profile } from "@/lib/types";

/** role별 기본 진입 경로(D19). */
export function roleHome(role?: string | null): string {
  if (role === "admin") return "/admin";
  if (role === "teacher") return "/teacher";
  return "/home";
}

/** 로그인 직후 착지 경로: admin→/admin, teacher→/teacher, 학생은 온보딩 여부로 분기(D18). */
export function landingPath(profile: Pick<Profile, "role" | "onboarded">): string {
  if (profile.role === "admin" || profile.role === "teacher") {
    return roleHome(profile.role);
  }
  return profile.onboarded ? "/home" : "/onboarding";
}
