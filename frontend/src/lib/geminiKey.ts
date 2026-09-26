"use client";

import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

/**
 * 사용자 본인의 Gemini API 키 (분류 C — 사용자가 직접 입력).
 *
 * - 저장 위치: 이 브라우저의 localStorage, **계정별** 키 `nodi-gemini-api-key:<userId>`.
 *   서버에는 저장되지 않는다. 같은 브라우저의 다른 계정은 서로의 키를 쓰지 않는다.
 * - 전송: 우리 백엔드의 AI 요청에만 `X-Gemini-Key` 헤더로 실린다(lib/api.ts).
 *   URL·쿼리스트링·로그에는 절대 넣지 않는다.
 * - 키 값은 캐시하지 않고 매번 localStorage에서 읽는다. 캐시하는 것은 "현재 사용자 id"
 *   하나뿐이며, GeminiKeyScope(Providers)가 /auth/me 결과가 바뀔 때마다(로그인·로그아웃·
 *   계정 전환) setGeminiKeyUser로 갱신한다(무효화 훅). 로그아웃/401은 전체 페이지 이동이라
 *   모듈 상태도 초기화된다.
 */
const STORAGE_PREFIX = "nodi-gemini-api-key:";
/** 과거(계정 구분 없는) 전역 키 — 어느 계정 것인지 알 수 없으므로 삭제만 한다. */
const LEGACY_STORAGE_KEY = "nodi-gemini-api-key";
const PROMPTED_KEY = "nodi-gemini-key-prompted";

const listeners = new Set<() => void>();
let currentUserId: string | null = null;
let legacyCleaned = false;

function emit() {
  listeners.forEach((l) => l());
}

function storageKey(): string | null {
  return currentUserId ? `${STORAGE_PREFIX}${currentUserId}` : null;
}

/** 현재 로그인 사용자 설정(null = 로그아웃). 바뀌면 구독자(헤더·버튼·표시)가 다시 읽는다. */
export function setGeminiKeyUser(userId: string | null): void {
  if (!legacyCleaned && typeof window !== "undefined") {
    legacyCleaned = true;
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* 무시 */
    }
  }
  if (userId === currentUserId) return;
  currentUserId = userId;
  emit();
}

export function readGeminiKey(): string | null {
  if (typeof window === "undefined") return null;
  const k = storageKey();
  if (!k) return null;
  try {
    const v = window.localStorage.getItem(k);
    return v && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

export function saveGeminiKey(key: string): boolean {
  const k = storageKey();
  if (!k) return false;
  try {
    window.localStorage.setItem(k, key.trim());
    emit();
    return true;
  } catch {
    return false;
  }
}

export function removeGeminiKey(): void {
  const k = storageKey();
  if (k) {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* 저장소 접근 불가 — 무시 */
    }
  }
  emit();
}

function readUserId(): string | null {
  return currentUserId;
}

/** 화면 표시용 마스킹: 마지막 4자만 보인다. */
export function maskGeminiKey(key: string | null): string {
  if (!key) return "";
  return `••••••••${key.slice(-4)}`;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === storageKey()) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** 현재 키(SSR/하이드레이션 전에는 null). */
export function useGeminiKey(): string | null {
  return useSyncExternalStore(subscribe, readGeminiKey, () => null);
}

export function useHasGeminiKey(): boolean {
  return useGeminiKey() !== null;
}

/** 키 범위가 정해진 현재 사용자 id(로그인 확인 전/로그아웃이면 null). */
export function useGeminiKeyUserId(): string | null {
  return useSyncExternalStore(subscribe, readUserId, () => null);
}

/**
 * AI 기능 화면 첫 진입 안내 훅: 사용자가 확정된 뒤에만 판단한다
 * (프로필 로딩 중 "키 없음"으로 오판해 띄우지 않도록).
 */
export function useGeminiKeyFirstPrompt(): void {
  const userId = useGeminiKeyUserId();
  useEffect(() => {
    if (userId) promptGeminiKeyOnce();
  }, [userId]);
}

// ── 키 설정 다이얼로그 전역 열림 상태 ────────────────────────────────

interface KeyDialogState {
  open: boolean;
  /** 열린 이유(첫 진입 안내 / 오류 안내 등) — 다이얼로그 상단 문구에 사용. */
  reason: string | null;
  openDialog: (reason?: string | null) => void;
  closeDialog: () => void;
}

export const useGeminiKeyDialog = create<KeyDialogState>((set) => ({
  open: false,
  reason: null,
  openDialog: (reason = null) => set({ open: true, reason }),
  closeDialog: () => set({ open: false, reason: null }),
}));

export function openGeminiKeyDialog(reason?: string | null) {
  useGeminiKeyDialog.getState().openDialog(reason ?? null);
}

/**
 * AI 기능 첫 진입 시 키가 없으면 다이얼로그를 한 번 띄운다(브라우저 탭 세션당 1회,
 * 닫으면 다시 안 뜸 — 차단벽 아님).
 */
export function promptGeminiKeyOnce(): void {
  if (readGeminiKey()) return;
  try {
    if (window.sessionStorage.getItem(PROMPTED_KEY)) return;
    window.sessionStorage.setItem(PROMPTED_KEY, "1");
  } catch {
    return;
  }
  openGeminiKeyDialog(
    "AI 대화·추천 기능을 쓰려면 본인의 Gemini API 키가 필요해요.",
  );
}

/** 백엔드가 돌려준 오류 코드가 키 관련인지. */
export function isGeminiKeyError(code: string | null | undefined): boolean {
  return !!code && code.startsWith("gemini_");
}

export const GEMINI_KEY_NOTICE = "Gemini API 키를 입력하면 사용할 수 있어요";
