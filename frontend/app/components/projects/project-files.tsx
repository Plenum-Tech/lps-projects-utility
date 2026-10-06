import { useRef, useState, type DragEvent } from "react";
import { formatDistanceToNow } from "date-fns";
import type { IconType } from "react-icons";
import {
  LuDownload,
  LuFile,
  LuFileArchive,
  LuFileImage,
  LuFileSpreadsheet,
  LuFileText,
  LuLoaderCircle,
  LuPaperclip,
  LuTrash2,
  LuUpload,
} from "react-icons/lu";

import { EmptyState, QueryError } from "@/components/globals/query-states";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  downloadProjectFile,
  useDeleteProjectFile,
  useProjectFiles,
  useUploadProjectFiles,
} from "@/hooks/use-projects";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { formatFileSize } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type { ProjectFile } from "@/types";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES_PER_PROJECT = 50;
const MAX_PER_REQUEST = 10;
const ALLOWED_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf", "doc", "docx", "xls", "xlsx",
  "ppt", "pptx", "txt", "csv", "zip",
];
const ACCEPT = ALLOWED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

function extensionOf(name: string) {
  return name.split(".").pop()?.toLowerCase() ?? "";
}

function iconFor(file: ProjectFile): IconType {
  const ext = extensionOf(file.filename);
  if (file.mimeType.startsWith("image/")) return LuFileImage;
  if (["xls", "xlsx", "csv"].includes(ext)) return LuFileSpreadsheet;
  if (ext === "zip") return LuFileArchive;
  if (["pdf", "doc", "docx", "txt", "ppt", "pptx"].includes(ext)) return LuFileText;
  return LuFile;
}

/** Files tab: drag-and-drop upload + list with download/delete. */
export function ProjectFiles({
  projectId,
  canUpload,
}: {
  projectId: string;
  canUpload: boolean;
}) {
  const files = useProjectFiles(projectId);
  const upload = useUploadProjectFiles(projectId);
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ProjectFile | null>(null);
  const existing = files.data?.length ?? 0;
  const full = existing >= MAX_FILES_PER_PROJECT;

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const rejected: string[] = [];
    const accepted = Array.from(list).filter((file) => {
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
    if (rejected.length) toast.warning(rejected.join(" · "));

    const room = MAX_FILES_PER_PROJECT - existing;
    if (accepted.length > room) {
      toast.warning(
        `A project can hold ${MAX_FILES_PER_PROJECT} files — ${Math.max(room, 0)} more allowed.`
      );
    }
    if (accepted.length > MAX_PER_REQUEST && room > MAX_PER_REQUEST) {
      toast.info(`Uploading the first ${MAX_PER_REQUEST} files — add the rest afterwards.`);
    }
    const batch = accepted.slice(0, Math.min(room, MAX_PER_REQUEST));
    if (batch.length === 0) return;

    setProgress(0);
    upload.mutate({ files: batch, onProgress: setProgress }, { onSettled: () => setProgress(null) });
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!upload.isPending && !full) handleFiles(event.dataTransfer.files);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-heading text-lg font-semibold">Files</h2>
        <p className="text-sm text-muted-foreground">
          Shared documents for everyone on the project ({existing}/{MAX_FILES_PER_PROJECT}).
        </p>
      </div>

      {canUpload && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!full) setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors duration-150 ease-out",
            dragOver ? "border-ring bg-primary/5" : "bg-muted/30",
            full && "opacity-60"
          )}
        >
          {upload.isPending ? (
            <>
              <LuLoaderCircle aria-hidden className="size-5 animate-spin text-muted-foreground" />
              <p className="text-sm font-medium text-foreground" aria-live="polite">
                Uploading… {progress ?? 0}%
              </p>
              <div
                className="h-1.5 w-48 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress ?? 0}
                aria-label="Upload progress"
              >
                <div
                  className="h-full bg-primary transition-[width] duration-150"
                  style={{ width: `${progress ?? 0}%` }}
                />
              </div>
            </>
          ) : (
            <>
              <span className="flex size-10 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
                <LuUpload aria-hidden className="size-4" />
              </span>
              <p className="text-sm text-foreground">
                {full ? (
                  `This project has reached the ${MAX_FILES_PER_PROJECT}-file limit.`
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
                Images, PDF, Office docs, TXT, CSV or ZIP · up to 10 MB each · 10 per upload
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
      )}

      {files.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading files">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full rounded-lg" />
          ))}
        </div>
      ) : files.isError ? (
        <QueryError
          title="Couldn't load files"
          error={files.error}
          onRetry={() => void files.refetch()}
          retrying={files.isRefetching}
        />
      ) : existing === 0 ? (
        <EmptyState
          icon={LuPaperclip}
          title="No files yet"
          description={
            canUpload ? "Upload specs, designs or anything the team needs." : "Nothing has been shared yet."
          }
        />
      ) : (
        <ul className="divide-y rounded-xl border" aria-label="Project files">
          {files.data?.map((file) => (
            <FileRow
              key={file._id}
              projectId={projectId}
              file={file}
              onDelete={() => setDeleting(file)}
            />
          ))}
        </ul>
      )}

      <DeleteFileDialog projectId={projectId} file={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function FileRow({
  projectId,
  file,
  onDelete,
}: {
  projectId: string;
  file: ProjectFile;
  onDelete: () => void;
}) {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const Icon = iconFor(file);

  async function download() {
    setDownloading(true);
    try {
      await downloadProjectFile(projectId, file);
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
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
        {downloading ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
      </Button>
      {file.canDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label={`Delete ${file.filename}`}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <LuTrash2 aria-hidden />
        </Button>
      )}
    </li>
  );
}

function DeleteFileDialog({
  projectId,
  file,
  onClose,
}: {
  projectId: string;
  file: ProjectFile | null;
  onClose: () => void;
}) {
  const remove = useDeleteProjectFile(projectId);
  return (
    <AlertDialog open={file !== null} onOpenChange={(open) => !open && !remove.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this file?</AlertDialogTitle>
          <AlertDialogDescription>
            &ldquo;{file?.filename}&rdquo; will be removed for everyone on the project.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => file && remove.mutate(file._id, { onSuccess: onClose })}
          >
            {remove.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuTrash2 aria-hidden />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
