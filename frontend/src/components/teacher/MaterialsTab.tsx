"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Info,
  KeyRound,
  RotateCcw,
} from "lucide-react";
import { ApiError, retryFile, uploadFile } from "@/lib/api";
import {
  isGeminiKeyError,
  openGeminiKeyDialog,
  useHasGeminiKey,
} from "@/lib/geminiKey";
import { classMaterialsKey, useClassMaterials } from "@/lib/queries";
import type { FileRow, FileStatus } from "@/lib/types";

/**
 * 자료 탭: 학급 자료실(class_material) 목록 + 업로드 + 임베딩 진행률.
 * 업로드한 자료는 학생들이 자기 학급 공간에서 RAG로 참고한다.
 */
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

export function MaterialsTab({ classId }: { classId: string }) {
  const queryClient = useQueryClient();
  const { data: materials, isLoading } = useClassMaterials(classId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFiles = async (list: FileList | null) => {
    const file = list?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      await uploadFile(
        { space_kind: "class", space_ref: classId },
        file,
        { kind: "class_material" },
      );
      await queryClient.invalidateQueries({
        queryKey: classMaterialsKey(classId),
      });
    } catch (e) {
      if (e instanceof ApiError && isGeminiKeyError(e.code)) {
        setError(e.message);
      } else {
        setError(`업로드 실패: ${(e as Error).message}`);
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRetry = async (fileId: string) => {
    setError(null);
    try {
      await retryFile(fileId);
    } catch (e) {
      if (e instanceof ApiError && isGeminiKeyError(e.code)) {
        setError(e.message);
        openGeminiKeyDialog(e.message);
      } else {
        setError(`재시도 실패: ${(e as Error).message}`);
      }
    }
    await queryClient.invalidateQueries({
      queryKey: classMaterialsKey(classId),
    });
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">학급 자료실</h2>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1 rounded-lg border border-accent-border bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg transition-colors hover:bg-accent-deep hover:text-white disabled:opacity-60"
        >
          <Upload size={14} />
          {uploading ? "업로드 중…" : "자료 업로드"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.webp,.gif,application/pdf,text/plain,image/*"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-accent-border/30 bg-bg-elevated px-3 py-2 text-xs text-fg-muted">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          업로드한 자료는 임베딩된 뒤 학생들이 자기 학급 공간의 대화에서 RAG로
          참고할 수 있습니다.
        </span>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-fg-muted">자료 불러오는 중…</p>
      ) : !materials || materials.length === 0 ? (
        <p className="rounded-lg border border-dashed border-accent-border/50 p-6 text-center text-sm text-fg-muted">
          업로드한 자료가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {materials.map((f) => (
            <MaterialItem
              key={f.id}
              file={f}
              onRetry={() => handleRetry(f.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function MaterialItem({
  file,
  onRetry,
}: {
  file: FileRow;
  onRetry: () => void;
}) {
  const meta = STATUS_META[file.status] ?? STATUS_META.uploaded;
  const hasKey = useHasGeminiKey();
  const needsKey = file.status === "needs_key";
  const canRetry =
    file.status === "failed" || file.status === "partial" || (needsKey && hasKey);
  const total = file.chunk_total ?? 0;
  const done = file.chunk_done ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <li className="rounded-lg border border-accent-border/30 bg-bg-elevated p-3">
      <div className="flex items-center gap-2">
        {file.status === "indexed" ? (
          <CheckCircle2 size={15} className="shrink-0 text-positive" />
        ) : (
          <FileText size={15} className="shrink-0 text-fg-muted" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm text-fg" title={fileName(file)}>
          {fileName(file)}
        </span>
        <span className="shrink-0 text-xs text-fg-muted">
          {formatBytes(file.size_bytes)}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${meta.cls}`}
        >
          {meta.label}
        </span>
      </div>

      {meta.progress && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent/20">
            <div
              className="h-full rounded-full bg-accent-deep transition-all"
              style={{ width: `${total > 0 ? pct : 8}%` }}
            />
          </div>
          {total > 0 && (
            <span className="shrink-0 text-[11px] tabular-nums text-fg-muted">
              {done}/{total}
            </span>
          )}
        </div>
      )}

      {(file.status === "failed" || file.status === "partial") && file.error && (
        <p className="mt-1 text-[11px] text-danger">{file.error}</p>
      )}

      {needsKey && (
        <p className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-accent-fg">
          <KeyRound size={11} className="shrink-0 text-accent-deep" />
          {file.error === "gemini_key_invalid"
            ? "API 키가 거부되어 자료 검색(RAG)을 준비하지 못했어요. 키를 확인한 뒤 재시도하세요."
            : "API 키를 설정하면 자료 검색(RAG)을 쓸 수 있어요. (자료는 저장되어 있어요)"}
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

      {canRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1.5 flex items-center gap-1 rounded-md border border-warning/50 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10"
        >
          <RotateCcw size={11} />
          재시도
        </button>
      )}
    </li>
  );
}
