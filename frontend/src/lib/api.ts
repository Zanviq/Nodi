import { readGeminiKey } from "@/lib/geminiKey";
import { assertRealId, isRealId } from "@/lib/ids";
import type {
  AdminLogDetail,
  AdminLogsResponse,
  AdminSetting,
  AdminTracesResponse,
  AdminUsage,
  AdminUser,
  ChatDoneEvent,
  ChatNavigatorEvent,
  ChatStartEvent,
  ChunkContext,
  ConnectionResponse,
  CooccurrenceRow,
  CreatedClass,
  FileGraphNode,
  FileLink,
  FileRow,
  FileSuggestion,
  HomeSuggestions,
  HomeSummary,
  MyClass,
  NavigatorDefaults,
  OverseerDoneEvent,
  Profile,
  SessionDetail,
  SessionRow,
  SpaceKind,
  TagRow,
  TeacherClass,
  TeacherClassOverview,
  TeacherStudent,
  UserRole,
} from "@/lib/types";

/**
 * 백엔드는 같은 오리진의 `/api/*`로 호출한다(next.config.ts rewrite → BACKEND_URL).
 * 세션은 httpOnly 쿠키(nodi_session)라 JS가 토큰을 다루지 않는다 — 토큰 캐시 없음.
 */
const API_BASE = "/api";

/**
 * 공통 요청 헤더.
 * - json: Content-Type 지정.
 * - ai: AI를 쓰는 엔드포인트에만 사용자 본인의 Gemini 키를 X-Gemini-Key로 싣는다
 *   (localStorage에서 매번 직접 읽음 — 메모리 캐시 없음, URL/로그에 절대 넣지 않음).
 */
function authHeaders(json = false, ai = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers["Content-Type"] = "application/json";
  if (ai) {
    const key = readGeminiKey();
    if (key) headers["X-Gemini-Key"] = key;
  }
  return headers;
}

/** 모든 요청 공통 fetch 옵션(쿠키 동봉). */
function req(init: RequestInit = {}): RequestInit {
  return { credentials: "include", ...init };
}

/** HTTP 상태 코드 + (있으면) 기계용 오류 코드를 보존하는 에러. */
export class ApiError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** FastAPI 오류 바디 → {message, code}. detail은 문자열 | {code,message} | 검증오류 배열. */
function parseErrorBody(
  body: unknown,
  status: number,
): { message: string; code: string | null } {
  const detail = (body as { detail?: unknown } | null)?.detail;
  if (typeof detail === "string") return { message: detail, code: null };
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const d = detail as { code?: unknown; message?: unknown };
    return {
      message:
        typeof d.message === "string" ? d.message : `요청 실패 (HTTP ${status})`,
      code: typeof d.code === "string" ? d.code : null,
    };
  }
  if (Array.isArray(detail)) {
    return { message: "입력값을 확인해 주세요.", code: "validation_error" };
  }
  return { message: `요청 실패 (HTTP ${status})`, code: null };
}

let redirectingToLogin = false;

/**
 * 세션 만료/미로그인(401): 쿠키를 지우고(/auth/logout) 로그인 화면으로 보낸다.
 * 쿠키를 먼저 지워야 Proxy(쿠키 존재 검사)와 서로 튕기는 루프가 생기지 않는다.
 * 로그인 화면 자체에서는 아무것도 하지 않는다.
 */
function handleUnauthorized(): void {
  if (typeof window === "undefined" || redirectingToLogin) return;
  if (window.location.pathname.startsWith("/login")) return;
  redirectingToLogin = true;
  void fetch(`${API_BASE}/auth/logout`, req({ method: "POST" }))
    .catch(() => undefined)
    .finally(() => {
      window.location.assign("/login");
    });
}

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) {
    let parsed = { message: `요청 실패 (HTTP ${res.status})`, code: null as string | null };
    try {
      parsed = parseErrorBody(await res.json(), res.status);
    } catch {
      /* ignore */
    }
    if (res.status === 401) handleUnauthorized();
    throw new ApiError(res.status, parsed.message, parsed.code);
  }
  return res;
}

// ── 인증 (아이디 + 비밀번호, httpOnly 쿠키 세션) ────────────────────────

/** 로그인. 401 invalid_credentials는 리다이렉트 없이 ApiError로 던진다. */
export async function login(username: string, password: string): Promise<Profile> {
  const res = await fetch(
    `${API_BASE}/auth/login`,
    req({
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ username, password }),
    }),
  );
  if (!res.ok) {
    let parsed = { message: "로그인에 실패했습니다.", code: null as string | null };
    try {
      parsed = parseErrorBody(await res.json(), res.status);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, parsed.message, parsed.code);
  }
  return res.json();
}

/** 회원가입(성공 시 자동 로그인 쿠키). 409 username_taken 등은 ApiError. */
export async function register(input: {
  username: string;
  password: string;
  display_name?: string;
}): Promise<Profile> {
  const res = await fetch(
    `${API_BASE}/auth/register`,
    req({
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify(input),
    }),
  );
  if (!res.ok) {
    let parsed = { message: "가입에 실패했습니다.", code: null as string | null };
    try {
      parsed = parseErrorBody(await res.json(), res.status);
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, parsed.message, parsed.code);
  }
  return res.json();
}

/** 로그아웃(쿠키 삭제). 실패해도 호출부는 로그인 화면으로 이동한다. */
export async function logout(): Promise<void> {
  try {
    await fetch(`${API_BASE}/auth/logout`, req({ method: "POST" }));
  } catch {
    /* ignore */
  }
}

/** 현재 사용자. 401(미로그인)이면 null. */
export async function getMe(): Promise<Profile | null> {
  try {
    const res = await ensureOk(await fetch(`${API_BASE}/auth/me`, req()));
    return res.json();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null;
    throw e;
  }
}

/** 표시 이름 변경(1–50자). */
export async function updateMe(displayName: string): Promise<Profile> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/auth/me`,
      req({
        method: "PATCH",
        headers: authHeaders(true),
        body: JSON.stringify({ display_name: displayName }),
      }),
    ),
  );
  return res.json();
}

/** 내가 가입한 학급 목록. */
export async function listMyClasses(): Promise<MyClass[]> {
  const res = await ensureOk(await fetch(`${API_BASE}/auth/me/classes`, req()));
  return res.json();
}

/** 학급 코드로 가입(멱등). 잘못된 코드는 404 invalid_join_code. */
export async function joinClassByCode(code: string): Promise<MyClass> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/auth/me/classes/join`,
      req({
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ code }),
      }),
    ),
  );
  return res.json();
}

export interface SpaceTarget {
  space_kind: SpaceKind;
  space_ref?: string | null;
}

/** 라우트의 spaceId → 백엔드 공간 매핑. 'personal' | <class uuid> */
export function spaceTargetFromId(spaceId: string): SpaceTarget {
  if (spaceId === "personal") return { space_kind: "personal" };
  return { space_kind: "class", space_ref: spaceId };
}

export async function listSessions(target: SpaceTarget): Promise<SessionRow[]> {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions?${params.toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

export async function createSession(
  target: SpaceTarget,
  title?: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({
        space_kind: target.space_kind,
        space_ref: target.space_ref ?? undefined,
        title,
      }),
    }),
  );
  return res.json();
}

/** 세션 이름 변경(D17). */
export async function patchSession(
  id: string,
  title: string,
): Promise<SessionRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "PATCH",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ title }),
    }),
  );
  return res.json();
}

/** 세션 삭제(D17). 204. */
export async function deleteSession(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

/** D55b: 네비게이터 유효 기본값(config ⊕ admin override 합성). 비-admin도 읽기 가능. */
export async function getNavigatorDefaults(): Promise<NavigatorDefaults> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/auth/me/navigator-defaults`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

/** 온보딩 1회 완료 표시(D18). */
export async function completeOnboarding(): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/auth/complete-onboarding`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

export async function getSession(id: string): Promise<SessionDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${id}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

// ── 개념 태그 (Stage 2) ──────────────────────────────────────────────

function spaceParams(target: SpaceTarget): URLSearchParams {
  const params = new URLSearchParams({ space_kind: target.space_kind });
  if (target.space_ref) params.set("space_ref", target.space_ref);
  return params;
}

export async function listTags(target: SpaceTarget): Promise<TagRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/tags?${spaceParams(target).toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

export async function listCooccurrence(
  target: SpaceTarget,
): Promise<CooccurrenceRow[]> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/tags/cooccurrence?${spaceParams(target).toString()}`,
      { credentials: "include", headers: authHeaders() },
    ),
  );
  return res.json();
}

/** 네비게이터(is_navigator) 노드 삭제. 204 반환. */
export async function deleteNode(id: string): Promise<void> {
  assertRealId(id, "node_id"); // D63: 임시 노드 id는 DB 경계로 못 보냄
  await ensureOk(
    await fetch(`${API_BASE}/nodes/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

// ── 파일 / RAG (Stage 3b) ────────────────────────────────────────────

/**
 * 멀티파트 업로드(서버가 즉시 처리해 최종 행 반환). 키가 없으면 저장·분할만 되고
 * status=needs_key. (Content-Type 미지정 — FormData가 boundary 설정)
 */
export async function uploadFile(
  target: SpaceTarget,
  file: File,
  opts?: {
    sessionId?: string | null;
    positionX?: number;
    positionY?: number;
    kind?: string;
  },
): Promise<FileRow> {
  const form = new FormData();
  form.append("file", file);
  form.append("space_kind", target.space_kind);
  if (target.space_ref) form.append("space_ref", target.space_ref);
  if (opts?.kind) form.append("kind", opts.kind);
  if (opts?.sessionId) form.append("session_id", opts.sessionId);
  if (opts?.positionX != null) form.append("position_x", String(Math.round(opts.positionX)));
  if (opts?.positionY != null) form.append("position_y", String(Math.round(opts.positionY)));
  const res = await ensureOk(
    await fetch(`${API_BASE}/files`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(false, true), // json=false → Content-Type 없음, AI 키 선택
      body: form,
    }),
  );
  return res.json();
}

/** 파일 노드 좌표 영속(D20). */
export async function patchFilePosition(
  fileId: string,
  x: number,
  y: number,
): Promise<FileRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/position`, {
      method: "PATCH",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({
        position_x: Math.round(x),
        position_y: Math.round(y),
      }),
    }),
  );
  return res.json();
}

export async function listFiles(target: SpaceTarget): Promise<FileRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files?${spaceParams(target).toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

// ── 교사 컨트롤 패널 (Stage 4b, teacher role만) ──────────────────────

export async function listTeacherClasses(): Promise<TeacherClass[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes`, { credentials: "include", headers: authHeaders() }),
  );
  return res.json();
}

/** D67: 교사 콘솔 홈 — 학급별 학생수·자료수·최근활동(last_activity_at desc nulls last). */
export async function fetchTeacherOverview(): Promise<TeacherClassOverview[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/overview`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

/** D33: 교사가 학급 생성. 성공 시 새 학급 row(id·name·join_code 등). */
export async function createClass(name: string): Promise<CreatedClass> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ name }),
    }),
  );
  return res.json();
}

export async function listClassStudents(
  classId: string,
): Promise<TeacherStudent[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/students`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

export async function listStudentClassSessions(
  classId: string,
  userId: string,
): Promise<SessionRow[]> {
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/teacher/classes/${classId}/students/${userId}/sessions`,
      { credentials: "include", headers: authHeaders() },
    ),
  );
  return res.json();
}

export async function listClassMaterials(classId: string): Promise<FileRow[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/teacher/classes/${classId}/materials`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

export async function getFile(id: string): Promise<FileRow> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, { credentials: "include", headers: authHeaders() }),
  );
  return res.json();
}

/** 파일 태그 목록(3b-3). indexed 파일이면 이름 배열. */
export async function getFileTags(id: string): Promise<string[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}/tags`, { credentials: "include", headers: authHeaders() }),
  );
  const body = await res.json();
  return (body?.tags as string[]) ?? [];
}

/** 파일 삭제(3b-3). 204. */
export async function deleteFile(id: string): Promise<void> {
  await ensureOk(
    await fetch(`${API_BASE}/files/${id}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

/** 파일 재처리(3b-3). failed/partial/needs_key 파일. Gemini 키 필요(없으면 400). */
export async function retryFile(
  id: string,
): Promise<{ file_id: string; action: string; file: FileRow }> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${id}/retry`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(false, true),
    }),
  );
  return res.json();
}

/** 현재 분기에 연결 파일이 없을 때 제안(3b-3). */
export async function getFileSuggestions(
  sessionId: string,
  nodeId: string,
): Promise<FileSuggestion[]> {
  const params = new URLSearchParams({ node_id: nodeId });
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/sessions/${sessionId}/file-suggestions?${params.toString()}`,
      { credentials: "include", headers: authHeaders(false, true) },
    ),
  );
  const body = await res.json();
  return (body?.suggestions as FileSuggestion[]) ?? [];
}

/** 파일을 분기(노드)에 연결 = "이 자료 보고 답해줘"(시각적 RAG, 멱등). */
export async function addFileLink(
  fileId: string,
  targetNodeId: string,
): Promise<unknown> {
  assertRealId(fileId, "file_id"); // D63
  assertRealId(targetNodeId, "target_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/links`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ target_node_id: targetNodeId }),
    }),
  );
  return res.json().catch(() => null);
}

export async function removeFileLink(
  fileId: string,
  nodeId: string,
): Promise<void> {
  assertRealId(fileId, "file_id"); // D63
  assertRealId(nodeId, "node_id");
  await ensureOk(
    await fetch(`${API_BASE}/files/${fileId}/links/${nodeId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

/**
 * D41: RAG 출처 청크의 전문 + 인접 청크(prev/next) + 위치를 조회.
 * 접근 불가/없음이면 404 → ApiError(404).
 */
export async function getChunkContext(
  chunkId: string,
  neighbors = 1,
): Promise<ChunkContext> {
  const params = new URLSearchParams({ neighbors: String(neighbors) });
  const res = await ensureOk(
    await fetch(
      `${API_BASE}/files/chunks/${encodeURIComponent(chunkId)}/context?${params.toString()}`,
      { credentials: "include", headers: authHeaders() },
    ),
  );
  return res.json();
}

export async function listSessionFileLinks(
  sessionId: string,
): Promise<FileLink[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-links`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

// ── D58/D59: 자료 그래프 배치(placement) ─────────────────────────────
// 표시 소스. files.session_id 필터를 대체한다(owner-only, user-JWT).

/** 현재 세션 그래프에 배치된 자료 노드 목록(files 메타 조인). */
export async function listFileGraphNodes(
  sessionId: string,
): Promise<FileGraphNode[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

/** 자료를 그래프에 배치(POST). file_id+session_id 멱등 upsert. 좌표 null이면 서버 기본. */
export async function addFileGraphNode(
  sessionId: string,
  fileId: string,
  x: number | null,
  y: number | null,
): Promise<FileGraphNode> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({
        file_id: fileId,
        position_x: x == null ? null : Math.round(x),
        position_y: y == null ? null : Math.round(y),
      }),
    }),
  );
  return res.json();
}

/** 배치 좌표 갱신(PATCH, 드래그 이동). */
export async function patchFileGraphNode(
  sessionId: string,
  fileId: string,
  x: number,
  y: number,
): Promise<FileGraphNode> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes`, {
      method: "PATCH",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({
        file_id: fileId,
        position_x: Math.round(x),
        position_y: Math.round(y),
      }),
    }),
  );
  return res.json();
}

/** 그래프에서 자료 제거(DELETE). 파일·RAG링크는 유지. */
export async function removeFileGraphNode(
  sessionId: string,
  fileId: string,
): Promise<void> {
  assertRealId(sessionId, "session_id"); // D63
  assertRealId(fileId, "file_id");
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/file-graph-nodes/${fileId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
}

// ── 노드 기억 연결 (Stage 3a) ────────────────────────────────────────

/** target 노드에 source 노드를 기억 연결로 추가. */
export async function addConnection(
  targetId: string,
  sourceId: string,
): Promise<ConnectionResponse> {
  assertRealId(targetId, "target_node_id"); // D63
  assertRealId(sourceId, "source_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/nodes/${targetId}/connections`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ source_node_id: sourceId }),
    }),
  );
  return res.json();
}

/** target 노드에서 source 기억 연결을 해제. */
export async function removeConnection(
  targetId: string,
  sourceId: string,
): Promise<ConnectionResponse> {
  assertRealId(targetId, "target_node_id"); // D63
  assertRealId(sourceId, "source_node_id");
  const res = await ensureOk(
    await fetch(`${API_BASE}/nodes/${targetId}/connections/${sourceId}`, {
      method: "DELETE",
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

// ── SSE 스트리밍 채팅 ────────────────────────────────────────────────
// POST 본문 + X-Gemini-Key 헤더가 필요해 EventSource 대신 fetch + ReadableStream 파싱.

export interface ChatNavigatorOverride {
  enabled?: boolean;
  count?: number;
  gate_k?: number;
  period?: number;
}

export interface ChatStreamBody {
  session_id: string;
  question: string;
  parent_node_id?: string | null;
  /** Wave A(D15): 브랜치 참조 — 이 턴만 참조할 노드들(일회성, 비영속). */
  reference_node_ids?: string[];
  /** D47: 네비게이터 자동생성 per-request override(서버가 안전범위로 clamp). */
  navigator?: ChatNavigatorOverride | null;
}

/**
 * 노드 좌표 일괄 영속(D20). 드래그 종료/재정렬 시 저장.
 * `PUT /sessions/{id}/node-positions` — 서버가 한 번의 bulk 문으로 갱신한다.
 *
 * D52/D63: 영속 직전 비-UUID id(provisional:/optimistic: 등)를 isRealId로 1차 필터한다
 * (서버도 비-UUID를 건너뛰지만 이중 방어). 남은 게 없으면 호출 자체를 생략.
 */
export async function putNodePositions(
  sessionId: string,
  positions: { node_id: string; x: number; y: number }[],
): Promise<void> {
  if (!isRealId(sessionId)) return;
  const valid = positions.filter((p) => isRealId(p.node_id));
  if (valid.length === 0) return;
  await ensureOk(
    await fetch(`${API_BASE}/sessions/${sessionId}/node-positions`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({
        positions: valid.map((p) => ({
          node_id: p.node_id,
          x: Math.round(p.x),
          y: Math.round(p.y),
        })),
      }),
    }),
  );
}

export interface ChatStreamHandlers {
  onStart?: (data: ChatStartEvent) => void;
  onToken?: (delta: string) => void;
  onDone?: (data: ChatDoneEvent) => void;
  onNavigator?: (data: ChatNavigatorEvent) => void;
  /** code: gemini_key_required / gemini_key_invalid / gemini_quota_exceeded 등(없으면 null). */
  onError?: (detail: string, code: string | null) => void;
}

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
}

function parseFrame(frame: string): SSEEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return null; // non-JSON keepalive
  }
  const type = eventName !== "message" ? eventName : (data.type as string);
  if (!type) return null;
  return { type, data };
}

/** SSE error 이벤트 → [표시 문구, 코드]. */
function sseError(data: Record<string, unknown>): [string, string | null] {
  const detail = typeof data.detail === "string" ? data.detail : "스트리밍 오류";
  const code = typeof data.code === "string" ? data.code : null;
  return [detail, code];
}

/** 공통 SSE 소비기: POST 후 ReadableStream을 프레임 단위로 onEvent에 전달. */
async function consumeSSE(
  path: string,
  body: unknown,
  onEvent: (ev: SSEEvent) => void,
  onError: (detail: string, code: string | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true, true),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    onError("서버에 연결할 수 없습니다.", null);
    return;
  }

  if (!res.ok || !res.body) {
    let parsed = { message: `요청 실패 (HTTP ${res.status})`, code: null as string | null };
    try {
      parsed = parseErrorBody(await res.json(), res.status);
    } catch {
      /* ignore */
    }
    if (res.status === 401) handleUnauthorized();
    onError(parsed.message, parsed.code);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep).replace(/\r/g, "");
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) {
          const ev = parseFrame(frame);
          if (ev) onEvent(ev);
        }
      }
    }
    if (buffer.trim()) {
      const ev = parseFrame(buffer.replace(/\r/g, ""));
      if (ev) onEvent(ev);
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") {
      onError("스트리밍이 중단되었습니다.", null);
    }
  }
}

export async function streamChat(
  body: ChatStreamBody,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await consumeSSE(
    "/chat/stream",
    body,
    (ev) => {
      switch (ev.type) {
        case "start":
          handlers.onStart?.(ev.data as unknown as ChatStartEvent);
          break;
        case "token":
          handlers.onToken?.((ev.data.delta as string) ?? "");
          break;
        case "done":
          handlers.onDone?.(ev.data as unknown as ChatDoneEvent);
          break;
        case "navigator":
          handlers.onNavigator?.(ev.data as unknown as ChatNavigatorEvent);
          break;
        case "error":
          handlers.onError?.(...sseError(ev.data));
          break;
      }
    },
    (d, c) => handlers.onError?.(d, c),
    signal,
  );
}

// ── 홈 + 총괄 AI (Stage 4a) ──────────────────────────────────────────

export async function getHomeSummary(
  recentLimit = 8,
  conceptLimit = 8,
): Promise<HomeSummary> {
  const params = new URLSearchParams({
    recent_limit: String(recentLimit),
    concept_limit: String(conceptLimit),
  });
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/summary?${params.toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

export async function getHomeSuggestions(count = 3): Promise<HomeSuggestions> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/home/suggestions?count=${count}`, {
      credentials: "include",
      headers: authHeaders(false, true),
    }),
  );
  return res.json();
}

export interface OverseerStreamHandlers {
  onToken?: (delta: string) => void;
  onDone?: (data: OverseerDoneEvent) => void;
  onError?: (detail: string, code: string | null) => void;
}

export async function streamOverseer(
  message: string,
  handlers: OverseerStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await consumeSSE(
    "/overseer/stream",
    { message },
    (ev) => {
      switch (ev.type) {
        case "token":
          handlers.onToken?.((ev.data.delta as string) ?? "");
          break;
        case "done":
          handlers.onDone?.(ev.data as unknown as OverseerDoneEvent);
          break;
        case "error":
          handlers.onError?.(...sseError(ev.data));
          break;
      }
    },
    (d, c) => handlers.onError?.(d, c),
    signal,
  );
}

// ── 관리자 (Stage 4c, 관리자만) ──────────────────────────────────────

export async function listAdminUsers(): Promise<AdminUser[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users`, { credentials: "include", headers: authHeaders() }),
  );
  return res.json();
}

export async function setUserRole(
  userId: string,
  role: UserRole,
): Promise<Profile> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: "POST",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ role }),
    }),
  );
  return res.json();
}

export async function listAdminSettings(): Promise<AdminSetting[]> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/settings`, { credentials: "include", headers: authHeaders() }),
  );
  return res.json();
}

export async function putAdminSetting(
  key: string,
  value: unknown,
): Promise<AdminSetting> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/settings/${encodeURIComponent(key)}`, {
      method: "PUT",
      credentials: "include",
      headers: authHeaders(true),
      body: JSON.stringify({ value }),
    }),
  );
  return res.json();
}

export async function getAdminUsage(): Promise<AdminUsage> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/usage`, { credentials: "include", headers: authHeaders() }),
  );
  return res.json();
}

export async function getAdminLogs(opts: {
  userId?: string | null;
  since?: string | null;
  until?: string | null;
  /** 폴링: 이 created_at보다 엄격히 새로운 로그만. */
  after?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminLogsResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.since) params.set("since", opts.since);
  if (opts.until) params.set("until", opts.until);
  if (opts.after) params.set("after", opts.after);
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs?${params.toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

/** D34: 턴 상세 — ai_logs 1행(구조화 contexts) + 같은 세션 ReAct 트레이스. */
export async function getAdminLogDetail(logId: string): Promise<AdminLogDetail> {
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/logs/${encodeURIComponent(logId)}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}

/** D34: ReAct 트레이스 목록(user/session 필터). 턴 상세는 보통 getAdminLogDetail로 충분. */
export async function getAdminTraces(opts: {
  userId?: string | null;
  sessionId?: string | null;
  limit?: number;
  offset?: number;
}): Promise<AdminTracesResponse> {
  const params = new URLSearchParams();
  if (opts.userId) params.set("user_id", opts.userId);
  if (opts.sessionId) params.set("session_id", opts.sessionId);
  params.set("limit", String(opts.limit ?? 20));
  params.set("offset", String(opts.offset ?? 0));
  const res = await ensureOk(
    await fetch(`${API_BASE}/admin/traces?${params.toString()}`, {
      credentials: "include",
      headers: authHeaders(),
    }),
  );
  return res.json();
}
