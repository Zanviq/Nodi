"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import {
  Home,
  KeyRound,
  Settings,
  Shield,
  School,
  TreeDeciduous,
  type LucideIcon,
} from "lucide-react";
import { profileName, useMyClasses, useProfile } from "@/lib/hooks";
import { openGeminiKeyDialog, useHasGeminiKey } from "@/lib/geminiKey";
import { listSessions, spaceTargetFromId } from "@/lib/api";
import { sessionsKey, STALE } from "@/lib/queries";
import { roleHome } from "@/lib/roleHome";

/**
 * 좌측 64px 아이콘 사이드바 (dark brown).
 * 항목: [홈 진입] · [공간 전환: 개인 + 가입 학급] · [Gemini API 키] · [프로필·설정]
 * 공간은 실제 데이터(개인 + class_members→classes). 미로그인/로딩 시에도 셸이 깨지지 않음.
 */

function NavIcon({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={`relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
        active
          ? "bg-white/10 text-sidebar-fg-active"
          : "text-sidebar-fg hover:bg-white/5 hover:text-sidebar-fg-active"
      }`}
    >
      {active ? (
        <span className="absolute -left-2 h-5 w-1 rounded-full bg-accent-deep" />
      ) : null}
      <Icon size={20} strokeWidth={2} />
    </Link>
  );
}

function SpaceBadge({
  href,
  label,
  short,
  active,
  onPrefetch,
}: {
  href: string;
  label: string;
  short: string;
  active: boolean;
  onPrefetch?: () => void;
}) {
  return (
    <Link
      href={href}
      onMouseEnter={onPrefetch}
      title={`공간 전환: ${label}`}
      aria-label={`공간 전환: ${label}`}
      aria-current={active ? "page" : undefined}
      className={`flex h-10 w-10 items-center justify-center rounded-full border text-xs font-semibold transition-colors ${
        active
          ? "border-accent-deep bg-accent text-accent-fg"
          : "border-white/15 text-sidebar-fg hover:border-accent-deep hover:text-sidebar-fg-active"
      }`}
    >
      {short}
    </Link>
  );
}

function initials(name: string | null | undefined, fallback: string) {
  const trimmed = name?.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 1).toUpperCase();
}

export function IconSidebar() {
  const pathname = usePathname();
  const { data: profile } = useProfile();
  const { data: myClasses = [] } = useMyClasses();
  const queryClient = useQueryClient();
  const hasKey = useHasGeminiKey();
  const name = profileName(profile);

  const role = profile?.role ?? null;
  const isStudent = !role || role === "student";

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(href + "/");

  // 08 G: 공간 배지 hover 시 그 공간의 세션 목록을 선반입(공간 전환 즉시 표시).
  const prefetchSpace = (spaceId: string) => {
    const target = spaceTargetFromId(spaceId);
    void queryClient.prefetchQuery({
      queryKey: sessionsKey(target),
      queryFn: () => listSessions(target),
      staleTime: STALE.sessions,
    });
  };

  return (
    <nav
      aria-label="주 메뉴"
      className="flex h-full w-16 shrink-0 flex-col items-center gap-3 bg-bg-sidebar py-3"
    >
      {/* 브랜드 마크 */}
      <Link
        href={roleHome(role)}
        title="nodi"
        aria-label="nodi"
        className="mb-1 flex h-9 w-9 items-center justify-center rounded-full bg-accent font-bold text-accent-fg"
      >
        n
      </Link>

      {/* 학생 전용: 홈 · 공간 · 개념 */}
      {isStudent && (
        <>
          <NavIcon href="/home" label="홈" icon={Home} active={isActive("/home")} />

          <div className="my-1 h-px w-8 bg-white/10" />

          <div className="flex flex-col items-center gap-2 overflow-y-auto">
            <SpaceBadge
              href="/space/personal"
              label="개인 공간"
              short="개인"
              active={isActive("/space/personal")}
              onPrefetch={() => prefetchSpace("personal")}
            />
            {myClasses.map((m) => {
              const href = `/space/${m.class_id}`;
              const label = m.classes?.name ?? "학급";
              return (
                <SpaceBadge
                  key={m.class_id}
                  href={href}
                  label={label}
                  short={initials(m.classes?.name, "반")}
                  active={isActive(href)}
                  onPrefetch={() => prefetchSpace(m.class_id)}
                />
              );
            })}
          </div>

          <div className="my-1 h-px w-8 bg-white/10" />

          <NavIcon
            href="/concepts"
            label="개념 나무"
            icon={TreeDeciduous}
            active={isActive("/concepts")}
          />
        </>
      )}

      {/* 교사 콘솔 */}
      {role === "teacher" ? (
        <NavIcon
          href="/teacher"
          label="교사 콘솔"
          icon={School}
          active={isActive("/teacher")}
        />
      ) : null}

      {/* 관리자 콘솔 */}
      {role === "admin" ? (
        <NavIcon
          href="/admin"
          label="관리자 콘솔"
          icon={Shield}
          active={isActive("/admin")}
        />
      ) : null}

      {/* 프로필·설정 (하단 고정) */}
      <div className="mt-auto flex flex-col items-center gap-1">
        <button
          type="button"
          onClick={() => openGeminiKeyDialog()}
          title={hasKey ? "Gemini API 키 (설정됨)" : "Gemini API 키 (미설정)"}
          aria-label="Gemini API 키"
          className="relative flex h-11 w-11 items-center justify-center rounded-xl text-sidebar-fg transition-colors hover:bg-white/5 hover:text-sidebar-fg-active"
        >
          <KeyRound size={20} strokeWidth={2} />
          <span
            className={`absolute right-2 top-2 h-2 w-2 rounded-full ${
              hasKey ? "bg-positive" : "bg-accent-deep"
            }`}
          />
        </button>
        <NavIcon
          href="/profile"
          label={name ? `프로필·설정 (${name})` : "프로필·설정"}
          icon={Settings}
          active={isActive("/profile")}
        />
        {name ? (
          <span
            title={name}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-[11px] font-semibold text-sidebar-fg-active"
          >
            {initials(name, "나")}
          </span>
        ) : null}
      </div>
    </nav>
  );
}
