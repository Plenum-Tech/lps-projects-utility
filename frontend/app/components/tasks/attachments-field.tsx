import { useRef, useState, type DragEvent } from "react";
import { LuPaperclip, LuUpload, LuX } from "react-icons/lu";

import {
  ACCEPT,
  MAX_FILES_PER_TASK,
  validateUploads,
} from "@/components/tasks/task-files";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { formatFileSize } from "@/lib/tasks";
import { cn } from "@/lib/utils";

/**
 * Files picked while creating or editing a task; they upload once the task is
 * saved. Same type/size rules as the task's Files tab.
 */
export function AttachmentsField({
  id = "task-attachments",
  files,
  onChange,
  disabled = false,
  /** Files the task already has (edit), so the per-task limit holds. */
  existingCount = 0,
}: {
  id?: string;
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
  existingCount?: number;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const room = Math.max(MAX_FILES_PER_TASK - existingCount - files.length, 0);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const { accepted, rejected } = validateUploads(Array.from(list));
    if (rejected.length) toast.warning(rejected.join(" · "));
    if (accepted.length > room) {
      toast.warning(
        `A task can hold ${MAX_FILES_PER_TASK} files — ${room} more allowed.`,
      );
    }
    const next = accepted.slice(0, room);
    if (next.length > 0) onChange([...files, ...next]);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    if (!disabled) addFiles(event.dataTransfer.files);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Add files</Label>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled && room > 0) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-5 text-center transition-colors duration-150 ease-out",
          dragOver ? "border-ring bg-primary/5" : "bg-muted/30",
          (disabled || room === 0) && "opacity-60",
        )}
      >
        <span className="flex size-8 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
          <LuUpload aria-hidden className="size-4" />
        </span>
        <p className="text-sm text-foreground">
          {room === 0 ? (
            `This task has reached the ${MAX_FILES_PER_TASK}-file limit.`
          ) : (
            <>
              Drag files here or{" "}
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                onClick={() => inputRef.current?.click()}
                disabled={disabled}
              >
                choose files
              </button>
            </>
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          Images, PDF, Office docs, TXT, CSV or ZIP · up to 10 MB each ·
          uploaded when you save
        </p>
        <input
          ref={inputRef}
          id={id}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          disabled={disabled}
          onChange={(event) => {
            addFiles(event.target.files);
            event.target.value = "";
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="space-y-1" aria-label="Files to upload">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${index}`}
              className="flex items-center gap-2 rounded-md bg-background px-2 py-1.5 text-sm ring-1 ring-border"
            >
              <LuPaperclip
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatFileSize(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => onChange(files.filter((_, i) => i !== index))}
                disabled={disabled}
                aria-label={`Remove ${file.name}`}
              >
                <LuX aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
