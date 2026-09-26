import { create } from "zustand";

/**
 * 워크스페이스 클라이언트 상태 (영구 데이터는 백엔드가 정본).
 * - activeSessionId: 선택된 세션
 * - activeNodeId: 포커스 노드. 대화 스레드는 이 노드의 조상체인으로 펼쳐지고,
 *   다음 질문은 이 노드를 parent_node_id로 분기한다(사용자 주도 분기).
 */
/**
 * 홈 → 워크스페이스로 넘기는 보류 작업.
 * spaceId 공간의 sessionId를 선택하고, seed가 있으면 첫 질문으로 전송한다.
 * (홈의 질문박스/총괄AI 액션이 새 세션을 만들어 시드 질문을 시작하는 경로.)
 */
export interface PendingSession {
  spaceId: string;
  sessionId: string;
  seed?: string;
}

interface WorkspaceState {
  activeSessionId: string | null;
  activeNodeId: string | null;
  /** 마지막으로 진입한 공간(spaceId). 개념 노드 페이지가 어느 공간을 보일지 결정. */
  activeSpaceId: string;
  pendingSession: PendingSession | null;
  setActiveSession: (id: string | null) => void;
  setActiveNode: (id: string | null) => void;
  setActiveSpace: (spaceId: string) => void;
  setPendingSession: (p: PendingSession | null) => void;
  reset: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  activeSessionId: null,
  activeNodeId: null,
  activeSpaceId: "personal",
  pendingSession: null,
  setActiveSession: (id) => set({ activeSessionId: id, activeNodeId: null }),
  setActiveNode: (id) => set({ activeNodeId: id }),
  setActiveSpace: (spaceId) => set({ activeSpaceId: spaceId }),
  setPendingSession: (p) => set({ pendingSession: p }),
  // pendingSession은 의도적으로 유지(홈에서 설정 후 워크스페이스 마운트 시 소비)
  reset: () => set({ activeSessionId: null, activeNodeId: null }),
}));
