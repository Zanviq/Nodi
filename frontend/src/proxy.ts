import { NextResponse, type NextRequest } from "next/server";

/**
 * Next.js 16 Proxy (구 Middleware) — 라우트 보호.
 *
 * 세션 쿠키(nodi_session, httpOnly)가 없으면 보호 경로에서 /login으로 보낸다.
 * 쿠키의 실제 유효성 검증은 백엔드가 한다: API가 401을 주면 클라이언트가 쿠키를
 * 지우고(/auth/logout) /login으로 이동한다(lib/api.ts handleUnauthorized).
 * 로그인 상태에서 /login 진입 시의 역할별 이동은 로그인 페이지가 /auth/me로 처리한다
 * (만료 쿠키로 인한 리다이렉트 루프 방지).
 */
const SESSION_COOKIE = "nodi_session";

const PROTECTED_PREFIXES = [
  "/home",
  "/space",
  "/concepts",
  "/profile",
  "/teacher",
  "/admin",
  "/onboarding",
];

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );
  if (isProtected && !request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * 정적 파일 / 이미지 / 메타 / 백엔드 프록시(/api)를 제외한 모든 경로.
     */
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
