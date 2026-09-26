"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeminiKeyDialog } from "@/components/settings/GeminiKeyDialog";
import { GeminiKeyScope } from "@/components/settings/GeminiKeyScope";

/**
 * 전역 클라이언트 Provider.
 * - react-query QueryClient(staleTime 60s 기본).
 * - Gemini API 키 설정 다이얼로그(어느 화면에서든 openGeminiKeyDialog()로 연다).
 * - GeminiKeyScope: 로그인 사용자별로 Gemini 키 범위를 맞춘다(계정 전환 시 갱신).
 * 세션은 httpOnly 쿠키라 클라이언트 토큰 캐시가 없다.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <GeminiKeyScope />
      {children}
      <GeminiKeyDialog />
    </QueryClientProvider>
  );
}
