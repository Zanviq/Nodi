"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Plus,
  Trash2,
  RotateCcw,
  KeyRound,
} from "lucide-react";
import { ApiError, deleteFile, retryFile, type SpaceTarget } from "@/lib/api";
import { filesKey, useFileTags, useFiles } from "@/lib/queries";
import { SkeletonList } from "@/components/ui/Skeleton";
import type { FileLink, FileRow, FileStatus } from "@/lib/types";
import {
  isGeminiKeyError,
  openGeminiKeyDialog,
  useHasGeminiKey,
} from "@/lib/geminiKey";

/**
 * 워크스페이스 좌측 "자료" 패널.
 * 업로드(PDF·txt·이미지 OCR) + 목록 + 진행률 + 태그 + 삭제/재시도 + 분기 연결(시각적 RAG).
 */
const UPLOAD_ACCEPT =
  ".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,image/*";

function formatBytes(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fileName(f: FileRow): string {
  return (
    f.name ||
    f.filename ||
    (f.storage_path ? f.storage_path.split("/").pop() || f.storage_path : "") ||
    f.id
  );
}

const STATUS_META: Record<
  FileStatus,
  { label: string; cls: string; progress: boolean }
> = {
  uploaded: { label: "대기", cls: "bg-accent/40 text-accent-fg", progress: true },
  splitting: { label: "분할 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  embedding: { label: "임베딩 중", cls: "bg-accent/40 text-accent-fg", progress: true },
  indexed: { label: "완료", cls: "bg-positive/20 text-positive", progress: false },
  partial: { label: "부분 실패", cls: "bg-warning/20 text-warning", progress: false },
  failed: { label: "실패", cls: "bg-danger/20 text-danger", progress: false },
  needs_key: { label: "키 필요", cls: "bg-accent/40 text-accent-fg", progress: false },
};

export function FilesPanel({
  target,
  fileLinks,
  onAddToGraph,
  onRefresh,
  onUpload,
}: {
  target: SpaceTarget;
  fileLinks: FileLink[];
  /** D58: 자료를 현재 세션 그래프에 노드로 추가(placement). */
  onAddToGraph: (fileId: string) => void;
  onRefresh?: () => void;
  /** D22: 업로드는 현재 세션 id를 붙여 처리(WorkspaceInner). */
  onUpload: (file: File) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const { data: files, isLoading } = useFiles(target);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: filesKey(target) });
    onRefresh?.();
  };

  const handleFiles = async (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await onUpload(file);
      refresh();
    } catch (e) {
      reportError(e, "업로드");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const reportError = (e: unknown, what: string) => {
    if (e instanceof ApiError && isGeminiKeyError(e.code)) {
      setError(e.message);
      openGeminiKeyDialog(e.message);
    } else {
      setError(`${what} 실패: ${(e as Error).message}`);
    }
  };

  const handleDelete = async (fileId: string) => {
    if (!window.confirm("이 자료를 삭제할까요?")) return;
    setError(null);
    try {
      await deleteFile(fileId);
      refresh();
    } catch (e) {
      reportError(e, "삭제");
    }
  };

  const handleRetry = async (fileId: string) => {
    setError(null);
    try {
      await retryFile(fileId);
      refresh();
    } catch (e) {
      reportError(e, "재시도");
    }
  };

  return (
    <section className="flex max-h-[40%] shrink-0 flex-col border-t border-accent-border/30">
      <div className="flex items-center justify-between px-4 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          자료
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          title="파일 업로드 (PDF·txt·이미지)"
          className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-2 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          <Upload size={13} />
          {uploading ? "업로드 중…" : "업로드"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={UPLOAD_ACCEPT}
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {error && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {isLoading ? (
          <SkeletonList rows={3} className="px-1 py-1" />
        ) : !files || files.length === 0 ? (
          <p className="px-2 py-2 text-xs text-fg-muted">
            업로드한 자료가 없습니다.
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {files.map((f) => (
              <FileItem
                key={f.id}
                file={f}
                linkCount={fileLinks.filter((l) => l.file_id === f.id).length}
                onAddToGraph={() => onAddToGraph(f.id)}
                onDelete={() => handleDelete(f.id)}
                onRetry={() => handleRetry(f.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function FileItem({
  file,
  linkCount,
  onAddToGraph,
  onDelete,
  onRetry,
}: {
  file: FileRow;
  linkCount: number;
  onAddToGraph: () => void;
  onDelete: () => void;
  onRetry: () => void;
}) {
  const meta = STATUS_META[file.status] ?? STATUS_META.uploaded;
  const total = file.chunk_total ?? 0;
  const done = file.chunk_done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const hasKey = useHasGeminiKey();
  const needsKey = file.status === "needs_key";
  const canRetry =
    file.status === "failed" ||
    file.status === "partial" ||
    (needsKey && hasKey);

  const { data: tags } = useFileTags(file.id, file.status === "indexed");
  const shownTags = (tags ?? []).slice(0, 4);
  const moreTags = (tags?.length ?? 0) - shownTags.length;

  return (
    <li
      // D58: 목록 항목을 캔버스로 드래그하면 그 좌표에 그래프 노드(placement) 생성.
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-nodi-file", file.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title="그래프로 드래그해 추가할 수 있어요"
      className="cursor-grab rounded-lg border border-accent-border/30 bg-bg-elevated px-2.5 py-2 active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        {file.status === "indexed" ? (
          <CheckCircle2 size={14} className="shrink-0 text-positive" />
        ) : (
          <FileText size={14} className="shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={fileName(file)}>
          {fileName(file)}
        </span>
        <span
          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
        <button
          type="button"
          onClick={onDelete}
          title="삭제"
          className="shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:text-danger"
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2 pl-6 text-[11px] text-fg-muted">
        <span>{formatBytes(file.size_bytes)}</span>
        {file.mime && <span className="truncate">{file.mime}</span>}
        {meta.progress && total > 0 && (
          <span className="ml-auto tabular-nums">
            {done}/{total}
          </span>
        )}
      </div>

      {meta.progress && (
        <div className="mt-1 ml-6 h-1.5 overflow-hidden rounded-full bg-accent/20">
          <div
            className="h-full rounded-full bg-accent-deep transition-all"
            style={{ width: `${total > 0 ? pct : 8}%` }}
          />
        </div>
      )}

      {(file.status === "failed" || file.status === "partial") && file.error && (
        <p className="mt-1 ml-6 text-[11px] text-danger">{file.error}</p>
      )}

      {needsKey && (
        <p className="mt-1 ml-6 flex flex-wrap items-center gap-1 text-[11px] text-accent-fg">
          <KeyRound size={11} className="shrink-0 text-accent-deep" />
          {file.error === "gemini_key_invalid"
            ? "API 키가 거부되어 자료 검색(RAG)을 준비하지 못했어요. 키를 확인한 뒤 재시도하세요."
            : hasKey
              ? "API 키가 설정됐어요. 재시도하면 자료 검색(RAG)을 쓸 수 있어요."
              : "API 키를 설정하면 자료 검색(RAG)을 쓸 수 있어요."}
          {!hasKey && (
            <button
              type="button"
              onClick={() => openGeminiKeyDialog()}
              className="font-medium text-accent-deep underline"
            >
              키 입력
            </button>
          )}
        </p>
      )}

      {/* 태그 칩 */}
      {shownTags.length > 0 && (
        <div className="mt-1 ml-6 flex flex-wrap gap-1">
          {shownTags.map((t) => (
            <span
              key={t}
              className="rounded-full border border-accent-border/50 bg-accent/20 px-1.5 py-0.5 text-[10px] text-accent-fg"
            >
              #{t}
            </span>
          ))}
          {moreTags > 0 && (
            <span className="text-[10px] text-fg-muted">+{moreTags}</span>
          )}
        </div>
      )}

      {/* 액션: 그래프에 추가 / 재시도 */}
      <div className="mt-1.5 ml-6 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAddToGraph}
          title="현재 대화 그래프에 자료 노드로 추가(드래그도 가능)"
          className="flex items-center gap-1 rounded-md border border-[#2a7d7a]/50 px-2 py-0.5 text-[11px] font-medium text-[#2a7d7a] transition-colors hover:bg-[#2a7d7a]/10"
        >
          <Plus size={11} />
          그래프에 추가
        </button>
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            title="재처리"
            className="flex items-center gap-1 rounded-md border border-warning/50 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10"
          >
            <RotateCcw size={11} />
            재시도
          </button>
        )}
        {linkCount > 0 && (
          <span className="text-[11px] text-[#2a7d7a]">📎 {linkCount}곳</span>
        )}
      </div>
    </li>
  );
}
