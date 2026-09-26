"use client";

import { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import {
  LocateFixed,
  LayoutGrid,
  GitFork,
  Layers,
  Upload,
  Link2,
  Trash2,
  EyeOff,
} from "lucide-react";
import type { FileLink, FileRow, NodeRow } from "@/lib/types";
import type { ProvisionalReplace } from "@/lib/useWorkspaceChat";
import { useWorkspacePrefs } from "@/store/useWorkspacePrefs";
import { buildNested, pathIdSet, buildById, type TreeNode } from "@/lib/tree";
import {
  PENDING_LINK_DASH,
  PENDING_LINK_OPACITY,
  PENDING_NODE_DASH,
  PENDING_NODE_OPACITY,
  SETTLE_TRANSITION_MS,
  SOLID_LINK_DASH,
} from "@/lib/loadingTokens";

/**
 * 세션 그래프 뷰 — D3 수직 트리(위→아래) + Wave A 인터랙션(§10, D13~D20).
 * - 대화 노드(원형) + 파일 노드(문서) 레이어, 줌/팬/드래그(서브트리 동반).
 * - 우클릭 컨텍스트 메뉴: 이동 / 기억 연결(마우스 추적 점선) / 브랜치 참조.
 * - 좌표 영속(저장 좌표 우선) + "노드 재정렬" 버튼, OS 파일 드래그&드롭 업로드.
 */

const C = {
  nodeFill: "#fcf58b",
  nodeStroke: "#6b4e13",
  nodeLabel: "#3a3320",
  pathStroke: "#e0a32e",
  linkNormal: "#d9cfb0",
  linkPath: "#e0a32e",
  navStroke: "#7a7a6e",
  navFill: "#fffdf7",
  labelMuted: "#7a7a6e",
  conn: "#c2702a", // 기억 연결선(주황)
  file: "#2a7d7a", // 파일 연결선/노드(청록)
  fileFill: "#e3f1ef",
  fileBusy: "#e0a32e",
  fileFail: "#b54a3a",
  provFill: "#fdfbe0", // D36 provisional 채움(연한 톤)
  refRing: "#2a7d7a", // D46 참조 가능 leaf 하이라이트(청록 링)
  navCollapse: "#9a948a", // D40 collapse 회색 버튼
} as const;

const TRACK_COLORS = ["#e0a32e", "#6e8a3c", "#c2702a", "#3a7d9a", "#9a5ea3"];

const R = 11;
const MIN_CHILD_Y_GAP = 60;

interface ConnPair {
  source: string;
  target: string;
  key: string;
}

interface Props {
  nodes: NodeRow[];
  rootNodeId: string | null;
  activeNodeId: string | null;
  onNodeClick: (id: string) => void;
  /** 기억 연결(D14): source=우클릭 노드, target=클릭 노드. */
  onConnectNodes: (sourceId: string, targetId: string) => void;
  onRemoveConnection: (targetId: string, sourceId: string) => void;
  /** 시각적 RAG(3b-2 유지): 자료 패널에서 시작한 파일→분기 연결 모드. */
  fileLinks: FileLink[];
  fileNodes: FileRow[];
  /** 파일 노드 태그(툴팁용). fileId → 태그 이름들. */
  fileTags: Record<string, string[]>;
  fileLinkMode: boolean;
  onLinkTarget: (nodeId: string) => void;
  onRemoveFileLink: (fileId: string, nodeId: string) => void;
  /** D22: 파일 노드 우클릭→추적선→분기 노드 클릭으로 RAG 연결. */
  onConnectFileToNode: (fileId: string, nodeId: string) => void;
  /** D22: 파일 노드 삭제(파일 자체). */
  onDeleteFile: (fileId: string) => void;
  /** D58: 그래프에서 제거(placement 삭제, 파일·RAG링크 유지). */
  onRemoveFromGraph: (fileId: string) => void;
  /** D58: 좌측 목록을 캔버스에 드롭 → 그 좌표에 placement 생성. */
  onPlaceFile: (fileId: string, x: number, y: number) => void;
  /** 파일 노드 좌표 영속(D13/D20 → D58 placement PATCH). */
  onFilePosition: (fileId: string, x: number, y: number) => void;
  /** OS 파일 드롭 업로드(D16). 좌표는 그래프 좌표. */
  onDropUpload: (files: File[], x: number, y: number) => void;
  /** 노드 좌표 일괄 영속(D20). */
  onPersistPositions: (
    positions: { node_id: string; x: number; y: number }[],
  ) => void;
  /** 브랜치 참조(D15). */
  trackMode: boolean;
  selectedTrackIds: string[];
  onToggleTrack: (nodeId: string) => void;
  onEnterTrack: (nodeId: string) => void;
  /** D36: 직전 provisional→real 교체 정보(좌표 승계·전환 모션용). */
  lastReplace: ProvisionalReplace | null;
}

type HNode = d3.HierarchyPointNode<TreeNode>;
type Pt = { x: number; y: number };

export default function SessionGraphCanvas(props: Props) {
  const {
    nodes,
    rootNodeId,
    activeNodeId,
    fileLinks,
    fileNodes,
    fileTags,
    fileLinkMode,
    trackMode,
    selectedTrackIds,
    lastReplace,
  } = props;

  // D40: 네비게이터 collapse 상태(개인 prefs, localStorage).
  const collapsedNavParents = useWorkspacePrefs((s) => s.collapsedNavParents);
  const expandedNavParents = useWorkspacePrefs((s) => s.expandedNavParents);
  const toggleNavParent = useWorkspacePrefs((s) => s.toggleNavParent);
  // D51: 네비게이터 자동생성 off면 기존 is_navigator 노드도 캔버스에서 숨김(비파괴, 재가역).
  const navigatorEnabled = useWorkspacePrefs((s) => s.navigatorEnabled);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const gRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const linkGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const connGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const fileGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const nodeGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const navToggleGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const tempGRef = useRef<d3.Selection<SVGGElement, unknown, null, undefined> | null>(null);
  const processedReplaceNonceRef = useRef(0);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform>(d3.zoomIdentity.translate(0, 60).scale(0.9));

  const posRef = useRef<Map<string, Pt>>(new Map()); // 대화 노드
  const filePosRef = useRef<Map<string, Pt>>(new Map()); // 파일 노드
  const prevRootRef = useRef<string | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forceLayoutRef = useRef(false);

  // 최신 props를 D3 핸들러에서 보기 위한 ref (이벤트 시점에 최신값 참조)
  const pr = useRef(props);
  useEffect(() => {
    pr.current = props;
  });

  const [dim, setDim] = useState({ width: 0, height: 0 });
  const [reorderNonce, setReorderNonce] = useState(0);
  // 기억 연결(대화 노드 source)
  const [connectingSourceId, setConnectingSourceId] = useState<string | null>(null);
  const connectingRef = useRef<string | null>(null);
  // 자료 연결(파일 노드 source → 분기 노드 target, RAG)
  const [connectingFileId, setConnectingFileId] = useState<string | null>(null);
  const connectingFileRef = useRef<string | null>(null);
  // 컨텍스트 메뉴: 대화 노드('node') | 파일 노드('file')
  const [menu, setMenu] = useState<{
    kind: "node" | "file";
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [dropActive, setDropActive] = useState(false);

  useEffect(() => {
    connectingRef.current = connectingSourceId;
  }, [connectingSourceId]);
  useEffect(() => {
    connectingFileRef.current = connectingFileId;
  }, [connectingFileId]);

  // ── 컨테이너 크기 ──
  useEffect(() => {
    if (!wrapperRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r && r.width > 0 && r.height > 0) {
        requestAnimationFrame(() => setDim({ width: r.width, height: r.height }));
      }
    });
    ro.observe(wrapperRef.current);
    return () => ro.disconnect();
  }, []);

  // client → graph 좌표 변환
  const toGraph = (clientX: number, clientY: number): Pt => {
    const rect = svgRef.current?.getBoundingClientRect();
    const t = transformRef.current;
    const lx = clientX - (rect?.left ?? 0);
    const ly = clientY - (rect?.top ?? 0);
    return { x: (lx - t.x) / t.k, y: (ly - t.y) / t.k };
  };

  // ── SVG/레이어/줌 1회 초기화 ──
  useEffect(() => {
    if (!svgRef.current || dim.width === 0 || gRef.current) return;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const bg = svg
      .append("rect")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("fill", "transparent")
      .style("cursor", "grab");
    bg.on("click", () => {
      if (connectingRef.current) setConnectingSourceId(null);
      if (connectingFileRef.current) setConnectingFileId(null);
      setMenu(null);
    });

    const g = svg.append("g");
    gRef.current = g;
    linkGRef.current = g.append("g").attr("class", "links");
    connGRef.current = g.append("g").attr("class", "connections");
    fileGRef.current = g.append("g").attr("class", "filenodes");
    nodeGRef.current = g.append("g").attr("class", "nodes");
    navToggleGRef.current = g.append("g").attr("class", "navtoggle");
    tempGRef.current = g.append("g").attr("class", "temp");

    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 2.5])
      .on("zoom", (event) => {
        g.attr("transform", event.transform.toString());
        transformRef.current = event.transform;
      })
      .on("start", () => bg.style("cursor", "grabbing"))
      .on("end", () => bg.style("cursor", "grab"));
    svg.call(zoom).on("dblclick.zoom", null);
    zoomRef.current = zoom;

    const init = d3.zoomIdentity.translate(dim.width / 2, 60).scale(0.9);
    transformRef.current = init;
    svg.call(zoom.transform, init);
  }, [dim.width, dim.height]);

  const recenter = (nodeId: string | null) => {
    if (!svgRef.current || !zoomRef.current) return;
    const pos = nodeId ? posRef.current.get(nodeId) : null;
    const target = pos ?? { x: 0, y: 60 };
    const t = d3.zoomIdentity
      .translate(dim.width / 2, dim.height / 3)
      .scale(1)
      .translate(-target.x, -target.y);
    d3.select(svgRef.current).transition().duration(500).call(zoomRef.current.transform, t);
  };

  // 유효 연결 타깃: 조상/자손/자기자신 거부
  const isValidConnectTarget = (
    sourceId: string,
    targetId: string,
    byId: Map<string, NodeRow>,
  ): boolean => {
    if (sourceId === targetId) return false;
    const aSrc = pathIdSet(sourceId, byId);
    const aTgt = pathIdSet(targetId, byId);
    return !aSrc.has(targetId) && !aTgt.has(sourceId);
  };

  const debouncedPersist = (
    positions: { node_id: string; x: number; y: number }[],
  ) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      pr.current.onPersistPositions(positions);
    }, 400);
  };

  // ── 메인 데이터 렌더링 ──
  useEffect(() => {
    if (
      !gRef.current ||
      !linkGRef.current ||
      !nodeGRef.current ||
      !connGRef.current ||
      !fileGRef.current
    )
      return;
    if (dim.width === 0) return;

    if (prevRootRef.current !== rootNodeId) {
      posRef.current = new Map();
      filePosRef.current = new Map();
      prevRootRef.current = rootNodeId;
    }

    const linkLayer = linkGRef.current;
    const connLayer = connGRef.current;
    const fileLayer = fileGRef.current;
    const nodeLayer = nodeGRef.current;
    const navToggleLayer = navToggleGRef.current;

    // ── D40: 네비게이터 collapse 계산 ──
    // 부모가 실(비네비) 자식 + 네비 자식을 동시에 가지면 기본 collapse(재로드 휴리스틱).
    const navChildCount = new Map<string, number>();
    const hasRealChild = new Set<string>();
    for (const n of nodes) {
      if (!n.parent_id) continue;
      if (n.is_navigator)
        navChildCount.set(n.parent_id, (navChildCount.get(n.parent_id) ?? 0) + 1);
      else hasRealChild.add(n.parent_id);
    }
    const effCollapsed = (pid: string): boolean => {
      const def = (navChildCount.get(pid) ?? 0) > 0 && hasRealChild.has(pid);
      if (collapsedNavParents.includes(pid)) return true;
      if (expandedNavParents.includes(pid)) return false;
      return def;
    };
    const hiddenNavIds = new Set<string>();
    for (const n of nodes) {
      if (!n.is_navigator) continue;
      // D51: off면 모든 네비게이터 노드를 숨김. on이면 기존 collapse 휴리스틱 적용.
      if (!navigatorEnabled) {
        hiddenNavIds.add(n.id);
        continue;
      }
      if (n.parent_id && effCollapsed(n.parent_id)) hiddenNavIds.add(n.id);
    }
    const displayNodes = hiddenNavIds.size
      ? nodes.filter((n) => !hiddenNavIds.has(n.id))
      : nodes;

    const nested = buildNested(displayNodes, rootNodeId);
    if (!nested) {
      // 대화 노드가 아직 없어도 떠다니는 자료 노드는 표시(D22)
      linkLayer.selectAll("*").remove();
      connLayer.selectAll("*").remove();
      nodeLayer.selectAll("*").remove();
      navToggleLayer?.selectAll("*").remove();

      fileNodes.forEach((f, i) => {
        if (filePosRef.current.has(f.id)) return;
        if (f.position_x != null && f.position_y != null) {
          filePosRef.current.set(f.id, { x: f.position_x, y: f.position_y });
        } else {
          filePosRef.current.set(f.id, {
            x: (i % 3) * 46,
            y: 60 + Math.floor(i / 3) * 46,
          });
        }
      });

      const fdrag = d3
        .drag<SVGGElement, FileRow>()
        .on("start", function (event) {
          event.sourceEvent.stopPropagation();
          d3.select(this).raise();
        })
        .on("drag", function (event, f) {
          const p = filePosRef.current.get(f.id);
          if (!p) return;
          const np = { x: p.x + event.dx, y: p.y + event.dy };
          filePosRef.current.set(f.id, np);
          d3.select(this).attr("transform", `translate(${np.x},${np.y})`);
        })
        .on("end", function (_e, f) {
          const p = filePosRef.current.get(f.id);
          if (p) pr.current.onFilePosition(f.id, p.x, p.y);
        });

      const fs = fileLayer
        .selectAll<SVGGElement, FileRow>("g.filenode")
        .data(fileNodes, (d) => d.id);
      fs.exit().remove();
      const fe = fs
        .enter()
        .append("g")
        .attr("class", "filenode")
        .style("cursor", "grab");
      fe.append("rect").attr("class", "fbox").attr("x", -10).attr("y", -12).attr("width", 20).attr("height", 24).attr("rx", 3);
      fe.append("line").attr("class", "fl").attr("x1", -5).attr("y1", -5).attr("x2", 5).attr("y2", -5);
      fe.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 0).attr("x2", 5).attr("y2", 0);
      fe.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 5).attr("x2", 2).attr("y2", 5);
      fe.append("text").attr("class", "fname").attr("dy", "2.4em").attr("text-anchor", "middle").style("font-size", "9px").style("font-family", "var(--font-sans), sans-serif").style("pointer-events", "none").attr("fill", C.file);
      fe.append("title");
      const fm = fe.merge(fs);
      fm.each(function (f) {
        const p = filePosRef.current.get(f.id);
        const s2 = d3.select(this);
        if (p) s2.attr("transform", `translate(${p.x},${p.y})`);
        const busy = f.status !== "indexed" && f.status !== "needs_key";
        const fail = f.status === "failed" || f.status === "partial";
        const stroke = fail ? C.fileFail : busy ? C.fileBusy : C.file;
        s2.select("rect.fbox").attr("fill", C.fileFill).attr("stroke", stroke).attr("stroke-width", 1.5);
        s2.selectAll("line.fl").attr("stroke", stroke).attr("stroke-width", 1);
        const nm =
          f.name ||
          f.filename ||
          (f.storage_path ? f.storage_path.split("/").pop() || f.storage_path : f.id.slice(0, 6));
        s2.select("text.fname").text(nm.length > 10 ? nm.slice(0, 10) + "…" : nm);
        const tg = fileTags[f.id];
        const tagLine = tg && tg.length > 0 ? `\n태그: ${tg.slice(0, 8).map((t) => "#" + t).join(" ")}` : "";
        s2.select("title").text(`📎 ${nm}${busy ? " (임베딩 중)" : ""}${f.status === "needs_key" ? " (API 키 필요 — 자료 검색 대기)" : ""}${tagLine}`);
      });
      fm.call(fdrag);
      fm.on("contextmenu", function (event, f) {
        event.preventDefault();
        event.stopPropagation();
        const rect = wrapperRef.current?.getBoundingClientRect();
        setMenu({
          kind: "file",
          id: f.id,
          x: (event as MouseEvent).clientX - (rect?.left ?? 0),
          y: (event as MouseEvent).clientY - (rect?.top ?? 0),
        });
      });
      return;
    }

    const byId = buildById(nodes);
    const onPath = pathIdSet(activeNodeId, byId);
    const forceLayout = forceLayoutRef.current;

    const layout = d3.tree<TreeNode>().nodeSize([74, 120]);
    const root = layout(d3.hierarchy(nested, (d) => d.children));
    const allNodes = root.descendants();

    // D38: 평행이동 계산을 위해 "레이아웃 원좌표"를 먼저 보관(해석으로 d.x/d.y가 덮이기 전).
    const layoutPosOf = new Map<string, Pt>();
    allNodes.forEach((d) => layoutPosOf.set(d.data.data.id, { x: d.x, y: d.y }));

    // D36: provisional→real 교체 시 좌표 승계(점프 방지) + 전환 모션 대상 표시.
    let animateRealId: string | null = null;
    if (lastReplace && lastReplace.nonce !== processedReplaceNonceRef.current) {
      processedReplaceNonceRef.current = lastReplace.nonce;
      const tempPos = posRef.current.get(lastReplace.tempId);
      if (tempPos) {
        posRef.current.set(lastReplace.realId, { x: tempPos.x, y: tempPos.y });
        posRef.current.delete(lastReplace.tempId);
        // D52(보강): 승계한 real 좌표를 1회 영속(유효 UUID). 이전엔 캐시에만 남아
        // 새로고침 시 좌표가 풀리던 부수버그를 함께 해소.
        pr.current.onPersistPositions([
          { node_id: lastReplace.realId, x: tempPos.x, y: tempPos.y },
        ]);
      }
      animateRealId = lastReplace.realId;
    }

    // 좌표 해석: 재정렬 강제 시 레이아웃, 아니면 (드래그 캐시 → 저장 좌표 → 새 노드는 부모 평행이동)
    allNodes.forEach((d) => {
      const node = d.data.data;
      if (forceLayout) {
        posRef.current.set(node.id, { x: d.x, y: d.y });
        return;
      }
      const cached = posRef.current.get(node.id);
      if (cached) {
        d.x = cached.x;
        d.y = cached.y;
      } else if (node.position_x != null && node.position_y != null) {
        d.x = node.position_x;
        d.y = node.position_y;
        posRef.current.set(node.id, { x: d.x, y: d.y });
      } else {
        // D38: 새 노드(캐시·저장좌표 없음; provisional 포함) = 부모의 평행이동 적용.
        const pid = node.parent_id;
        const parentLayout = pid ? layoutPosOf.get(pid) : null;
        const parentPos = pid ? posRef.current.get(pid) : null;
        if (pid && parentLayout && parentPos) {
          const dx = parentPos.x - parentLayout.x;
          const dy = parentPos.y - parentLayout.y;
          d.x = d.x + dx;
          d.y = d.y + dy;
          posRef.current.set(node.id, { x: d.x, y: d.y });
          // provisional(임시 id)은 영속하지 않음; 실 노드만 좌표 영속.
          if (!node._provisional) {
            pr.current.onPersistPositions([
              { node_id: node.id, x: d.x, y: d.y },
            ]);
          }
        } else {
          posRef.current.set(node.id, { x: d.x, y: d.y });
        }
      }
    });

    const nodeById = new Map<string, HNode>();
    allNodes.forEach((n) => nodeById.set(n.data.data.id, n));

    if (forceLayout) {
      forceLayoutRef.current = false;
      // D52(소스 가드): provisional 노드는 영속에서 제외(api.ts 싱크 가드와 이중 방어).
      pr.current.onPersistPositions(
        allNodes
          .filter((d) => !d.data.data._provisional)
          .map((d) => ({ node_id: d.data.data.id, x: d.x, y: d.y })),
      );
    }

    // 파일 노드 좌표(저장 좌표 우선, 없으면 current_head 근처)
    const headPos = activeNodeId ? posRef.current.get(activeNodeId) : null;
    fileNodes.forEach((f, i) => {
      if (filePosRef.current.has(f.id)) return;
      if (f.position_x != null && f.position_y != null) {
        filePosRef.current.set(f.id, { x: f.position_x, y: f.position_y });
      } else {
        const base = headPos ?? { x: 0, y: 60 };
        filePosRef.current.set(f.id, {
          x: base.x + 90 + (i % 3) * 46,
          y: base.y + 40 + Math.floor(i / 3) * 46,
        });
      }
    });

    const linkGen = d3
      .linkVertical<d3.HierarchyPointLink<TreeNode>, HNode>()
      .x((d) => d.x)
      .y((d) => d.y);

    // ── 트리 링크 ──
    linkLayer
      .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
      .data(root.links(), (d) => d.target.data.data.id)
      .join(
        (enter) => enter.append("path").attr("class", "link").attr("fill", "none"),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr("stroke", (d) =>
        onPath.has(d.target.data.data.id) ? C.linkPath : C.linkNormal,
      )
      .attr("stroke-width", (d) => (onPath.has(d.target.data.data.id) ? 2.5 : 1.5))
      .attr("d", linkGen);

    const redrawLinks = () =>
      linkLayer
        .selectAll<SVGPathElement, d3.HierarchyPointLink<TreeNode>>("path.link")
        .attr("d", linkGen);

    // ── 기억 연결선 ──
    const connD = (sourceId: string, targetId: string): string => {
      const s = posRef.current.get(sourceId);
      const t = posRef.current.get(targetId);
      if (!s || !t) return "";
      const my = (s.y + t.y) / 2;
      return `M${s.x},${s.y} C${s.x},${my} ${t.x},${my} ${t.x},${t.y}`;
    };
    const redrawConnections = () =>
      connLayer.selectAll<SVGGElement, ConnPair>("g.conn").each(function (cp) {
        const path = connD(cp.source, cp.target);
        const sel = d3.select(this);
        sel.select<SVGPathElement>("path.conn-visible").attr("d", path);
        sel.select<SVGPathElement>("path.conn-hit").attr("d", path);
      });

    const connPairs: ConnPair[] = [];
    for (const n of nodes) {
      for (const src of n.connections ?? []) {
        if (src !== n.id && nodeById.has(src) && nodeById.has(n.id)) {
          connPairs.push({ source: src, target: n.id, key: `${n.id}<-${src}` });
        }
      }
    }
    const connSel = connLayer
      .selectAll<SVGGElement, ConnPair>("g.conn")
      .data(connPairs, (d) => d.key);
    connSel.exit().remove();
    const connEnter = connSel
      .enter()
      .append("g")
      .attr("class", "conn")
      .style("cursor", "pointer");
    connEnter.append("title").text("클릭하면 기억 연결 해제");
    connEnter
      .append("path")
      .attr("class", "conn-visible")
      .attr("fill", "none")
      .attr("stroke", C.conn)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "5 4")
      .attr("pointer-events", "none");
    connEnter
      .append("path")
      .attr("class", "conn-hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12);
    const connMerged = connEnter.merge(connSel);
    connMerged
      .select<SVGPathElement>("path.conn-visible")
      .attr("d", (d) => connD(d.source, d.target));
    connMerged
      .select<SVGPathElement>("path.conn-hit")
      .attr("d", (d) => connD(d.source, d.target))
      .on("click", function (event, d) {
        event.stopPropagation();
        pr.current.onRemoveConnection(d.target, d.source);
      });

    // ── 파일 연결선(파일 노드 ↔ target 분기 노드) ──
    const fileLinkD = (fileId: string, nodeId: string): string => {
      const f = filePosRef.current.get(fileId);
      const t = posRef.current.get(nodeId);
      if (!f || !t) return "";
      const my = (f.y + t.y) / 2;
      return `M${f.x},${f.y} C${f.x},${my} ${t.x},${my} ${t.x},${t.y}`;
    };
    const visibleLinks = fileLinks.filter(
      (l) => nodeById.has(l.target_node_id) && filePosRef.current.has(l.file_id),
    );
    const redrawFileLines = () =>
      connLayer.selectAll<SVGGElement, FileLink>("g.fileconn").each(function (l) {
        const path = fileLinkD(l.file_id, l.target_node_id);
        const sel = d3.select(this);
        sel.select<SVGPathElement>("path.fl-vis").attr("d", path);
        sel.select<SVGPathElement>("path.fl-hit").attr("d", path);
      });

    // D53②: 부모 드래그 시 회색 네비 버튼을 부모 현재좌표로 재배치(노드와 동일 프레임).
    const redrawNavBtns = (moved: Set<string>) =>
      navToggleLayer
        ?.selectAll<SVGGElement, { parentId: string }>("g.navbtn")
        .filter((b) => moved.has(b.parentId))
        .attr("transform", (b) => {
          const p = posRef.current.get(b.parentId);
          return p ? `translate(${p.x + R + 6},${p.y + R + 6})` : "";
        });
    const flSel = connLayer
      .selectAll<SVGGElement, FileLink>("g.fileconn")
      .data(visibleLinks, (d) => `${d.file_id}->${d.target_node_id}`);
    flSel.exit().remove();
    const flEnter = flSel
      .enter()
      .append("g")
      .attr("class", "fileconn")
      .style("cursor", "pointer");
    flEnter.append("title").text("클릭하면 자료 연결 해제");
    flEnter
      .append("path")
      .attr("class", "fl-vis")
      .attr("fill", "none")
      .attr("stroke", C.file)
      .attr("stroke-width", 1.6)
      .attr("stroke-dasharray", "4 3")
      .attr("pointer-events", "none");
    flEnter
      .append("path")
      .attr("class", "fl-hit")
      .attr("fill", "none")
      .attr("stroke", "transparent")
      .attr("stroke-width", 12);
    const flMerged = flEnter.merge(flSel);
    // D31: provisional(_pending) 링크는 흐리고(0.45) 살짝 더 점선으로 즉시 렌더,
    // 확정(서버 응답)되면 선명(1.0)·해제 클릭 가능으로 전환.
    flMerged
      .select<SVGPathElement>("path.fl-vis")
      .attr("d", (l) => fileLinkD(l.file_id, l.target_node_id))
      .attr("stroke-opacity", (l) => (l._pending ? PENDING_LINK_OPACITY : 1))
      .attr("stroke-dasharray", (l) =>
        l._pending ? PENDING_LINK_DASH : SOLID_LINK_DASH,
      );
    flMerged
      .select<SVGPathElement>("path.fl-hit")
      .attr("d", (l) => fileLinkD(l.file_id, l.target_node_id))
      .attr("pointer-events", (l) => (l._pending ? "none" : null))
      .style("cursor", (l) => (l._pending ? "default" : "pointer"))
      .on("click", function (event, l) {
        if (l._pending) return; // 확정 전에는 해제 불가
        event.stopPropagation();
        pr.current.onRemoveFileLink(l.file_id, l.target_node_id);
      });

    // D44: 좌클릭 탭 활성화(파일링크/참조/포커스·네비게이터 팝업). 연결모드는 드래그가
    //      비활성이라 네이티브 click(아래)이 처리하므로 여기선 일반 동작만 다룬다.
    const activateNodeTap = (d: HNode) => {
      const node = d.data.data;
      if (node._provisional) return;
      const P = pr.current;
      if (P.fileLinkMode) {
        if (!node.is_navigator) P.onLinkTarget(node.id);
        return;
      }
      if (P.trackMode) {
        if (node.id === P.activeNodeId) return;
        const isLeaf = !nodes.some(
          (c) => c.parent_id === node.id && !c.is_navigator,
        );
        if (isLeaf && !node.is_navigator) P.onToggleTrack(node.id);
        return;
      }
      // 일반/네비게이터: WorkspaceInner가 네비게이터면 팝업 오픈(D40), 아니면 포커스 이동.
      P.onNodeClick(node.id);
    };

    // ── 드래그(대화 노드, 서브트리 동반 + y 제약 + 좌표 영속) ──
    // D44: clickDistance(6) — 미세 지터를 클릭으로 허용(첫 탭 삼킴 방지).
    const drag = d3
      .drag<SVGGElement, HNode>()
      .clickDistance(6)
      .filter(
        (event) =>
          (event as MouseEvent).button === 0 &&
          !connectingRef.current &&
          !connectingFileRef.current,
      )
      .on("start", function (event, d) {
        event.sourceEvent.stopPropagation();
        const s = d as unknown as { _moved: boolean; _dist: number };
        s._moved = false;
        s._dist = 0;
        d3.select(this).raise();
      })
      .on("drag", function (event, d) {
        const s = d as unknown as { _moved: boolean; _dist: number };
        s._dist += Math.hypot(event.dx, event.dy);
        if (!s._moved && s._dist < 4) return;
        s._moved = true;
        const cur = posRef.current.get(d.data.data.id);
        if (!cur) return;
        const newX = cur.x + event.dx;
        let newY = cur.y + event.dy;
        if (d.parent) {
          const pPos = posRef.current.get(d.parent.data.data.id);
          if (pPos) newY = Math.max(newY, pPos.y + MIN_CHILD_Y_GAP);
        }
        const dX = newX - cur.x;
        const dY = newY - cur.y;
        if (dX === 0 && dY === 0) return;
        const subtreeIds = d.descendants().map((n) => n.data.data.id);
        for (const id of subtreeIds) {
          const p = posRef.current.get(id);
          if (!p) continue;
          const np = { x: p.x + dX, y: p.y + dY };
          posRef.current.set(id, np);
          const hn = nodeById.get(id);
          if (hn) {
            hn.x = np.x;
            hn.y = np.y;
          }
        }
        const movedSet = new Set(subtreeIds);
        nodeLayer
          .selectAll<SVGGElement, HNode>("g.node")
          .filter((n) => movedSet.has(n.data.data.id))
          .attr("transform", (n) => {
            const p = posRef.current.get(n.data.data.id)!;
            return `translate(${p.x},${p.y})`;
          });
        redrawLinks();
        redrawConnections();
        redrawFileLines();
        redrawNavBtns(movedSet);
      })
      .on("end", function (event, d) {
        const s = d as unknown as { _moved?: boolean };
        if (s._moved) {
          // 이동: 서브트리 좌표 영속.
          // D52(소스 가드): provisional 노드는 영속에서 제외(api.ts 싱크 가드와 이중 방어).
          const subtreeIds = d
            .descendants()
            .filter((n) => !n.data.data._provisional)
            .map((n) => n.data.data.id);
          debouncedPersist(
            subtreeIds
              .map((id) => {
                const p = posRef.current.get(id);
                return p ? { node_id: id, x: p.x, y: p.y } : null;
              })
              .filter((v): v is { node_id: string; x: number; y: number } => !!v),
          );
          return;
        }
        // D44: 이동이 거의 없으면 탭(클릭) = 활성화. 네이티브 click 의존 제거.
        // 우클릭/터치 sourceEvent는 제외(좌클릭/포인터 탭만).
        const se = event.sourceEvent as { type?: string } | undefined;
        if (se?.type && String(se.type).startsWith("touch")) return;
        activateNodeTap(d);
      });

    // ── 대화 노드 ──
    const sel = nodeLayer
      .selectAll<SVGGElement, HNode>("g.node")
      .data(allNodes, (d) => d.data.data.id);
    // D40: 사라지는 노드(숨겨진 네비게이터 등)는 부모로 흡수(translate+fade) 후 제거.
    //      단, provisional은 같은 자리에 real이 들어오므로 즉시 제거(중복 방지).
    sel.exit<HNode>().each(function (d) {
      const dd = d.data.data;
      const self = d3.select(this);
      if (dd._provisional) {
        self.remove();
        return;
      }
      const pid = dd.parent_id;
      const pp = pid ? posRef.current.get(pid) : null;
      if (pp) {
        self
          .transition()
          .duration(260)
          .attr("transform", `translate(${pp.x},${pp.y})`)
          .style("opacity", 0)
          .remove();
      } else {
        self.remove();
      }
    });
    const enter = sel
      .enter()
      .append("g")
      .attr("class", "node")
      .style("cursor", "pointer");
    const enteringNavIds = new Set<string>();
    enter.each((d) => {
      if (d.data.data.is_navigator) enteringNavIds.add(d.data.data.id);
    });
    enter.append("circle").attr("class", "hit").attr("r", R + 10).attr("fill", "transparent");
    enter.append("circle").attr("class", "refring").attr("fill", "none"); // D46
    enter.append("circle").attr("class", "halo").attr("fill", "none");
    enter.append("circle").attr("class", "core").attr("r", R).attr("stroke-width", 2);
    enter
      .append("text")
      .attr("class", "label")
      .attr("dy", "2.3em")
      .attr("text-anchor", "middle")
      .style("font-size", "11px")
      .style("font-family", "var(--font-sans), sans-serif")
      .style("pointer-events", "none");
    const tbadge = enter.append("g").attr("class", "trackbadge").style("display", "none");
    tbadge.append("circle").attr("cx", R + 5).attr("cy", -(R + 5)).attr("r", 8);
    tbadge
      .append("text")
      .attr("class", "tb-text")
      .attr("x", R + 5)
      .attr("y", -(R + 5))
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .style("font-size", "10px")
      .style("font-weight", "700")
      .attr("fill", "#fff");
    enter.append("title").attr("class", "tip");

    // D40: 새로 펼쳐지는/생성되는 네비게이터는 부모 좌표에서 솟아나는 모션(재펼침/생성).
    enter
      .filter((d) => enteringNavIds.has(d.data.data.id))
      .each(function (d) {
        const pid = d.data.data.parent_id;
        const pp = pid ? posRef.current.get(pid) : null;
        if (pp)
          d3.select(this)
            .attr("transform", `translate(${pp.x},${pp.y})`)
            .style("opacity", 0);
      });

    const merged = enter.merge(sel);
    // 흡수/재펼침 모션 대상(entering nav)을 제외하고 즉시 위치 지정.
    merged
      .filter((d) => !enteringNavIds.has(d.data.data.id))
      .attr("transform", (d) => `translate(${d.x},${d.y})`);
    // entering nav는 부모 → 제자리로 transition.
    enter
      .filter((d) => enteringNavIds.has(d.data.data.id))
      .transition()
      .duration(260)
      .attr("transform", (d) => `translate(${d.x},${d.y})`)
      .style("opacity", 1);

    const effectiveTracks = trackMode
      ? Array.from(
          new Set(
            [activeNodeId, ...selectedTrackIds].filter(Boolean) as string[],
          ),
        )
      : [];

    // D46: 참조모드에서 참조 가능한 leaf 실노드(자식 없는 비네비) 집합.
    const referenceableIds = new Set<string>();
    if (trackMode) {
      for (const n of displayNodes) {
        if (n.is_navigator) continue;
        const hasRealKid = nodes.some(
          (c) => c.parent_id === n.id && !c.is_navigator,
        );
        if (!hasRealKid) referenceableIds.add(n.id);
      }
    }

    merged.each(function (d) {
      const node = d.data.data;
      const g = d3.select(this);
      const isPath = onPath.has(node.id);
      const isActive = node.id === activeNodeId;
      const isNav = node.is_navigator;
      const isProv = !!node._provisional;
      const isAnimReal = node.id === animateRealId;
      const enteringNav = enteringNavIds.has(node.id);

      const core = g.select<SVGCircleElement>("circle.core");
      core
        .attr("fill", isNav ? C.navFill : isProv ? C.provFill : C.nodeFill)
        .attr("stroke", isNav ? C.navStroke : isPath ? C.pathStroke : C.nodeStroke)
        .attr("stroke-width", isPath ? 3 : 2);
      if (isAnimReal) {
        // D36: provisional 룩(점선)에서 실선으로 부드럽게 전환.
        core
          .interrupt()
          .attr("stroke-dasharray", PENDING_NODE_DASH)
          .transition()
          .duration(SETTLE_TRANSITION_MS)
          .attr("stroke-dasharray", null);
      } else {
        core.attr(
          "stroke-dasharray",
          isNav || isProv ? PENDING_NODE_DASH : null,
        );
      }

      // 그룹 투명도: provisional=0.4, 교체 직후 0.4→1 transition, entering nav는 모션이 처리.
      if (isProv) {
        g.interrupt().style("opacity", PENDING_NODE_OPACITY);
      } else if (isAnimReal) {
        g.interrupt()
          .style("opacity", PENDING_NODE_OPACITY)
          .transition()
          .duration(SETTLE_TRANSITION_MS)
          .style("opacity", 1);
      } else if (!enteringNav) {
        g.style("opacity", 1);
      }

      // D46: 참조 가능 leaf 하이라이트(은은한 청록 링). 선택분은 아래 track 배지 유지.
      const refring = g.select<SVGCircleElement>("circle.refring");
      const showRef =
        trackMode &&
        referenceableIds.has(node.id) &&
        node.id !== activeNodeId &&
        !effectiveTracks.includes(node.id);
      refring
        .attr("r", R + 4)
        .attr("stroke", C.refRing)
        .attr("stroke-width", 1.5)
        .attr("stroke-dasharray", "1 3")
        .attr("opacity", showRef ? 0.8 : 0);

      g.select<SVGCircleElement>("circle.halo")
        .attr("r", R + 5)
        .attr("stroke", C.pathStroke)
        .attr("stroke-width", 1.5)
        .attr("opacity", isActive ? 0.9 : 0)
        .attr("stroke-dasharray", "2 3");
      const label = node.label ?? node.navigator_question ?? node.question ?? "";
      g.select<SVGTextElement>("text.label")
        .text(label.length > 12 ? label.slice(0, 12) + "…" : label)
        .attr("fill", isNav ? C.labelMuted : isPath ? C.nodeLabel : C.labelMuted)
        .style("font-weight", isPath ? 600 : 400);

      const tIdx = effectiveTracks.indexOf(node.id);
      const tb = g.select<SVGGElement>("g.trackbadge");
      if (tIdx !== -1) {
        tb.style("display", null);
        tb.select("circle").attr("fill", TRACK_COLORS[tIdx % TRACK_COLORS.length]);
        tb.select("text.tb-text").text(String.fromCharCode(65 + tIdx));
      } else {
        tb.style("display", "none");
      }

      const tip = isNav
        ? `💡 ${node.navigator_question ?? ""}`
        : (node.question ?? "");
      g.select<SVGTitleElement>("title.tip").text(tip);
    });

    merged.call(drag);

    // D44: 일반 활성화는 drag.on("end") 탭이 담당(지터에 첫 클릭 삼킴 방지).
    //      네이티브 click은 *연결 모드*(드래그가 filter로 비활성)에서 타깃 선택만 처리.
    merged.on("click", function (event, d) {
      const node = d.data.data;
      const P = pr.current;
      if (node._provisional) return;
      if (connectingFileRef.current) {
        event.stopPropagation();
        const fid = connectingFileRef.current;
        if (!node.is_navigator) P.onConnectFileToNode(fid, node.id);
        setConnectingFileId(null);
        return;
      }
      if (connectingRef.current) {
        event.stopPropagation();
        const src = connectingRef.current;
        if (!node.is_navigator && isValidConnectTarget(src, node.id, byId)) {
          P.onConnectNodes(src, node.id);
        }
        setConnectingSourceId(null);
        return;
      }
      // 연결모드가 아니면 drag-end 탭이 처리 → 여기선 무시.
    });

    merged.on("contextmenu", function (event, d) {
      event.preventDefault();
      event.stopPropagation();
      const rect = wrapperRef.current?.getBoundingClientRect();
      setMenu({
        kind: "node",
        id: d.data.data.id,
        x: (event as MouseEvent).clientX - (rect?.left ?? 0),
        y: (event as MouseEvent).clientY - (rect?.top ?? 0),
      });
    });

    // ── 파일 노드(문서) ──
    const fileDrag = d3
      .drag<SVGGElement, FileRow>()
      .on("start", function (event) {
        event.sourceEvent.stopPropagation();
        d3.select(this).raise();
      })
      .on("drag", function (event, f) {
        const p = filePosRef.current.get(f.id);
        if (!p) return;
        const np = { x: p.x + event.dx, y: p.y + event.dy };
        filePosRef.current.set(f.id, np);
        d3.select(this).attr("transform", `translate(${np.x},${np.y})`);
        redrawFileLines();
      })
      .on("end", function (_event, f) {
        const p = filePosRef.current.get(f.id);
        if (p) pr.current.onFilePosition(f.id, p.x, p.y);
      });

    const fsel = fileLayer
      .selectAll<SVGGElement, FileRow>("g.filenode")
      .data(fileNodes, (d) => d.id);
    fsel.exit().remove();
    const fenter = fsel
      .enter()
      .append("g")
      .attr("class", "filenode")
      .style("cursor", "grab");
    fenter
      .append("rect")
      .attr("class", "fbox")
      .attr("x", -10)
      .attr("y", -12)
      .attr("width", 20)
      .attr("height", 24)
      .attr("rx", 3);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", -5).attr("x2", 5).attr("y2", -5);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 0).attr("x2", 5).attr("y2", 0);
    fenter.append("line").attr("class", "fl").attr("x1", -5).attr("y1", 5).attr("x2", 2).attr("y2", 5);
    fenter
      .append("text")
      .attr("class", "fname")
      .attr("dy", "2.4em")
      .attr("text-anchor", "middle")
      .style("font-size", "9px")
      .style("font-family", "var(--font-sans), sans-serif")
      .style("pointer-events", "none")
      .attr("fill", C.file);
    fenter.append("title");

    const fmerged = fenter.merge(fsel);
    fmerged.each(function (f) {
      const p = filePosRef.current.get(f.id);
      const s2 = d3.select(this);
      if (p) s2.attr("transform", `translate(${p.x},${p.y})`);
      const busy = f.status !== "indexed" && f.status !== "needs_key";
      const fail = f.status === "failed" || f.status === "partial";
      const stroke = fail ? C.fileFail : busy ? C.fileBusy : C.file;
      // 08 F: 낙관 배치(미확정)는 반투명 pending(서버 확정 시 1.0으로 실체화).
      s2.style("opacity", f._pending ? PENDING_NODE_OPACITY : 1);
      s2.select("rect.fbox").attr("fill", C.fileFill).attr("stroke", stroke).attr("stroke-width", 1.5);
      s2.selectAll("line.fl").attr("stroke", stroke).attr("stroke-width", 1);
      const nm =
        f.name ||
        f.filename ||
        (f.storage_path
          ? f.storage_path.split("/").pop() || f.storage_path
          : f.id.slice(0, 6));
      s2.select("text.fname").text(nm.length > 10 ? nm.slice(0, 10) + "…" : nm);
      const tg = fileTags[f.id];
      const tagLine = tg && tg.length > 0 ? `\n태그: ${tg.slice(0, 8).map((t) => "#" + t).join(" ")}` : "";
      s2.select("title").text(`📎 ${nm}${busy ? " (임베딩 중)" : ""}${f.status === "needs_key" ? " (API 키 필요 — 자료 검색 대기)" : ""}${tagLine}`);
    });
    fmerged.call(fileDrag);
    fmerged.on("contextmenu", function (event, f) {
      event.preventDefault();
      event.stopPropagation();
      const rect = wrapperRef.current?.getBoundingClientRect();
      setMenu({
        kind: "file",
        id: f.id,
        x: (event as MouseEvent).clientX - (rect?.left ?? 0),
        y: (event as MouseEvent).clientY - (rect?.top ?? 0),
      });
    });

    redrawFileLines();

    // ── D40/D53: 성숙한 부모의 네비게이터 토글 버튼(양방향) ──
    // D53①: collapse/expand 상태와 무관하게 "성숙한 부모"면 항상 렌더하고,
    //        collapsed 플래그로 모양·툴팁을 분기해 접기 어포던스를 항상 제공한다.
    interface NavBtn {
      parentId: string;
      count: number;
      collapsed: boolean;
    }
    const navBtns: NavBtn[] = [];
    // D51/D60: off면 버튼 자체 생략(숨긴 노드를 펼칠 진입점을 두지 않음).
    if (navigatorEnabled) {
      for (const [pid, count] of navChildCount) {
        if (count > 0 && hasRealChild.has(pid) && nodeById.has(pid)) {
          navBtns.push({ parentId: pid, count, collapsed: effCollapsed(pid) });
        }
      }
    }
    const nbSel = navToggleLayer!
      .selectAll<SVGGElement, NavBtn>("g.navbtn")
      .data(navBtns, (d) => d.parentId);
    nbSel.exit().remove();
    const nbEnter = nbSel
      .enter()
      .append("g")
      .attr("class", "navbtn")
      .style("cursor", "pointer");
    nbEnter.append("title");
    nbEnter
      .append("circle")
      .attr("class", "nb-circle")
      .attr("r", 9)
      .attr("stroke-width", 1.5);
    nbEnter
      .append("text")
      .attr("class", "nb-count")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "central")
      .style("font-size", "10px")
      .style("font-weight", "700")
      .style("pointer-events", "none")
      .attr("fill", "#fff");
    // 펼침 상태의 접기 어포던스(chevron-up). collapsed면 숨김.
    nbEnter
      .append("path")
      .attr("class", "nb-chevron")
      .attr("d", "M-4,2 L0,-2.5 L4,2")
      .attr("fill", "none")
      .attr("stroke", "#fff")
      .attr("stroke-width", 2)
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round")
      .style("pointer-events", "none");
    const nbMerged = nbEnter.merge(nbSel);
    nbMerged.each(function (b) {
      const pp = posRef.current.get(b.parentId);
      const sel2 = d3.select(this);
      if (pp) sel2.attr("transform", `translate(${pp.x + R + 6},${pp.y + R + 6})`);
      // collapsed: 채운 회색 원 + 개수 배지(펼치기). expanded: 윤곽 원 + chevron-up(접기).
      sel2
        .select("circle.nb-circle")
        .attr("fill", b.collapsed ? C.navCollapse : C.navFill)
        .attr("stroke", b.collapsed ? "#fff" : C.navCollapse);
      const countEl = sel2.select("text.nb-count").text(String(b.count));
      const chevEl = sel2
        .select("path.nb-chevron")
        .attr("stroke", b.collapsed ? "#fff" : C.navCollapse);
      countEl.style("display", b.collapsed ? "inline" : "none");
      chevEl.style("display", b.collapsed ? "none" : "inline");
      sel2
        .select("title")
        .text(
          b.collapsed
            ? `추천 질문 ${b.count}개 — 클릭하면 펼칩니다`
            : "추천 질문 접기",
        );
    });
    nbMerged.on("click", function (event, b) {
      event.stopPropagation();
      // 성숙한 부모 기본(collapse 휴리스틱=true) 기준으로 양방향 토글.
      toggleNavParent(b.parentId, true);
    });
  }, [
    nodes,
    activeNodeId,
    rootNodeId,
    dim.width,
    dim.height,
    fileLinks,
    fileNodes,
    fileTags,
    trackMode,
    selectedTrackIds,
    reorderNonce,
    lastReplace,
    collapsedNavParents,
    expandedNavParents,
    toggleNavParent,
    navigatorEnabled,
  ]);

  // ── 마우스 추적 연결선(D14 기억연결 / D22 자료연결) ──
  useEffect(() => {
    const layer = tempGRef.current;
    if (!layer) return;
    // 기억연결(주황, 대화 노드 출발) 또는 자료연결(청록, 파일 노드 출발)
    const src = connectingSourceId
      ? posRef.current.get(connectingSourceId)
      : connectingFileId
        ? filePosRef.current.get(connectingFileId)
        : null;
    if (!src) {
      layer.selectAll("*").remove();
      return;
    }
    const color = connectingFileId ? C.file : C.conn;
    layer.selectAll("*").remove();
    const path = layer
      .append("path")
      .attr("fill", "none")
      .attr("stroke", color)
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", "5 4")
      .attr("pointer-events", "none");
    const onMove = (e: MouseEvent) => {
      const p = toGraph(e.clientX, e.clientY);
      const my = (src.y + p.y) / 2;
      path.attr("d", `M${src.x},${src.y} C${src.x},${my} ${p.x},${my} ${p.x},${p.y}`);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      layer.selectAll("*").remove();
    };
  }, [connectingSourceId, connectingFileId]);

  // Esc로 모드 취소
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setConnectingSourceId(null);
        setConnectingFileId(null);
        setMenu(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleReorder = () => {
    forceLayoutRef.current = true;
    posRef.current = new Map();
    setReorderNonce((n) => n + 1);
  };

  // ── 드래그&드롭(D16 OS 업로드 + D58 좌측 목록→그래프 배치) ──
  const onDragOver = (e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    // D58: 내부 자료 드래그(좌측 목록) 또는 OS 파일 드롭 둘 다 드롭 허용.
    if (
      types.includes("application/x-nodi-file") ||
      types.includes("Files")
    ) {
      e.preventDefault();
      if (types.includes("Files") && !dropActive) setDropActive(true);
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDropActive(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    const p = toGraph(e.clientX, e.clientY);
    // D58: 내부 자료 드래그면 OS 업로드 대신 placement 생성(드롭 그래프 좌표).
    const internalFileId = e.dataTransfer.getData("application/x-nodi-file");
    if (internalFileId) {
      pr.current.onPlaceFile(internalFileId, p.x, p.y);
      return;
    }
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    pr.current.onDropUpload(files, p.x, p.y);
  };

  const menuNode =
    menu?.kind === "node" ? nodes.find((n) => n.id === menu.id) : null;
  const menuFile =
    menu?.kind === "file" ? fileNodes.find((f) => f.id === menu.id) : null;

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full overflow-hidden bg-bg-elevated"
      style={{ touchAction: "none" }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <svg ref={svgRef} className="block h-full w-full" />

      {dropActive && (
        <div className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-[#2a7d7a] bg-[#2a7d7a]/10 text-sm font-medium text-[#2a7d7a]">
          <Upload size={16} className="mr-1.5" /> 파일을 놓으면 자료로 업로드됩니다
        </div>
      )}

      {connectingSourceId && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-warning/60 bg-bg px-3 py-1.5 text-xs text-warning shadow">
          기억 연결: 다른 분기의 노드를 클릭하세요. (배경 클릭·Esc=취소)
        </div>
      )}
      {trackMode && !connectingSourceId && (
        <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border border-accent-deep/60 bg-bg px-3 py-1.5 text-xs text-accent-deep shadow">
          브랜치 참조: 비교할 leaf 노드를 클릭해 선택하세요.
        </div>
      )}
      {connectingFileId && (
        <div
          className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow"
          style={{ borderColor: C.file, color: C.file, background: "var(--bg)" }}
        >
          📎 자료 연결(RAG): 이 자료를 참고할 분기 노드를 클릭하세요. (배경·Esc=취소)
        </div>
      )}
      {fileLinkMode && !connectingSourceId && !connectingFileId && !trackMode && (
        <div
          className="absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full border px-3 py-1.5 text-xs shadow"
          style={{ borderColor: C.file, color: C.file, background: "var(--bg)" }}
        >
          📎 자료를 연결할 분기 노드를 클릭하세요.
        </div>
      )}

      <div className="absolute bottom-3 right-3 flex gap-1.5">
        <button
          type="button"
          onClick={handleReorder}
          title="노드 재정렬 (자동 레이아웃 재계산)"
          className="rounded-lg border border-accent-border/50 bg-bg p-2 text-fg-muted shadow-sm transition-colors hover:text-fg"
        >
          <LayoutGrid size={16} />
        </button>
        <button
          type="button"
          onClick={() => recenter(activeNodeId)}
          title="현재 노드로 이동"
          className="rounded-lg border border-accent-border/50 bg-bg p-2 text-fg-muted shadow-sm transition-colors hover:text-fg"
        >
          <LocateFixed size={16} />
        </button>
      </div>

      {/* 대화 노드 컨텍스트 메뉴 */}
      {menu && menuNode && !menuNode.is_navigator && (
        <div
          className="absolute z-30 w-48 overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated py-1 text-sm shadow-lg"
          style={{ left: Math.min(menu.x, (dim.width || 9999) - 200), top: menu.y }}
        >
          <button
            type="button"
            onClick={() => {
              pr.current.onNodeClick(menu.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <LocateFixed size={13} /> 이 노드로 이동
          </button>
          <button
            type="button"
            onClick={() => {
              setConnectingFileId(null);
              setConnectingSourceId(menu.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <GitFork size={13} /> 기억 연결
          </button>
          <button
            type="button"
            onClick={() => {
              pr.current.onEnterTrack(menu.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <Layers size={13} /> 브랜치 참조에 추가
          </button>
        </div>
      )}

      {/* 파일 노드 컨텍스트 메뉴 (D22) */}
      {menu && menuFile && (
        <div
          className="absolute z-30 w-44 overflow-hidden rounded-lg border border-accent-border/50 bg-bg-elevated py-1 text-sm shadow-lg"
          style={{ left: Math.min(menu.x, (dim.width || 9999) - 190), top: menu.y }}
        >
          <button
            type="button"
            onClick={() => {
              setConnectingSourceId(null);
              setConnectingFileId(menu.id);
              setMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <Link2 size={13} style={{ color: C.file }} /> 자료 연결
          </button>
          <button
            type="button"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              pr.current.onRemoveFromGraph(id);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg hover:bg-accent/30"
          >
            <EyeOff size={13} /> 그래프에서 제거
          </button>
          <button
            type="button"
            onClick={() => {
              const id = menu.id;
              setMenu(null);
              pr.current.onDeleteFile(id);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-danger/10"
          >
            <Trash2 size={13} /> 자료 삭제
          </button>
        </div>
      )}
    </div>
  );
}
