import { create } from "zustand";

/**
 * 현재 선택된 공간(개인/학급)을 보관하는 클라이언트 상태.
 * Stage 0: 골격만. 영구 데이터는 백엔드(DB)가 정본이며 이 스토어는 UI 선택 상태만 보유한다.
 */
export type SpaceKind = "personal" | "class";

export interface SpaceSelection {
  spaceId: string; // 'personal' 또는 class_id
  kind: SpaceKind;
}

interface SpaceStore {
  current: SpaceSelection;
  setCurrent: (selection: SpaceSelection) => void;
}

export const useSpaceStore = create<SpaceStore>((set) => ({
  current: { spaceId: "personal", kind: "personal" },
  setCurrent: (selection) => set({ current: selection }),
}));
