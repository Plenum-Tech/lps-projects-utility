import { useRef, useState, type DragEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import type { IconType } from "react-icons";
import {
  LuCircleAlert,
  LuDownload,
  LuFile,
  LuFileArchive,
  LuFileImage,
  LuFileSpreadsheet,
  LuFileText,
  LuLoaderCircle,
  LuPaperclip,
  LuRefreshCw,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  downloadTaskFile,
  useDeleteTaskFile,
  useTaskFiles,
  useUploadTaskFiles,
} from "@/hooks/use-tasks";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { formatFileSize } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { Role, Subtask, TaskFile } from "@/types";

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_FILES_PER_TASK = 20;
export const MAX_PER_REQUEST = 10;
const ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "txt", "csv", "zip",
];
export const ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

/** Splits picked files into allowed ones and human-readable rejections (type/size). */
export function validateUploads(picked: File[]): { accepted: File[]; rejected: string[] } {
  const rejected: string[] = [];
  const accepted = picked.filter((file) => {
    if (!ALLOWED_EXTENSIONS.includes(extensionOf(file.name))) {
      rejected.push(`${file.name}: file type not allowed`);
      return false;
    }
    if (file.size > MAX_FILE_SIZE) {
      rejected.push(`${file.name}: larger than 10 MB`);
      return false;
    }
    return true;
  });
  return { accepted, rejected };
}

function iconFor(file: TaskFile): IconType {
  const ext = extensionOf(file.filename);
  if (file.mimeType.startsWith("image/")) return LuFileImage;
  if (["xls", "xlsx", "csv"].includes(ext)) return LuFileSpreadsheet;
  if (ext === "zip") return LuFileArchive;
  if (["pdf", "doc", "docx", "txt", "ppt", "pptx"].includes(ext)) return LuFileText;
  return LuFile;
}

/**
 * Attachments: drag-and-drop upload zone + list with download/delete, grouped
 * into task files and one group per subtask.
 */
export function TaskFiles({
  taskId,
  me,
  canManageAll,
  subtasks = [],
}: {
  taskId: string;
  me: { _id: string; role: Role };
  /** Creator/admin may delete anyone's file. */
  canManageAll: boolean;
  /** For "Subtask: {title}" group headings. */
  subtasks?: Subtask[];
}) {
  const files = useTaskFiles(taskId);
  const upload = useUploadTaskFiles(taskId);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const existing = files.data?.total ?? files.data?.files.length ?? 0;

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const { accepted, rejected } = validateUploads(Array.from(list));
    if (rejected.length) toast.warning(rejected.join(" · "));

    const room = MAX_FILES_PER_TASK - existing;
    if (accepted.length > room) {
      toast.warning(`A task can hold ${MAX_FILES_PER_TASK} files — ${Math.max(room, 0)} more allowed.`);
    }
    const batch = accepted.slice(0, Math.min(room, MAX_PER_REQUEST));
    if (batch.length === 0) return;

    setProgress(0);
    upload.mutate(
      { files: batch, onProgress: setProgress },
      { onSettled: () => setProgress(null) }
    );
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!upload.isPending) handleFiles(event.dataTransfer.files);
  }

  const full = existing >= MAX_FILES_PER_TASK;

  return (
    <div className="space-y-4">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!full) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center transition-colors duration-150 ease-out",
          dragOver ? "border-ring bg-primary/5" : "bg-muted/30",
          full && "opacity-60"
        )}
      >
        {upload.isPending ? (
          <>
            <LuLoaderCircle aria-hidden className="size-5 animate-spin text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">Uploading… {progress ?? 0}%</p>
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full bg-primary transition-[width] duration-150"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <span className="flex size-9 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
              <LuUpload aria-hidden className="size-4" />
            </span>
            <p className="text-sm text-foreground">
              {full ? (
                "This task has reached the 20-file limit."
              ) : (
                <>
                  Drag files here or{" "}
                  <button
                    type="button"
                    className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                    onClick={() => inputRef.current?.click()}
                  >
                    browse
                  </button>
                </>
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              Images, PDF, Office docs, TXT, CSV or ZIP · up to 10 MB each
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-label="Upload files"
          onChange={(event) => {
            handleFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>

      {files.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading files">
          {Array.from({ length: 2 }).map((_, index) => (
            <Skeleton key={index} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : files.isError ? (
        <Alert variant="destructive">
          <LuCircleAlert aria-hidden className="size-4" />
          <AlertTitle>Couldn&apos;t load files</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {getErrorMessage(files.error)}
            <Button variant="outline" size="sm" onClick={() => void files.refetch()}>
              <LuRefreshCw aria-hidden />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : (files.data?.files.length ?? 0) === 0 ? (
        <p className="flex items-center justify-center gap-2 py-2 text-sm text-muted-foreground">
          <LuPaperclip aria-hidden className="size-4" />
          No attachments yet.
        </p>
      ) : (
        <div className="space-y-4">
          {groupFiles(files.data?.files ?? [], subtasks).map((group) => (
            <section key={group.key} aria-label={group.label} className="space-y-1.5">
              <h4 className="truncate text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
                <span className="ml-1.5 tabular-nums normal-case">({group.files.length})</span>
              </h4>
              <ul className="divide-y rounded-lg border">
                {group.files.map((file) => (
                  <FileRow
                    key={file._id}
                    taskId={taskId}
                    file={file}
                    canDelete={canManageAll || file.uploadedBy?._id === me._id}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Task files" first, then one group per subtask (in subtask order). */
function groupFiles(files: TaskFile[], subtasks: Subtask[]) {
  const groups: Array<{ key: string; label: string; files: TaskFile[] }> = [];
  const taskFiles = files.filter((file) => !file.subtask);
  if (taskFiles.length) groups.push({ key: "task", label: "Task files", files: taskFiles });
  const order = new Map(subtasks.map((sub, index) => [sub._id, index]));
  const bySubtask = new Map<string, TaskFile[]>();
  for (const file of files) {
    if (!file.subtask) continue;
    bySubtask.set(file.subtask, [...(bySubtask.get(file.subtask) ?? []), file]);
  }
  const ids = [...bySubtask.keys()].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  for (const id of ids) {
    const title = subtasks.find((sub) => sub._id === id)?.title ?? "Removed subtask";
    groups.push({ key: id, label: `Subtask: ${title}`, files: bySubtask.get(id)! });
  }
  return groups;
}

export function FileRow({
  taskId,
  file,
  canDelete,
}: {
  taskId: string;
  file: TaskFile;
  canDelete: boolean;
}) {
  const remove = useDeleteTaskFile(taskId);
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const Icon = iconFor(file);

  async function download() {
    setDownloading(true);
    try {
      await downloadTaskFile(taskId, file);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Icon aria-hidden className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={file.filename}>
          {file.filename}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {formatFileSize(file.size)} · {file.uploadedBy?.name ?? "Unknown"} ·{" "}
          {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void download()}
        disabled={downloading}
        aria-label={`Download ${file.filename}`}
      >
        {downloading ? (
          <LuLoaderCircle aria-hidden className="animate-spin" />
        ) : (
          <LuDownload aria-hidden />
        )}
      </Button>
      {canDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => remove.mutate(file._id)}
          disabled={remove.isPending}
          aria-label={`Delete ${file.filename}`}
        >
          {remove.isPending ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <LuTrash2 aria-hidden />
          )}
        </Button>
      )}
    </li>
  );
}
