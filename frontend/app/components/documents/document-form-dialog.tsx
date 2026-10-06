import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  LuCircleAlert,
  LuFileText,
  LuLoaderCircle,
  LuPaperclip,
  LuUpload,
  LuX,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCreateDocument, useUpdateDocument } from "@/hooks/use-documents";
import { getErrorMessage } from "@/lib/api";
import {
  DOCUMENT_ACCEPT,
  DOCUMENT_MAX_BYTES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
} from "@/lib/documents";
import { formatFileSize } from "@/lib/tasks";
import type { DocumentInput, DocumentType, EmployeeDocument } from "@/types";

interface FormState {
  owner: string;
  type: DocumentType | "";
  name: string;
  issueDate: string;
  expiryDate: string;
  notes: string;
}

const toInput = (value: string | null | undefined) => (value ? value.slice(0, 10) : "");

/**
 * Add / edit an employee document: type, name, issue and expiry dates, notes
 * and one file (PDF, images, Office; 10 MB). Admins can add for anyone.
 */
export function DocumentFormDialog({
  open,
  document,
  onOpenChange,
  ownerOptions,
  meId,
}: {
  open: boolean;
  /** null = new document. */
  document: EmployeeDocument | null;
  onOpenChange: (open: boolean) => void;
  /** Admins only: people they can add a document for (create). */
  ownerOptions?: { value: string; label: string }[];
  meId: string;
}) {
  const create = useCreateDocument();
  const update = useUpdateDocument();
  const isEdit = document !== null;
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const fileRef = useRef<HTMLInputElement>(null);

  const [form, setForm] = useState<FormState>({
    owner: meId,
    type: "",
    name: "",
    issueDate: "",
    expiryDate: "",
    notes: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm({
      owner: document?.user?._id ?? meId,
      type: document?.type ?? "",
      name: document?.name ?? "",
      issueDate: toInput(document?.issueDate),
      expiryDate: toInput(document?.expiryDate),
      notes: document?.notes ?? "",
    });
    setFile(null);
    setRemoveFile(false);
    setFileError(null);
    setSubmitted(false);
    create.reset();
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, document, meId]);

  const set = (patch: Partial<FormState>) => setForm((current) => ({ ...current, ...patch }));

  const owners = useMemo(() => ownerOptions ?? [], [ownerOptions]);
  const selectedOwner = owners.find((option) => option.value === form.owner) ?? null;

  const nameError = !form.name.trim()
    ? "Name is required."
    : form.name.trim().length > 120
      ? "Keep the name under 120 characters."
      : null;
  const typeError = form.type ? null : "Choose a document type.";
  const datesError =
    form.issueDate && form.expiryDate && form.expiryDate < form.issueDate
      ? "Expiry must be on or after the issue date."
      : null;
  const notesError = form.notes.length > 1000 ? "Keep notes under 1000 characters." : null;
  const ownerError = !isEdit && owners.length > 0 && !form.owner ? "Choose whose document this is." : null;

  function pickFile(next: File | null) {
    setFileError(null);
    if (next && next.size > DOCUMENT_MAX_BYTES) {
      setFileError("Files can be at most 10 MB.");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setFile(next);
    if (next) setRemoveFile(false);
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nameError || typeError || datesError || notesError || ownerError || fileError) return;

    if (isEdit && document) {
      const input: DocumentInput = {};
      if (form.type !== document.type) input.type = form.type as DocumentType;
      if (form.name.trim() !== document.name) input.name = form.name.trim();
      if (form.issueDate !== toInput(document.issueDate)) input.issueDate = form.issueDate;
      if (form.expiryDate !== toInput(document.expiryDate)) input.expiryDate = form.expiryDate;
      if (form.notes.trim() !== document.notes) input.notes = form.notes.trim();
      if (file) input.file = file;
      else if (removeFile && document.file) input.removeFile = true;
      if (Object.keys(input).length === 0) {
        onOpenChange(false);
        return;
      }
      update.mutate({ id: document._id, input }, { onSuccess: () => onOpenChange(false) });
    } else {
      const input: DocumentInput = {
        type: form.type as DocumentType,
        name: form.name.trim(),
        issueDate: form.issueDate,
        expiryDate: form.expiryDate,
        notes: form.notes.trim(),
        file,
      };
      if (owners.length > 0 && form.owner && form.owner !== meId) input.user = form.owner;
      create.mutate(input, { onSuccess: () => onOpenChange(false) });
    }
  }

  const existingFile = isEdit && document?.file && !removeFile && !file ? document.file : null;

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit document" : "Add document"}</DialogTitle>
          <DialogDescription>
            Store the document&apos;s name, dates and file. Document numbers are never stored.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          {!isEdit && owners.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="doc-owner">Employee</Label>
              <Combobox
                items={owners}
                value={selectedOwner}
                onValueChange={(item) => set({ owner: item?.value ?? "" })}
                autoHighlight
              >
                <ComboboxInput id="doc-owner" placeholder="Search people…" className="w-full" />
                <ComboboxContent sideOffset={4}>
                  <ComboboxEmpty>No people found.</ComboboxEmpty>
                  <ComboboxList>
                    {(item) => (
                      <ComboboxItem key={item.value} value={item}>
                        {item.label}
                      </ComboboxItem>
                    )}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              {submitted && ownerError && <p className="text-xs text-destructive">{ownerError}</p>}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="doc-type">Type</Label>
              <Select
                value={form.type || null}
                onValueChange={(value) => set({ type: (value ?? "") as DocumentType | "" })}
                items={DOCUMENT_TYPE_LABELS}
              >
                <SelectTrigger
                  id="doc-type"
                  className="w-full"
                  aria-invalid={submitted && Boolean(typeError)}
                >
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {DOCUMENT_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {submitted && typeError && <p className="text-xs text-destructive">{typeError}</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-name">Name</Label>
              <Input
                id="doc-name"
                value={form.name}
                maxLength={120}
                onChange={(event) => set({ name: event.target.value })}
                placeholder="e.g. UAE Residence Visa"
                aria-invalid={submitted && Boolean(nameError)}
                aria-describedby={submitted && nameError ? "doc-name-error" : undefined}
              />
              {submitted && nameError && (
                <p id="doc-name-error" className="text-xs text-destructive">
                  {nameError}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-issue">Issue date</Label>
              <Input
                id="doc-issue"
                type="date"
                value={form.issueDate}
                onChange={(event) => set({ issueDate: event.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="doc-expiry">Expiry date</Label>
              <Input
                id="doc-expiry"
                type="date"
                value={form.expiryDate}
                min={form.issueDate || undefined}
                onChange={(event) => set({ expiryDate: event.target.value })}
                aria-invalid={submitted && Boolean(datesError)}
                aria-describedby="doc-expiry-hint"
              />
              <p
                id="doc-expiry-hint"
                className={submitted && datesError ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {submitted && datesError ? datesError : "Leave empty if it never expires."}
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-notes">Notes</Label>
            <Textarea
              id="doc-notes"
              value={form.notes}
              maxLength={1000}
              rows={3}
              onChange={(event) => set({ notes: event.target.value })}
              placeholder="Optional"
              aria-invalid={submitted && Boolean(notesError)}
            />
            {submitted && notesError && <p className="text-xs text-destructive">{notesError}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="doc-file">File</Label>
            {existingFile ? (
              <div className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
                <LuFileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{existingFile.filename}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(existingFile.size)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setRemoveFile(true)}
                  aria-label={`Remove ${existingFile.filename}`}
                >
                  <LuX aria-hidden />
                </Button>
              </div>
            ) : file ? (
              <div className="flex items-center gap-2 rounded-lg border bg-primary/5 px-3 py-2 text-sm">
                <LuPaperclip aria-hidden className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => {
                    pickFile(null);
                    if (fileRef.current) fileRef.current.value = "";
                  }}
                  aria-label={`Remove ${file.name}`}
                >
                  <LuX aria-hidden />
                </Button>
              </div>
            ) : null}
            <div className={existingFile || file ? "sr-only" : undefined}>
              <label
                htmlFor="doc-file"
                className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-4 text-sm text-muted-foreground transition-colors duration-150 hover:border-ring hover:text-foreground focus-within:ring-2 focus-within:ring-ring/50"
              >
                <LuUpload aria-hidden className="size-4" />
                Choose a file — PDF, image or Office, up to 10 MB
                <input
                  ref={fileRef}
                  id="doc-file"
                  type="file"
                  accept={DOCUMENT_ACCEPT}
                  className="sr-only"
                  onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                />
              </label>
            </div>
            {removeFile && isEdit && document?.file && !file && (
              <p className="text-xs text-muted-foreground">
                The current file will be removed when you save.{" "}
                <button
                  type="button"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                  onClick={() => setRemoveFile(false)}
                >
                  Undo
                </button>
              </p>
            )}
            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>

          {Boolean(error) && (
            <Alert variant="destructive">
              <LuCircleAlert aria-hidden className="size-4" />
              <AlertTitle>{isEdit ? "Couldn't save the document" : "Couldn't add the document"}</AlertTitle>
              <AlertDescription>{getErrorMessage(error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuUpload aria-hidden />}
              {pending ? "Saving…" : isEdit ? "Save changes" : "Add document"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
