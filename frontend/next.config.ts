import type { NextConfig } from "next";

/**
 * 백엔드(FastAPI)는 같은 오리진의 `/api/*`로 프록시한다(쿠키가 first-party가 되도록).
 * `/api/auth/me` → `${BACKEND_URL}/auth/me`
 *
 * BACKEND_URL은 서버 전용 값이다(NEXT_PUBLIC 아님). rewrites는 빌드 시 routes-manifest에
 * 기록되므로 Docker 이미지는 빌드 인자 BACKEND_URL(기본 http://backend:8000)로 굽는다.
 * 로컬 개발(`npm run dev`)은 기본값 http://localhost:8000.
 */
const BACKEND_URL = (process.env.BACKEND_URL || "http://localhost:8000").replace(
  /\/+$/,
  "",
);

const nextConfig: NextConfig = {
  output: "standalone",
  // SSE(채팅·총괄 AI) 스트림이 gzip 버퍼링으로 뭉쳐 오지 않도록 압축을 끈다.
  compress: false,
  poweredByHeader: false,
  experimental: {
    // rewrite 프록시 한도: 기본 30초 무응답 절단·10MB 본문 제한 → 인라인 파일 처리(수십 초)와
    // 백엔드 업로드 한도(25MB)를 수용하도록 늘린다.
    proxyTimeout: 300_000,
    proxyClientMaxBodySize: "26mb",
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/:path*`,
      },
    ];
  },
};

export default nextConfig;
