"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  deleteNode,
  streamChat,
  type ChatNavigatorOverride,
  type SpaceTarget,
} from "@/lib/api";
import { sessionKey, sessionsKey } from "@/lib/queries";
import { makeOptimisticId } from "@/lib/ids";
import {
  GEMINI_KEY_NOTICE,
  isGeminiKeyError,
  openGeminiKeyDialog,
  readGeminiKey,
} from "@/lib/geminiKey";
import { useWorkspaceStore } from "@/store/useWorkspaceStore";
import { useWorkspacePrefs } from "@/store/useWorkspacePrefs";
import type { ChatNavigatorEvent, NodeRow, SessionDetail } from "@/lib/types";

/**
 * 워크스페이스 채팅 컨트롤러. WorkspaceInner에서 1개 인스턴스를 만들어
 * ChatPanel(입력/스트리밍 표시)과 그래프가 공유한다.
 *
 * D36 단일경로: send는 전송 즉시 provisional 노드를 세션 캐시에 1회 삽입하고,
 * onDone에서 단 한 번의 reconcile로 provisional 제거 + real 추가(좌표 승계 힌트 발행),
 * onError/빈응답 시 provisional 롤백. 일반 전송과 네비게이터 [질문하기]가 같은 경로.
 *
 * D40: 네비게이터 클릭은 더 이상 즉시 전송하지 않는다(WorkspaceInner가 팝업 오픈).
 * [질문하기]는 askNavigator로 provisional send + 선택 네비게이터 DELETE + 나머지 collapse.
 */
export interface ProvisionalReplace {
  tempId: string;
  realId: string;
  nonce: number;
}

export interface WorkspaceChat {
  streaming: boolean;
  draftQ: string;
  streamAnswer: string;
  error: string | null;
  /** 오류 코드(gemini_key_required 등). 키 관련이면 UI가 [키 입력] 안내를 붙인다. */
  errorCode: string | null;
  /** D36: 직전 provisional→real 교체 정보(캔버스 좌표 승계·전환 모션용). */
  lastReplace: ProvisionalReplace | null;
  send: (
    question: string,
    parentNodeId: string | null,
    opts?: { referenceNodeIds?: string[] },
  ) => Promise<{ ok: boolean }>;
  /** D40: 네비게이터 [질문하기] — provisional 전송 + 선택 노드 삭제 + 나머지 흡수. */
  askNavigator: (node: NodeRow) => Promise<void>;
}

/**
 * D47: 개인 선호 → per-request override. "전역 한도 내 개인 선호"이므로
 * 사용자가 명시적으로 바꾼 필드만 보내고, 미설정 필드는 omit해서 서버 config/admin
 * 기본(navigator_question_count 등)이 그대로 적용되게 한다.
 * - enabled: 사용자가 OFF로 명시했을 때만 false 전달(ON은 기본이라 admin 기본을 덮지 않음).
 * - count: 슬라이더를 직접 건드린(customized) 경우에만 전달.
 * - gate_k/period: 사용자가 직접 입력한 값이 있을 때만 전달.
 * 아무 것도 커스터마이즈하지 않았으면 null(override 없음).
 */
function navigatorOverrideFromPrefs(): ChatNavigatorOverride | null {
  const p = useWorkspacePrefs.getState();
  const o: ChatNavigatorOverride = {};
  if (!p.navigatorEnabled) o.enabled = false;
  if (p.navigatorCountCustomized) o.count = p.navigatorCount;
  if (p.navigatorGateK != null) o.gate_k = p.navigatorGateK;
  if (p.navigatorPeriod != null) o.period = p.navigatorPeriod;
  return Object.keys(o).length ? o : null;
}

export function useWorkspaceChat(target: SpaceTarget): WorkspaceChat {
  const queryClient = useQueryClient();
  const activeSessionId = useWorkspaceStore((s) => s.activeSessionId);
  const setActiveNode = useWorkspaceStore((s) => s.setActiveNode);

  const [streaming, setStreaming] = useState(false);
  const [draftQ, setDraftQ] = useState("");
  const [streamAnswer, setStreamAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [lastReplace, setLastReplace] = useState<ProvisionalReplace | null>(null);
  const replaceNonceRef = useRef(0);

  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const appendNavigators = useCallback(
    (sessionId: string, data: ChatNavigatorEvent) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(sessionId), (old) => {
        if (!old) return old;
        const existing = new Set(old.nodes.map((n) => n.id));
        const toAdd: NodeRow[] = data.nodes
          .filter((n) => !existing.has(n.id))
          .map((n) => ({
            id: n.id,
            session_id: sessionId,
            parent_id: n.parent_id,
            question: "",
            answer: "",
            label: n.navigator_question,
            is_navigator: true,
            navigator_question: n.navigator_question,
            navigator_meta: n.navigator_meta ?? null,
            position_x: null,
            position_y: null,
            created_at: new Date().toISOString(),
            tags: null,
          }));
        return toAdd.length ? { ...old, nodes: [...old.nodes, ...toAdd] } : old;
      });
    },
    [queryClient],
  );

  const removeNode = useCallback(
    (sessionId: string, nodeId: string) => {
      queryClient.setQueryData<SessionDetail>(sessionKey(sessionId), (old) =>
        old ? { ...old, nodes: old.nodes.filter((n) => n.id !== nodeId) } : old,
      );
    },
    [queryClient],
  );

  const send = useCallback(
    async (
      question: string,
      parentNodeId: string | null,
      opts?: { referenceNodeIds?: string[] },
    ): Promise<{ ok: boolean }> => {
      const q = question.trim();
      if (!q || !activeSessionId || streaming) return { ok: false };

      // 키가 없으면 요청·낙관 노드 없이 안내만(서버도 거절하지만 왕복을 아낀다).
      if (!readGeminiKey()) {
        setError(GEMINI_KEY_NOTICE);
        setErrorCode("gemini_key_required");
        openGeminiKeyDialog(GEMINI_KEY_NOTICE);
        return { ok: false };
      }

      setError(null);
      setErrorCode(null);
      setDraftQ(q);
      setStreamAnswer("");
      setStreaming(true);

      const sessionId = activeSessionId;
      const parent = parentNodeId;
      const controller = new AbortController();
      abortRef.current = controller;
      let acc = "";
      let okFlag = false;
      let errFlag = false;

      const refIds = opts?.referenceNodeIds?.length
        ? opts.referenceNodeIds
        : undefined;

      // D36: 전송 즉시 provisional 노드를 1회 삽입(부모 아래는 캔버스 D38 규칙).
      // 08 F: 임시 id는 공용 makeOptimisticId로 표준화(접두 provisional: 유지 →
      // 캔버스 _provisional 플래그가 pending 시각을 구동, isRealId 가드가 영속 차단).
      const tempId = makeOptimisticId("provisional");
      const provisional: NodeRow = {
        id: tempId,
        session_id: sessionId,
        parent_id: parent,
        question: q,
        answer: "",
        label: null,
        is_navigator: false,
        navigator_question: null,
        position_x: null,
        position_y: null,
        created_at: new Date().toISOString(),
        tags: null,
        _provisional: true,
      };
      queryClient.setQueryData<SessionDetail>(sessionKey(sessionId), (old) =>
        old ? { ...old, nodes: [...old.nodes, provisional] } : old,
      );

      await streamChat(
        {
          session_id: sessionId,
          question: q,
          parent_node_id: parent ?? undefined,
          reference_node_ids: refIds,
          navigator: navigatorOverrideFromPrefs(),
        },
        {
          onToken: (delta) => {
            acc += delta;
            setStreamAnswer(acc);
          },
          onNavigator: (data) => appendNavigators(sessionId, data),
          onDone: (data) => {
            const realId = data.node.id;
            const newNode: NodeRow = {
              id: realId,
              session_id: sessionId,
              parent_id: data.node.parent_id ?? parent ?? null,
              question: q,
              answer: acc,
              label: data.node.label,
              is_navigator: false,
              navigator_question: null,
              position_x: null,
              position_y: null,
              created_at: new Date().toISOString(),
              tags: data.node.tags ?? null,
              // D57: done 이벤트가 실어준 비교참조 출처/네비 근거를 즉시 반영 →
              // 리페치 전에도 참조 브랜치 칩+팝업이 보인다(이후 invalidate로 재확인).
              reference_sources: data.node.reference_sources ?? null,
              navigator_meta: data.node.navigator_meta ?? null,
            };

            // D36: 단 한 번의 reconcile — provisional 제거 + real 추가(부분상태 노출 금지).
            queryClient.setQueryData<SessionDetail>(
              sessionKey(sessionId),
              (old) => {
                if (!old) return old;
                const rest = old.nodes.filter(
                  (n) => n.id !== tempId && n.id !== realId,
                );
                return {
                  session: {
                    ...old.session,
                    current_head_id: data.current_head_id ?? realId,
                    root_node_id:
                      old.session.root_node_id ?? data.root_node_id ?? realId,
                  },
                  nodes: [...rest, newNode],
                };
              },
            );

            // 캔버스에 좌표 승계·전환 모션 힌트 발행.
            replaceNonceRef.current += 1;
            setLastReplace({
              tempId,
              realId,
              nonce: replaceNonceRef.current,
            });

            setActiveNode(realId);
            setStreaming(false);
            setDraftQ("");
            setStreamAnswer("");
            okFlag = true;
            void queryClient.invalidateQueries({
              queryKey: sessionsKey(target),
            });
          },
          onError: (detail, code) => {
            errFlag = true;
            setError(detail);
            setErrorCode(code);
            if (isGeminiKeyError(code)) openGeminiKeyDialog(detail);
            setDraftQ("");
            setStreamAnswer("");
            setStreaming(false);
            removeNode(sessionId, tempId); // D36: 롤백
          },
        },
        controller.signal,
      );

      // 빈 응답(done 없이 종료)도 롤백.
      if (!okFlag) {
        removeNode(sessionId, tempId);
      }
      // done·error 없이 스트림이 끝났으면(프록시 절단 등) 입력 잠금을 풀고 안내한다.
      if (!okFlag && !errFlag && !controller.signal.aborted) {
        setStreaming(false);
        setDraftQ("");
        setStreamAnswer("");
        setError("응답이 중단됐어요. 다시 시도해 주세요.");
        setErrorCode(null);
      }

      // 스트림 종료 후 1회 재동기화(rag_sources·reference_sources·네비게이터 영속 반영).
      if (okFlag) {
        void queryClient.invalidateQueries({ queryKey: sessionKey(sessionId) });
      }

      return { ok: okFlag };
    },
    [
      activeSessionId,
      streaming,
      queryClient,
      target,
      setActiveNode,
      appendNavigators,
      removeNode,
    ],
  );

  const askNavigator = useCallback(
    async (node: NodeRow) => {
      if (streaming) return;
      // 키가 없으면 네비게이터를 지우기 전에 멈춘다(삭제 후 전송 실패로 추천이 사라지지 않게).
      if (!readGeminiKey()) {
        setError(GEMINI_KEY_NOTICE);
        setErrorCode("gemini_key_required");
        openGeminiKeyDialog(GEMINI_KEY_NOTICE);
        return;
      }
      const parentId = node.parent_id;
      const question = node.navigator_question ?? node.question;

      // D40: [질문하기] 누르는 "즉시"(send/스트리밍 전에) 형제 흡수를 낙관적으로 수행한다.
      // → 스트리밍 동안 선택 네비 + provisional + 나머지 형제 네비가 공존하던 잔존을 제거.
      // ① 선택한 네비게이터를 캐시에서 즉시 제거(가짜 노드가 곧바로 사라짐).
      removeNode(node.session_id, node.id);
      // ② 같은 부모의 나머지 네비게이터를 collapse(흡수 모션 → 숨김).
      //    collapse는 is_navigator 노드만 가리므로(SessionGraphCanvas L305) provisional
      //    실노드는 영향받지 않고, trailing refetch가 삭제 전 네비를 되돌려도 collapse가 가린다.
      if (parentId) {
        useWorkspacePrefs.getState().collapseNavParent(parentId);
      }
      // ③ DB 삭제(서버)는 await로 흐름을 막지 않는다 — fire-and-forget(실패해도 채팅 안 깨짐).
      void deleteNode(node.id).catch(() => {
        /* 서버 삭제 실패 무시 — 캐시는 이미 정리됨 */
      });

      // provisional→real 단일경로 전송(D36). onError/빈응답 롤백은 provisional만 되돌리며,
      // 선택 네비는 되살리지 않는다(사용자가 회색 버튼으로 다시 펼치면 됨).
      await send(question, parentId);
    },
    [streaming, send, removeNode],
  );

  return {
    streaming,
    draftQ,
    streamAnswer,
    error,
    errorCode,
    lastReplace,
    send,
    askNavigator,
  };
}
