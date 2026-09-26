// 도메인 타입 (Stage 0 — 인증/공간/프로필 범위)

export interface Profile {
  id: string;
  /** 로그인 아이디(아이디+비밀번호 인증). */
  username?: string | null;
  /** 항상 null(이메일 미사용) — 하위 호환용. */
  email: string | null;
  role: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** D18: 온보딩 1회 완료 플래그. */
  onboarded?: boolean | null;
}

export interface ClassRow {
  id: string;
  name: string | null;
  join_code: string | null;
}

/** class_members ↔ classes 임베드 조회 결과 */
export interface MyClass {
  class_id: string;
  role_in_class: string | null;
  created_at?: string;
  classes: ClassRow | null;
}

// ── Stage 4b: 교사 컨트롤 패널 ────────────────────────────────────────

export interface TeacherClass {
  id: string;
  name: string | null;
  join_code: string | null;
  created_at: string;
  student_count: number;
}

/** D67: 교사 콘솔 홈 학급 개요(한 행 = 한 학급, 카운트·최근활동 포함). */
export interface TeacherClassOverview {
  id: string;
  name: string | null;
  join_code: string | null;
  created_at: string;
  student_count: number;
  material_count: number;
  last_activity_at: string | null;
}

export interface TeacherStudent {
  user_id: string;
  username?: string | null;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  role_in_class: string | null;
  joined_at: string;
}

// ── Stage 1: 트리 대화 (백엔드 FastAPI 계약) ──────────────────────────

export type SpaceKind = "personal" | "class";

export interface SessionRow {
  id: string;
  owner_id?: string;
  space_kind?: SpaceKind;
  space_ref?: string | null;
  title: string | null;
  emoji?: string | null;
  root_node_id: string | null;
  current_head_id: string | null;
  created_at?: string;
  updated_at?: string;
  /** 08 F: 낙관(미확정) 세션 행 — "새 대화" 클릭 즉시 표시, 서버 확정 전. */
  _pending?: boolean;
}

export interface NodeRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  question: string;
  answer: string;
  label: string | null;
  is_navigator: boolean;
  navigator_question: string | null;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
  /** Stage 2: 해당 턴의 태그 이름들. 새로 만든 노드는 done.node.tags로 즉시 채움. */
  tags?: string[] | null;
  /** Stage 3a: 이 노드가 가져온 source 노드 id들(기억 연결). */
  connections?: string[] | null;
  /** D32: 이 답변이 RAG로 참고한 자료 출처들(없으면 빈 배열/누락). */
  rag_sources?: RagSource[] | null;
  /**
   * D36: 클라이언트 전용 임시(provisional) 노드 플래그(백엔드 미존재).
   * 전송 즉시 부모 아래에 반투명·점선으로 띄우고, done 시 실노드로 교체.
   */
  _provisional?: boolean;
  /** D40: 네비게이터 노드의 근거(클릭 팝업 "이 질문으로 얻을 수 있는 내용"). 구노드엔 없음. */
  navigator_meta?: NavigatorMeta | null;
  /** D46: 이 답변이 이번 턴에 참조한 브랜치 출처들(구노드엔 없음). */
  reference_sources?: ReferenceSource[] | null;
}

/** D40: 네비게이터 근거 메타. */
export interface NavigatorMeta {
  rationale?: string | null;
}

/** D46: 답변 노드의 참조 출처(비교참조 브랜치). */
export interface ReferenceSource {
  kind: "comparison" | string;
  label: string;
  node_ids: string[];
  leaf_id: string;
  session_id: string;
}

/** D32: RAG 답변의 출처 청크 메타. */
export interface RagSource {
  file_id: string;
  name: string | null;
  seq: number | null;
  /** 페이지 메타가 있으면(없을 수 있음). */
  page?: number | null;
  distance: number | null;
  snippet: string | null;
  /** D41: 청크 식별자(있을 때만 ⋯ 상세 패널 제공). 구노드엔 없음. */
  chunk_id?: string | null;
}

/** D41: GET /files/chunks/{chunk_id}/context 응답(청크 전문 + 인접 청크). */
export interface ChunkContext {
  file_id: string;
  name: string | null;
  seq: number | null;
  page: number | null;
  chunk_text: string;
  prev_text: string | null;
  next_text: string | null;
}

/** Stage 3a: 연결 add/remove 응답(갱신된 connections 배열). */
export interface ConnectionResponse {
  node_id: string;
  connections: string[];
}

export interface SessionDetail {
  session: SessionRow;
  nodes: NodeRow[];
}

// ── Stage 2: 개념 태그 ────────────────────────────────────────────────

export interface TagRow {
  id: string;
  name: string;
  usage_count: number;
  space_kind: SpaceKind;
  space_ref: string | null;
  created_at: string;
}

export interface CooccurrenceRow {
  tag_a: string;
  tag_b: string;
  name_a: string;
  name_b: string;
  count: number;
}

// ── /chat/stream SSE 이벤트 ──────────────────────────────────────────

export interface ChatStartEvent {
  session_id: string;
  parent_node_id: string | null;
}

export interface ChatDoneEvent {
  node: {
    id: string;
    parent_id: string | null;
    label: string | null;
    tags?: string[] | null;
    /** D57: 이번 턴 비교참조 출처(있으면). 리페치 전에도 참조 칩 즉시 표시. */
    reference_sources?: ReferenceSource[] | null;
    /** D57-보강: 네비게이터 근거(해당되면). */
    navigator_meta?: NavigatorMeta | null;
  };
  current_head_id: string | null;
  root_node_id: string | null;
}

/** Stage 2: done 다음, 네비게이터 게이트 발동 턴에서만 옴. */
export interface ChatNavigatorEvent {
  nodes: Array<{
    id: string;
    parent_id: string | null;
    navigator_question: string;
    /** D40: 생성 시점에 함께 저장된 근거(클릭 팝업용). */
    navigator_meta?: NavigatorMeta | null;
  }>;
}

// ── Stage 4a: 홈 + 총괄 AI(overseer) ─────────────────────────────────

export interface HomeSpace {
  space_kind: SpaceKind;
  space_ref: string | null;
  name: string | null;
  role_in_class: string | null;
}

export interface HomeRecentSession {
  id: string;
  title: string | null;
  emoji: string | null;
  space_kind: SpaceKind;
  space_ref: string | null;
  updated_at: string;
}

export interface HomeConcept {
  id: string;
  name: string;
  usage_count: number;
}

export interface HomeSummary {
  spaces: HomeSpace[];
  recent_sessions: HomeRecentSession[];
  top_concepts: HomeConcept[];
}

export interface HomeSuggestion {
  question: string;
  seed_question: string;
  space_kind: "personal";
  space_ref: string | null;
}

export interface HomeSuggestions {
  suggestions: HomeSuggestion[];
}

/** 총괄 AI done 액션. */
export type OverseerAction =
  | {
      action: "create_session";
      label: string;
      space_kind: SpaceKind;
      space_ref: string | null;
      seed_question: string;
    }
  | { action: "open_session"; label: string; session_id: string };

export interface OverseerDoneEvent {
  actions: OverseerAction[];
}

// ── Stage 3b: 파일 / RAG ─────────────────────────────────────────────

export type FileStatus =
  | "uploaded"
  | "splitting"
  | "embedding"
  | "indexed"
  | "partial"
  | "failed"
  /** 저장(가능하면 분할)됐지만 Gemini 키가 없어 임베딩 대기 — 비진행(terminal) 상태. */
  | "needs_key";

export interface FileRow {
  id: string;
  kind?: string | null;
  name?: string | null;
  filename?: string | null;
  storage_path?: string | null;
  mime?: string | null;
  size_bytes: number | null;
  status: FileStatus;
  chunk_total: number | null;
  chunk_done: number | null;
  error?: string | null;
  created_at: string;
  /** Wave A(D13/D20): 그래프 표시용 세션 연관 + 좌표 영속. */
  session_id?: string | null;
  position_x?: number | null;
  position_y?: number | null;
  /** 08 F: 낙관 배치(placement) 미확정 — 캔버스가 파일 노드를 반투명 pending으로 렌더. */
  _pending?: boolean;
}

/** 시각적 RAG: 파일↔노드 링크 (GET /sessions/{id}/file-links). */
export interface FileLink {
  id: string;
  file_id: string;
  target_node_id: string;
  created_at: string;
  /** D31: 낙관적 삽입 중인 임시 링크(서버 확정 전). 캔버스에서 흐리게 렌더. */
  _pending?: boolean;
  files: {
    id: string;
    storage_path: string | null;
    mime: string | null;
    status: FileStatus;
    chunk_total: number | null;
    chunk_done: number | null;
    session_id?: string | null;
    position_x?: number | null;
    position_y?: number | null;
  } | null;
}

/** Stage 3b-3: 미연결 분기 파일 제안. */
export interface FileSuggestion {
  file_id: string;
  distance: number;
  sample: string | null;
  kind: string | null;
}

/**
 * D58: 자료 그래프 배치(placement). 파일(공간 소유)을 특정 세션 그래프에 자유 노드로
 * 둔 행. 표시(좌표)는 이 행이 결정하고, RAG 연결(file_node_links)과는 독립이다.
 */
export interface FileGraphNode {
  id: string;
  file_id: string;
  session_id: string;
  position_x: number | null;
  position_y: number | null;
  created_at: string;
  /** D58 낙관적 삽입 중인 임시 placement(서버 확정 전). */
  _provisional?: boolean;
  files: {
    id: string;
    storage_path: string | null;
    mime: string | null;
    kind?: string | null;
    status: FileStatus;
    chunk_total: number | null;
    chunk_done: number | null;
    space_kind?: string | null;
    space_ref?: string | null;
  } | null;
}

/** D55b: 네비게이터 유효 기본값(config ⊕ admin override 합성, 서버가 숫자로 반환). */
export interface NavigatorDefaults {
  question_count: number;
  gate_k: number;
  period: number;
}

// ── Stage 4c: 관리자 ─────────────────────────────────────────────────

export type UserRole = "student" | "teacher" | "admin";

export interface AdminUser {
  id: string;
  username?: string | null;
  email: string | null;
  role: UserRole | string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
}

export interface AdminSetting {
  key: string;
  value: unknown;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AdminUsageUser {
  owner_id: string;
  email: string | null;
  username?: string | null;
  display_name?: string | null;
  total_tokens: number;
  step_count: number;
}

export interface AdminUsage {
  partial: boolean;
  note: string;
  by_user: AdminUsageUser[];
}

// ── D34/D35: 턴 상세 + 구조화 contexts ───────────────────────────────

/** D35: 시스템 프롬프트에 들어간 컨텍스트 블록. */
export type LogBlockKind =
  | "system_base"
  | "memory_link"
  | "rag"
  | "comparison"
  | string;

export interface LogContextBlock {
  kind: LogBlockKind;
  order: number;
  source?: string | null;
  raw_text?: string | null;
  node_ids?: string[] | null;
  /** rag 블록의 출처(D32와 동일 형). */
  sources?: RagSource[] | null;
  /** system_prompt 문자열 내 [start, end) char 오프셋. */
  prompt_span?: [number, number] | null;
}

/**
 * D35: ai_logs.contexts 구조화형.
 * 신버전 = { history, blocks[] }. 구버전(boolean 플래그)은 blocks 누락 → 폴백 렌더.
 */
export interface LogContexts {
  history?: { turns: number; chars: number } | null;
  blocks?: LogContextBlock[] | null;
  /** 구버전 boolean 플래그(current_branch/memory_link/rag/comparison 등) 폴백용. */
  [key: string]: unknown;
}

/** D25: 채팅 턴 단위 로그(ai_logs 1행 = 1턴). */
export interface AdminLog {
  id: string;
  owner_id: string;
  session_id: string | null;
  node_id: string | null;
  kind: string | null;
  system_prompt: string | null;
  question: string | null;
  answer: string | null;
  contexts: LogContexts | null;
  skill_calls: unknown[] | null;
  errors: unknown[] | null;
  token_estimate: number | null;
  created_at: string;
}

export interface AdminLogsResponse {
  limit: number;
  offset: number;
  logs: AdminLog[];
}

/** D34: ReAct 트레이스 스텝(ai_steps). */
export interface AdminTraceStep {
  seq: number;
  thought: string | null;
  skill: string | null;
  input: unknown;
  observation: unknown;
  tokens: number | null;
  created_at: string;
}

/** D34: ReAct 트레이스(ai_sessions + 임베드된 ai_steps). */
export interface AdminTrace {
  id: string;
  owner_id: string;
  session_id: string | null;
  kind: string | null;
  created_at: string;
  ai_steps: AdminTraceStep[] | null;
}

/** D34: GET /admin/logs/{id} 응답(턴 본체 + 같은 세션 트레이스 묶음). */
export interface AdminLogDetail {
  log: AdminLog;
  traces: AdminTrace[];
}

/** D34: GET /admin/traces 응답. */
export interface AdminTracesResponse {
  limit: number;
  offset: number;
  sessions: AdminTrace[];
}

/** D33: POST /teacher/classes 생성 응답(student_count 없음). */
export interface CreatedClass {
  id: string;
  name: string | null;
  join_code: string | null;
  teacher_id?: string | null;
  created_at: string;
}
