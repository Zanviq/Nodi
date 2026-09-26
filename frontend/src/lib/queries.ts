"use client";

import {
  type QueryClient,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import {
  getFileSuggestions,
  getFileTags,
  getHomeSummary,
  getHomeSuggestions,
  getNavigatorDefaults,
  fetchTeacherOverview,
  getSession,
  listClassMaterials,
  listClassStudents,
  listCooccurrence,
  listFileGraphNodes,
  listFiles,
  listSessionFileLinks,
  listSessions,
  listStudentClassSessions,
  listTags,
  listTeacherClasses,
  type SpaceTarget,
} from "@/lib/api";
import type {
  CooccurrenceRow,
  FileGraphNode,
  FileLink,
  FileRow,
  FileSuggestion,
  HomeSuggestions,
  HomeSummary,
  NavigatorDefaults,
  SessionDetail,
  SessionRow,
  TagRow,
  TeacherClass,
  TeacherClassOverview,
  TeacherStudent,
} from "@/lib/types";

const FILE_IN_PROGRESS = new Set(["uploaded", "splitting", "embedding"]);

/**
 * 08 G(D67): staleTime 차등 정책. 전역 기본 60s(providers.tsx) 위에 데이터 변화
 * 빈도에 맞춰 차등화한다 — 자주 안 바뀌는 목록(파일·태그)은 길게, 세션·노드는 중간.
 * 쓰기 작업은 명시 invalidate로 즉시 갱신하므로 길게 잡아도 정합성은 유지된다.
 */
export const STALE = {
  /** 세션 목록: 생성/이름변경/삭제는 invalidate로 즉시 반영. */
  sessions: 30 * 1000,
  /** 세션 상세(노드): 채팅 done 후 invalidate. 재진입 캐시 적중용 중간값. */
  sessionDetail: 30 * 1000,
  /** 파일 목록: 거의 안 바뀜(진행 중이면 폴링이 별도로 갱신). */
  files: 5 * 60 * 1000,
  /** 파일↔노드 링크: 연결 추가/삭제 시 invalidate. */
  fileLinks: 60 * 1000,
  /** 그래프 배치: 드래그/추가/제거 시 invalidate. */
  fileGraphNodes: 30 * 1000,
  /** 개념 태그·동시출현: 느리게 누적. */
  tags: 5 * 60 * 1000,
} as const;

export function sessionsKey(target: SpaceTarget) {
  return ["sessions", target.space_kind, target.space_ref ?? null] as const;
}

// ── 교사 컨트롤 패널 (Stage 4b) ──────────────────────────────────────

export function classMaterialsKey(classId: string | null) {
  return ["teacher", "materials", classId] as const;
}

export function useTeacherClasses() {
  return useQuery<TeacherClass[]>({
    queryKey: ["teacher", "classes"],
    queryFn: listTeacherClasses,
  });
}

/** D67: 교사 콘솔 홈 — 학급 개요(학생수·자료수·최근활동). */
export function useTeacherOverview() {
  return useQuery<TeacherClassOverview[]>({
    queryKey: ["teacher", "overview"],
    queryFn: fetchTeacherOverview,
  });
}

export function useClassStudents(classId: string | null) {
  return useQuery<TeacherStudent[]>({
    queryKey: ["teacher", "students", classId],
    queryFn: () => listClassStudents(classId as string),
    enabled: !!classId,
  });
}

export function useStudentClassSessions(
  classId: string | null,
  userId: string | null,
) {
  return useQuery<SessionRow[]>({
    queryKey: ["teacher", "student-sessions", classId, userId],
    queryFn: () => listStudentClassSessions(classId as string, userId as string),
    enabled: !!classId && !!userId,
  });
}

/** 학급 자료 목록. 임베딩 진행 중이면 2.5초 폴링. */
export function useClassMaterials(classId: string | null) {
  return useQuery<FileRow[]>({
    queryKey: classMaterialsKey(classId),
    queryFn: () => listClassMaterials(classId as string),
    enabled: !!classId,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}

export function sessionKey(sessionId: string | null) {
  return ["session", sessionId] as const;
}

export function tagsKey(target: SpaceTarget) {
  return ["tags", target.space_kind, target.space_ref ?? null] as const;
}

export function filesKey(target: SpaceTarget) {
  return ["files", target.space_kind, target.space_ref ?? null] as const;
}

export function fileLinksKey(sessionId: string | null) {
  return ["file-links", sessionId] as const;
}

export function fileGraphNodesKey(sessionId: string | null) {
  return ["file-graph-nodes", sessionId] as const;
}

export function cooccurrenceKey(target: SpaceTarget) {
  return ["cooccurrence", target.space_kind, target.space_ref ?? null] as const;
}

/** 현재 공간의 세션 목록 (updated_at desc, 백엔드 정렬). */
export function useSessions(target: SpaceTarget) {
  return useQuery<SessionRow[]>({
    queryKey: sessionsKey(target),
    queryFn: () => listSessions(target),
    staleTime: STALE.sessions,
  });
}

/** 선택 세션 상세 ({session, nodes[]}). */
export function useSessionDetail(sessionId: string | null) {
  return useQuery<SessionDetail>({
    queryKey: sessionKey(sessionId),
    queryFn: () => getSession(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.sessionDetail,
  });
}

/** 현재 공간의 파일 목록. 임베딩 진행 중이면 2.5초 폴링, 완료되면 중지. */
export function useFiles(target: SpaceTarget) {
  return useQuery<FileRow[]>({
    queryKey: filesKey(target),
    queryFn: () => listFiles(target),
    staleTime: STALE.files,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((f) => FILE_IN_PROGRESS.has(f.status));
      return active ? 2500 : false;
    },
  });
}

/** 세션의 파일↔노드 링크(시각적 RAG). */
export function useSessionFileLinks(sessionId: string | null) {
  return useQuery<FileLink[]>({
    queryKey: fileLinksKey(sessionId),
    queryFn: () => listSessionFileLinks(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.fileLinks,
  });
}

/**
 * D58: 현재 세션 그래프에 배치된 자료 노드(placement). 그래프 파일노드의 표시 소스.
 * 배치된 파일이 임베딩 진행 중이면 2.5초 폴링(진행률 반영).
 */
export function useFileGraphNodes(sessionId: string | null) {
  return useQuery<FileGraphNode[]>({
    queryKey: fileGraphNodesKey(sessionId),
    queryFn: () => listFileGraphNodes(sessionId as string),
    enabled: !!sessionId,
    staleTime: STALE.fileGraphNodes,
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some(
        (p) => p.files && FILE_IN_PROGRESS.has(p.files.status),
      );
      return active ? 2500 : false;
    },
  });
}

export function fileTagsKey(fileId: string) {
  return ["file-tags", fileId] as const;
}

/** 파일 태그(3b-3). indexed 파일만 조회. */
export function useFileTags(fileId: string, enabled: boolean) {
  return useQuery<string[]>({
    queryKey: fileTagsKey(fileId),
    queryFn: () => getFileTags(fileId),
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

/** 여러 파일의 태그를 한 번에(그래프 파일 노드 툴팁용). fileId → 태그배열 맵. */
export function useFileTagsMap(fileIds: string[]): Record<string, string[]> {
  return useQueries({
    queries: fileIds.map((id) => ({
      queryKey: fileTagsKey(id),
      queryFn: () => getFileTags(id),
      staleTime: 5 * 60 * 1000,
    })),
    combine: (results) => {
      const map: Record<string, string[]> = {};
      fileIds.forEach((id, i) => {
        const data = results[i]?.data;
        if (data && data.length > 0) map[id] = data;
      });
      return map;
    },
  });
}

/** 현재 분기 미연결 시 파일 제안(3b-3). */
export function useFileSuggestions(
  sessionId: string | null,
  nodeId: string | null,
  enabled: boolean,
) {
  return useQuery<FileSuggestion[]>({
    queryKey: ["file-suggestions", sessionId, nodeId],
    queryFn: () => getFileSuggestions(sessionId as string, nodeId as string),
    enabled: enabled && !!sessionId && !!nodeId,
    staleTime: 60 * 1000,
  });
}

/** 현재 공간의 개념 태그 (usage_count desc). */
export function useTags(target: SpaceTarget) {
  return useQuery<TagRow[]>({
    queryKey: tagsKey(target),
    queryFn: () => listTags(target),
    staleTime: STALE.tags,
  });
}

/** 현재 공간의 태그 co-occurrence (count desc). */
export function useCooccurrence(target: SpaceTarget) {
  return useQuery<CooccurrenceRow[]>({
    queryKey: cooccurrenceKey(target),
    queryFn: () => listCooccurrence(target),
    staleTime: STALE.tags,
  });
}

/**
 * 08 G(D67): 세션 진입 직전 선반입. 세션 hover/클릭 시 그 세션의 상세(노드)·파일링크·
 * 그래프배치를 미리 받아 화면 도착 시 이미 채워지게 한다(cold 워터폴 제거).
 * 임시(낙관) id는 호출하지 않는다(호출부에서 isRealId 가드).
 */
export function prefetchSessionData(qc: QueryClient, sessionId: string) {
  void qc.prefetchQuery({
    queryKey: sessionKey(sessionId),
    queryFn: () => getSession(sessionId),
    staleTime: STALE.sessionDetail,
  });
  void qc.prefetchQuery({
    queryKey: fileLinksKey(sessionId),
    queryFn: () => listSessionFileLinks(sessionId),
    staleTime: STALE.fileLinks,
  });
  void qc.prefetchQuery({
    queryKey: fileGraphNodesKey(sessionId),
    queryFn: () => listFileGraphNodes(sessionId),
    staleTime: STALE.fileGraphNodes,
  });
}

/** 홈 요약(공간/최근 세션/상위 개념). */
export function useHomeSummary() {
  return useQuery<HomeSummary>({
    queryKey: ["home", "summary"],
    queryFn: () => getHomeSummary(),
  });
}

/**
 * 홈 질문 추천(3개). Gemini 키가 필요한 AI 호출이라 키가 있을 때만 요청한다.
 * 키 유무(불리언, 키 값 자체는 아님)를 queryKey에 넣어 키 입력 직후 다시 불러온다.
 * 키 오류(400/429 등)는 재시도하지 않는다.
 */
export function useHomeSuggestions(hasKey: boolean) {
  return useQuery<HomeSuggestions>({
    queryKey: ["home", "suggestions", hasKey],
    queryFn: () => getHomeSuggestions(),
    enabled: hasKey,
    retry: false,
  });
}

/** D55b: 네비게이터 유효 기본값(추천 개수·생성 시점·주기). 거의 안 변하므로 staleTime 길게. */
export function useNavigatorDefaults() {
  return useQuery<NavigatorDefaults>({
    queryKey: ["navigator-defaults"],
    queryFn: () => getNavigatorDefaults(),
    staleTime: 10 * 60 * 1000,
  });
}
