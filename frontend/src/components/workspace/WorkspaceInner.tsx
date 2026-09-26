"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  addConnection,
  addFileGraphNode,
  addFileLink,
  createSession,
  deleteFile,
  patchFileGraphNode,
  putNodePositions,
  removeConnection,
  removeFileGraphNode,
  removeFileLink,
  spaceTargetFromId,
  uploadFile,
} from "@/lib/api";
import {
  fileGraphNodesKey,
  fileLinksKey,
  filesKey,
  sessionKey,
  sessionsKey,
  useFileGraphNodes,
  useFiles,
  useFileTagsMap,
  useSessionDetail,
  useSessionFileLinks,
} from "@/lib/queries";
import { useWorkspaceChat } from "@/lib/useWorkspaceChat";
import { useOptimisticList } from "@/lib/useOptimisticList";
import { isRealId } from "@/lib/ids";
import { useResizablePanels } from "@/lib/useResizablePanels";
import { useGeminiKeyFirstPrompt } from "@/lib/geminiKey";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import type {
  FileGraphNode,
  FileLink,
  FileRow,
  NodeRow,
  SessionDetail,
} from "@/lib/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { SessionList } from "./SessionList";
import { FilesPanel } from "./FilesPanel";
import { ChatPanel } from "./ChatPanel";
import { SessionGraph } from "./SessionGraph";
import { SkeletonGraph } from "@/components/ui/Skeleton";
import { NavigatorPopup } from "./NavigatorPopup";
import { WorkspaceSettings } from "./WorkspaceSettings";

/**
 * 공간 워크스페이스 3분할 오케스트레이터.
 * spaceId로 key를 주어 공간 전환 시 깨끗이 리마운트한다.
 */
export function WorkspaceInner({ spaceId }: { spaceId: string }) {
  const target = spaceTargetFromId(spaceId);
  const queryClient = useQueryClient();

  const reset = useWorkspaceStore((s) => s.reset);
  const setActiveSpace = useWorkspaceStore((s) => s.setActiveSpace);
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const activeNodeId = useWorkspaceStore((s) => s.activeNodeId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);
  const setActiveSession = useWorkspaceStore((s) => s.setActiveSession);
  const pendingSession = useWorkspaceStore((s) => s.pendingSession);
  const setPendingSession = useWorkspaceStore((s) => s.setPendingSession);

  // 공간 진입 시 선택 상태 초기화 + 활성 공간 기록(개념 페이지가 참조)
  useEffect(() => {
    reset();
    setActiveSpace(spaceId);
  }, [reset, setActiveSpace, spaceId]);

  const chat = useWorkspaceChat(target);

  // AI 기능 첫 진입: 키가 없으면 설정 안내를 한 번 띄운다(닫을 수 있음, 열람은 계속 가능).
  useGeminiKeyFirstPrompt();

  // 홈에서 넘긴 보류 작업 소비: 세션 선택(+ 시드 질문 전송)
  useEffect(() => {
    if (!pendingSession || pendingSession.spaceId !== spaceId) return;
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current !== pendingSession.sessionId) {
      setActiveSession(pendingSession.sessionId);
      return;
    }
    if (pendingSession.seed) {
      if (chat.streaming) return;
      const seed = pendingSession.seed;
      setPendingSession(null);
      void chat.send(seed, null);
    } else {
      setPendingSession(null);
    }
  }, [
    pendingSession,
    spaceId,
    activeSessionId,
    chat,
    setActiveSession,
    setPendingSession,
  ]);

  const { data: detail, isLoading: detailLoading } =
    useSessionDetail(activeSessionId);
  const nodes = useMemo(() => detail?.nodes ?? [], [detail?.nodes]);
  const rootNodeId = detail?.session?.root_node_id ?? null;

  // D40: 네비게이터 클릭 시 뜨는 팝업 대상 노드(즉시 전송 금지).
  const [navigatorPopupNode, setNavigatorPopupNode] = useState<NodeRow | null>(
    null,
  );

  // 그래프 노드 클릭: 네비게이터=팝업 오픈(D40), 일반=분기점 이동
  const handleNodeClick = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (node?.is_navigator) {
        setNavigatorPopupNode(node);
      } else {
        setActiveNode(id);
      }
    },
    [nodes, setActiveNode],
  );

  // 팝업 [질문하기]: provisional 단일경로 전송 + 선택 네비게이터 삭제 + 나머지 collapse.
  const handleAskNavigator = useCallback(async () => {
    const node = navigatorPopupNode;
    if (!node) return;
    setNavigatorPopupNode(null);
    await chat.askNavigator(node);
  }, [navigatorPopupNode, chat]);

  // ── 기억 연결(D14): source=우클릭 노드, target=클릭 노드 ──
  const patchConnections = useCallback(
    (nodeId: string, connections: string[]) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(activeSessionId), (old) =>
        old
          ? {
              ...old,
              nodes: old.nodes.map((n) =>
                n.id === nodeId ? { ...n, connections } : n,
              ),
            }
          : old,
      );
    },
    [queryClient, activeSessionId],
  );

  // 08 F: 기억 연결 추가/삭제도 낙관 표준(즉시 반영 → 서버 확정 → 실패 롤백).
  // 임시(낙관) 노드끼리는 영속 대상이 아니므로 isRealId로 차단(D63).
  const handleConnectNodes = useCallback(
    async (sourceId: string, targetId: string) => {
      if (!targetId || targetId === sourceId) return;
      if (!isRealId(sourceId) || !isRealId(targetId)) return;
      const key = sessionKey(activeSessionId);
      const prev = queryClient.getQueryData<SessionDetail>(key);
      const target = prev?.nodes.find((n) => n.id === targetId);
      // 즉시 낙관 반영(중복 방지)
      if (target && !(target.connections ?? []).includes(sourceId)) {
        patchConnections(targetId, [...(target.connections ?? []), sourceId]);
      }
      try {
        const resp = await addConnection(targetId, sourceId);
        patchConnections(targetId, resp.connections); // 실체화(권위값)
      } catch {
        if (prev) queryClient.setQueryData(key, prev); // 롤백
      }
    },
    [activeSessionId, queryClient, patchConnections],
  );

  const handleRemoveConnection = useCallback(
    async (targetId: string, sourceId: string) => {
      if (!isRealId(sourceId) || !isRealId(targetId)) return;
      const key = sessionKey(activeSessionId);
      const prev = queryClient.getQueryData<SessionDetail>(key);
      const target = prev?.nodes.find((n) => n.id === targetId);
      // 즉시 낙관 제거
      if (target) {
        patchConnections(
          targetId,
          (target.connections ?? []).filter((id) => id !== sourceId),
        );
      }
      try {
        const resp = await removeConnection(targetId, sourceId);
        patchConnections(targetId, resp.connections);
      } catch {
        if (prev) queryClient.setQueryData(key, prev); // 롤백
      }
    },
    [activeSessionId, queryClient, patchConnections],
  );

  // ── 좌표 영속(D20) ──
  const handlePersistPositions = useCallback(
    (positions: { node_id: string; x: number; y: number }[]) => {
      if (!activeSessionId || positions.length === 0) return;
      void putNodePositions(activeSessionId, positions);
    },
    [activeSessionId],
  );

  // ── 자료(D58): 좌측 목록은 공간 단위, 그래프 표시는 placement(세션별 배치) 기준 ──
  const { data: spaceFiles = [] } = useFiles(target);
  const { data: placements = [] } = useFileGraphNodes(activeSessionId);
  // placement + files 메타 조인 → 캔버스가 쓰는 FileRow 형태로 변환(좌표=placement).
  const fileNodes = useMemo<FileRow[]>(() => {
    if (!activeSessionId) return [];
    return placements.map((p) => {
      const f = spaceFiles.find((sf) => sf.id === p.file_id);
      const fm = p.files;
      return {
        id: p.file_id,
        kind: fm?.kind ?? f?.kind ?? null,
        name: f?.name ?? null,
        filename: f?.filename ?? null,
        storage_path: fm?.storage_path ?? f?.storage_path ?? null,
        mime: fm?.mime ?? f?.mime ?? null,
        size_bytes: f?.size_bytes ?? null,
        status: fm?.status ?? f?.status ?? "indexed",
        chunk_total: fm?.chunk_total ?? f?.chunk_total ?? null,
        chunk_done: fm?.chunk_done ?? f?.chunk_done ?? null,
        created_at: f?.created_at ?? p.created_at,
        session_id: activeSessionId,
        position_x: p.position_x,
        position_y: p.position_y,
        // 08 F: 낙관 배치는 캔버스에서 반투명 pending으로 렌더(서버 확정 시 실체화).
        _pending: p._provisional ?? false,
      } as FileRow;
    });
  }, [placements, spaceFiles, activeSessionId]);

  // 그래프 파일 노드 툴팁용 태그 맵(indexed 파일만)
  const indexedFileIds = useMemo(
    () => fileNodes.filter((f) => f.status === "indexed").map((f) => f.id),
    [fileNodes],
  );
  const fileTags = useFileTagsMap(indexedFileIds);

  const { data: fileLinks = [] } = useSessionFileLinks(activeSessionId);
  // D31: 자료 연결 실패 시 짧게 뜨는 토스트(롤백 안내).
  const [linkToast, setLinkToast] = useState<string | null>(null);

  const refreshFiles = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: filesKey(target) });
  }, [queryClient, target]);
  const refreshFileLinks = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: fileLinksKey(activeSessionId),
    });
  }, [queryClient, activeSessionId]);
  const refreshFileGraphNodes = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: fileGraphNodesKey(activeSessionId),
    });
  }, [queryClient, activeSessionId]);

  // ── 08 F: 자료 링크·배치 낙관 표준(useOptimisticList) ────────────────
  // D31/D58의 손짜 낙관 헬퍼(insert/rollback)를 공용 훅으로 통일했다. 라이프사이클은
  // 동일: 즉시 삽입(캔버스가 흐린 pending으로 렌더) → 서버 확정 → 성공 시 invalidate로
  // 실체화 / 실패 시 해당 항목만 롤백 + 토스트.
  const linkList = useOptimisticList<FileLink>(fileLinksKey(activeSessionId));
  const placementList = useOptimisticList<FileGraphNode>(
    fileGraphNodesKey(activeSessionId),
  );

  // 자료 연결: 낙관 삽입 → addFileLink → (성공)실데이터 교체 / (실패)롤백.
  const linkFileOptimistic = useCallback(
    async (fileId: string, nodeId: string) => {
      const f = spaceFiles.find((sf) => sf.id === fileId);
      const provisional: FileLink = {
        id: `pending:${fileId}->${nodeId}`,
        file_id: fileId,
        target_node_id: nodeId,
        created_at: new Date().toISOString(),
        files: f
          ? {
              id: f.id,
              storage_path: f.storage_path ?? null,
              mime: f.mime ?? null,
              status: f.status,
              chunk_total: f.chunk_total ?? null,
              chunk_done: f.chunk_done ?? null,
              session_id: f.session_id ?? null,
              position_x: f.position_x ?? null,
              position_y: f.position_y ?? null,
            }
          : null,
        _pending: true,
      };
      // 중복 가드: 같은 file→node 링크(실데이터·pending)가 이미 있으면 재삽입 안 함.
      const inserted = linkList.insert(provisional, {
        front: true,
        dup: (cur) =>
          cur.some((l) => l.file_id === fileId && l.target_node_id === nodeId),
      });
      try {
        await addFileLink(fileId, nodeId);
        refreshFileLinks();
      } catch {
        if (inserted) {
          linkList.removeWhere(
            (l) =>
              !!l._pending &&
              l.file_id === fileId &&
              l.target_node_id === nodeId,
          );
        }
        setLinkToast("자료 연결에 실패했습니다.");
      }
    },
    [linkList, spaceFiles, refreshFileLinks],
  );

  // 그래프에 배치(placement): 낙관 삽입(좌표 null이면 캔버스가 head 근처 자동 배치) →
  // addFileGraphNode → (성공)실데이터 / (실패)롤백. 같은 file이 이미 있으면 무삽입.
  const placeFileOptimistic = useCallback(
    async (fileId: string, x: number | null = null, y: number | null = null) => {
      if (!activeSessionId) return;
      const f = spaceFiles.find((sf) => sf.id === fileId);
      const provisional: FileGraphNode = {
        id: `provisional:${fileId}`,
        file_id: fileId,
        session_id: activeSessionId,
        position_x: x,
        position_y: y,
        created_at: new Date().toISOString(),
        _provisional: true,
        files: f
          ? {
              id: f.id,
              storage_path: f.storage_path ?? null,
              mime: f.mime ?? null,
              kind: f.kind ?? null,
              status: f.status,
              chunk_total: f.chunk_total ?? null,
              chunk_done: f.chunk_done ?? null,
            }
          : null,
      };
      const inserted = placementList.insert(provisional, {
        dup: (cur) => cur.some((p) => p.file_id === fileId),
      });
      try {
        await addFileGraphNode(activeSessionId, fileId, x, y);
        refreshFileGraphNodes();
      } catch {
        if (inserted) {
          placementList.removeWhere(
            (p) => !!p._provisional && p.file_id === fileId,
          );
        }
        setLinkToast("그래프에 추가하지 못했습니다.");
      }
    },
    [activeSessionId, placementList, spaceFiles, refreshFileGraphNodes],
  );

  // D59: 제안 "연결" 수락 = 배치(노드 즉시 표시) + file_node_links(RAG) 둘 다(각각 롤백).
  const handleAcceptSuggestion = useCallback(
    async (fileId: string, nodeId: string) => {
      await placeFileOptimistic(fileId);
      await linkFileOptimistic(fileId, nodeId);
    },
    [placeFileOptimistic, linkFileOptimistic],
  );

  // D58: 좌측 목록 "그래프에 추가" 버튼(head 근처 좌표).
  const handleAddToGraph = useCallback(
    (fileId: string) => {
      void placeFileOptimistic(fileId);
    },
    [placeFileOptimistic],
  );

  // D58: 좌측 목록을 캔버스에 드롭(그래프 좌표에 배치).
  const handlePlaceFile = useCallback(
    (fileId: string, x: number, y: number) => {
      void placeFileOptimistic(fileId, x, y);
    },
    [placeFileOptimistic],
  );

  // D58: 그래프에서 제거(placement 삭제). 파일·RAG링크는 유지.
  const handleRemoveFromGraph = useCallback(
    async (fileId: string) => {
      if (!activeSessionId) return;
      const prev = placementList.snapshot(); // 롤백 스냅샷
      placementList.removeWhere((p) => p.file_id === fileId); // 즉시 낙관 제거
      try {
        await removeFileGraphNode(activeSessionId, fileId);
        refreshFileGraphNodes();
      } catch {
        placementList.restore(prev); // 롤백
      }
    },
    [activeSessionId, placementList, refreshFileGraphNodes],
  );

  const handleRemoveFileLink = useCallback(
    async (fileId: string, nodeId: string) => {
      try {
        await removeFileLink(fileId, nodeId);
        refreshFileLinks();
      } catch {
        /* 무시 */
      }
    },
    [refreshFileLinks],
  );

  // 채팅 제안 / 파일 노드 우클릭 추적선에서 현재 노드에 연결(낙관적).
  const handleLinkFile = useCallback(
    (fileId: string, nodeId: string) => {
      void linkFileOptimistic(fileId, nodeId);
    },
    [linkFileOptimistic],
  );

  // 링크 실패 토스트 자동 소멸
  useEffect(() => {
    if (!linkToast) return;
    const t = setTimeout(() => setLinkToast(null), 2600);
    return () => clearTimeout(t);
  }, [linkToast]);

  // 자료 패널 삭제/재시도 후: 파일 목록 + 링크 + 배치 갱신(그래프 반영)
  const handleFilesChanged = useCallback(() => {
    refreshFiles();
    refreshFileLinks();
    refreshFileGraphNodes();
  }, [refreshFiles, refreshFileLinks, refreshFileGraphNodes]);

  // D58: 파일 노드 드래그 이동 = placement 좌표 갱신(PATCH).
  const handleFilePosition = useCallback(
    (fileId: string, x: number, y: number) => {
      if (!activeSessionId) return;
      void patchFileGraphNode(activeSessionId, fileId, x, y).catch(() => {});
    },
    [activeSessionId],
  );

  // 활성 세션 보장(빈 워크스페이스면 먼저 생성, D22)
  const ensureSession = useCallback(async (): Promise<string> => {
    const current = useWorkspaceStore.getState().activeSessionId;
    if (current) return current;
    const session = await createSession(target);
    await queryClient.invalidateQueries({ queryKey: sessionsKey(target) });
    setActiveSession(session.id);
    return session.id;
  }, [target, queryClient, setActiveSession]);

  // 자료 패널 업로드: 업로드 후 현재 세션 그래프에 placement 생성(head 근처 배치)
  const handlePanelUpload = useCallback(
    async (file: File) => {
      const sid = await ensureSession();
      const f = await uploadFile(target, file, { sessionId: sid });
      await addFileGraphNode(sid, f.id, null, null).catch(() => {});
      refreshFiles();
      void queryClient.invalidateQueries({ queryKey: fileGraphNodesKey(sid) });
    },
    [ensureSession, target, refreshFiles, queryClient],
  );

  // OS 드래그&드롭 업로드: 세션 보장 + 업로드 후 드롭 좌표에 placement 생성
  const handleDropUpload = useCallback(
    async (files: File[], x: number, y: number) => {
      let sid: string;
      try {
        sid = await ensureSession();
      } catch {
        return;
      }
      for (const file of files) {
        try {
          const f = await uploadFile(target, file, { sessionId: sid });
          await addFileGraphNode(sid, f.id, x, y).catch(() => {});
        } catch {
          /* 오류 안내는 자료 패널 업로드에서 */
        }
      }
      refreshFiles();
      void queryClient.invalidateQueries({ queryKey: fileGraphNodesKey(sid) });
    },
    [ensureSession, target, refreshFiles, queryClient],
  );

  // 파일 노드 삭제(D22)
  const handleDeleteFile = useCallback(
    async (fileId: string) => {
      if (!window.confirm("이 자료를 삭제할까요?")) return;
      try {
        await deleteFile(fileId);
        refreshFiles();
        refreshFileLinks();
        refreshFileGraphNodes();
      } catch {
        /* 무시 */
      }
    },
    [refreshFiles, refreshFileLinks, refreshFileGraphNodes],
  );

  // ── 브랜치 참조(D15) ──
  const [trackMode, setTrackMode] = useState(false);
  const [selectedTrackIds, setSelectedTrackIds] = useState<string[]>([]);

  const enterTrack = useCallback((nodeId?: string) => {
    setTrackMode(true);
    if (nodeId) {
      setSelectedTrackIds((prev) =>
        prev.includes(nodeId) ? prev : [...prev, nodeId],
      );
    }
  }, []);
  const toggleTrack = useCallback((nodeId: string) => {
    setTrackMode(true);
    setSelectedTrackIds((prev) =>
      prev.includes(nodeId)
        ? prev.filter((id) => id !== nodeId)
        : [...prev, nodeId],
    );
  }, []);
  const clearTracks = useCallback(() => {
    setTrackMode(false);
    setSelectedTrackIds([]);
  }, []);
  const toggleTrackMode = useCallback(() => {
    setTrackMode((v) => {
      if (v) setSelectedTrackIds([]);
      return !v;
    });
  }, []);

  // D50: 같은 공간 내 세션 전환 시 stale 참조 선택 정리(세션 A의 leaf id가 세션 B 질문에
  // reference_node_ids로 실려 엉뚱한 비교참조가 끼는 것 방지). 상태 소유자가 여기이므로
  // 일괄 정리하며, ChatPanel head-reset effect와 중복 정리하지 않는다. 공간 전환은
  // 상위 key 리마운트로 자연 초기화되므로 세션 전환만 커버한다.
  // React 권장 "prop 변경 시 state 조정" 패턴(prev를 state로 두고 렌더 중 비교)으로
  // cascading effect 회피.
  const [prevSessionId, setPrevSessionId] = useState(activeSessionId);
  if (prevSessionId !== activeSessionId) {
    setPrevSessionId(activeSessionId);
    clearTracks();
  }

  // 전송에 실을 참조 노드들(head 포함, 중복 제거)
  const referenceNodeIds = useMemo(() => {
    if (!trackMode) return [];
    return Array.from(
      new Set([activeNodeId, ...selectedTrackIds].filter(Boolean) as string[]),
    );
  }, [trackMode, activeNodeId, selectedTrackIds]);

  const spaceLabel = spaceId === "personal" ? "개인 공간" : "학급 공간";

  // ── D45: 사이드바 리사이즈/접기/러버밴드 ──
  const panels = useResizablePanels({
    storageKey: `nodi-panels:${spaceId}`,
    leftDefault: 260,
    rightDefault: 380,
    leftMin: 200,
    leftMax: 420,
    rightMin: 280,
    rightMax: 560,
  });

  return (
    <div className="relative flex h-full w-full flex-col">
      {linkToast && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-danger/50 bg-bg px-3 py-1.5 text-xs text-danger shadow-lg"
        >
          {linkToast}
        </div>
      )}
      <header className="flex items-center justify-between border-b border-accent-border/30 bg-bg-elevated px-5 py-3">
        <h1 className="flex items-center text-sm font-semibold text-fg">
          공간 워크스페이스
          <span className="ml-2 rounded-md bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
            {spaceLabel}
          </span>
        </h1>
        {/* D54: 좌·우 접기 토글은 각 사이드바 상단으로 이동. 헤더엔 설정만. */}
        <div className="flex items-center gap-1.5">
          <WorkspaceSettings />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 좌: 대화기록 · 자료 */}
        {panels.leftCollapsed ? (
          <button
            type="button"
            onClick={panels.toggleLeft}
            title="왼쪽 패널 펼치기"
            className="flex w-7 shrink-0 items-center justify-center border-r border-accent-border/30 bg-bg-elevated text-fg-muted hover:text-fg"
          >
            <ChevronRight size={16} />
          </button>
        ) : (
          <>
            <div
              className="flex min-h-0 shrink-0 flex-col border-r border-accent-border/30"
              style={{ width: panels.leftW }}
            >
              {/* D54: 좌 패널 상단 헤더 스트립 우측에 접기 버튼. */}
              <div className="flex items-center justify-between border-b border-accent-border/30 px-3 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                  대화 · 자료
                </span>
                <button
                  type="button"
                  onClick={panels.toggleLeft}
                  title="왼쪽 패널 접기"
                  className="flex items-center justify-center rounded-md p-1 text-fg-muted transition-colors hover:text-fg"
                >
                  <ChevronLeft size={16} />
                </button>
              </div>
              <SessionList target={target} />
              <FilesPanel
                target={target}
                fileLinks={fileLinks}
                onAddToGraph={handleAddToGraph}
                onRefresh={handleFilesChanged}
                onUpload={handlePanelUpload}
              />
            </div>
            <ResizeHandle onPointerDown={panels.startLeftDrag} />
          </>
        )}

        {/* 중: 대화 패널 */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col border-x border-accent-border/30">
          <ChatPanel
            chat={chat}
            fileLinks={fileLinks}
            trackMode={trackMode}
            referenceNodeIds={referenceNodeIds}
            onToggleTrackMode={toggleTrackMode}
            onClearTracks={clearTracks}
            onLinkFile={handleAcceptSuggestion}
          />
        </div>

        {/* 우: 그래프 */}
        {panels.rightCollapsed ? (
          <button
            type="button"
            onClick={panels.toggleRight}
            title="오른쪽 패널 펼치기"
            className="flex w-7 shrink-0 items-center justify-center border-l border-accent-border/30 bg-bg-elevated text-fg-muted hover:text-fg"
          >
            <ChevronLeft size={16} />
          </button>
        ) : (
          <>
            <ResizeHandle onPointerDown={panels.startRightDrag} />
            <div
              className="relative min-h-0 shrink-0 border-l border-accent-border/30"
              style={{ width: panels.rightW }}
            >
              {/* D54: 우 그래프 패널 우상단 오버레이 접기 버튼(줌/리센터=우하단과 분리). */}
              <button
                type="button"
                onClick={panels.toggleRight}
                title="오른쪽 패널 접기"
                className="absolute right-2 top-2 z-10 flex items-center justify-center rounded-lg border border-accent-border/50 bg-bg/80 p-1.5 text-fg-muted shadow-sm backdrop-blur transition-colors hover:text-fg"
              >
                <ChevronRight size={16} />
              </button>
              <SessionGraph
                nodes={nodes}
                rootNodeId={rootNodeId}
                activeNodeId={activeNodeId}
                onNodeClick={handleNodeClick}
                onConnectNodes={handleConnectNodes}
                onRemoveConnection={handleRemoveConnection}
                fileLinks={fileLinks}
                fileNodes={fileNodes}
                fileTags={fileTags}
                fileLinkMode={false}
                onLinkTarget={() => {}}
                onRemoveFileLink={handleRemoveFileLink}
                onConnectFileToNode={handleLinkFile}
                onDeleteFile={handleDeleteFile}
                onRemoveFromGraph={handleRemoveFromGraph}
                onPlaceFile={handlePlaceFile}
                onFilePosition={handleFilePosition}
                onDropUpload={handleDropUpload}
                onPersistPositions={handlePersistPositions}
                trackMode={trackMode}
                selectedTrackIds={selectedTrackIds}
                onToggleTrack={toggleTrack}
                onEnterTrack={enterTrack}
                lastReplace={chat.lastReplace}
              />
              {/* 08 H: 세션 그래프 cold 로드 중 원형 노드 스켈레톤(빈 화면 방지). */}
              {activeSessionId && detailLoading && nodes.length === 0 && (
                <div className="pointer-events-none absolute inset-0 z-[5]">
                  <SkeletonGraph />
                </div>
              )}
              {navigatorPopupNode && (
                <NavigatorPopup
                  node={navigatorPopupNode}
                  busy={chat.streaming}
                  onAsk={handleAskNavigator}
                  onClose={() => setNavigatorPopupNode(null)}
                />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** D45: 패널 경계 드래그 핸들(4~6px). */
function ResizeHandle({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      className="group relative w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-accent-deep/30"
      title="드래그하여 크기 조절"
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent-border/30 group-hover:bg-accent-deep/50" />
    </div>
  );
}
