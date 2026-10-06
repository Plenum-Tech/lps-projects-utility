import type { ReactNode } from "react";
import { LuDownload, LuLoaderCircle, LuPencil, LuTrash2 } from "react-icons/lu";

import { RowActions } from "@/components/globals/data-table/row-actions";
import { DataTable, MobileField, type DataTableColumn } from "@/components/globals/data-table/table";
import { Button } from "@/components/ui/button";
import {
  DOCUMENT_TYPE_LABELS,
  EXPIRY_DOT,
  EXPIRY_TEXT,
  expiryPhrase,
  expiryUrgency,
} from "@/lib/documents";
import { formatFileSize } from "@/lib/tasks";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { EmployeeDocument } from "@/types";

function Expiry({ document }: { document: EmployeeDocument }) {
  if (!document.expiryDate) return <span className="text-xs text-muted-foreground">Never expires</span>;
  const urgency = expiryUrgency(document.inDays);
  return (
    <span className="inline-flex flex-col">
      <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium tabular-nums", EXPIRY_TEXT[urgency])}>
        <span aria-hidden className={cn("size-2 rounded-full", EXPIRY_DOT[urgency])} />
        {formatPlainDate(document.expiryDate)}
      </span>
      <span className={cn("text-xs", urgency === "later" ? "text-muted-foreground" : EXPIRY_TEXT[urgency])}>
        {expiryPhrase(document.inDays)}
      </span>
    </span>
  );
}

function FileCell({
  document,
  onDownload,
  downloading,
}: {
  document: EmployeeDocument;
  onDownload: (document: EmployeeDocument) => void;
  downloading: boolean;
}) {
  if (!document.file) return <span className="text-xs text-muted-foreground">No file</span>;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onDownload(document)}
      disabled={downloading}
      aria-label={`Download ${document.file.filename}`}
      title={`${document.file.filename} (${formatFileSize(document.file.size)})`}
      className="max-w-48"
    >
      {downloading ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
      <span className="truncate">{formatFileSize(document.file.size)}</span>
    </Button>
  );
}

/** Name, type, owner, issue date, expiry (urgency colour), file and actions. */
export function DocumentsTable({
  documents,
  loading,
  error,
  onRetry,
  retrying,
  dimmed,
  showOwner,
  empty,
  footer,
  onEdit,
  onDelete,
  onDownload,
  downloadingId,
}: {
  documents: EmployeeDocument[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  dimmed: boolean;
  showOwner: boolean;
  empty: ReactNode;
  footer: ReactNode;
  onEdit: (document: EmployeeDocument) => void;
  onDelete: (document: EmployeeDocument) => void;
  onDownload: (document: EmployeeDocument) => void;
  downloadingId: string | null;
}) {
  function actions(document: EmployeeDocument) {
    const { edit, delete: canDelete } = document.permissions;
    if (!edit && !canDelete) {
      return <span className="sr-only">Read only</span>;
    }
    return (
      <RowActions
        label={`Actions for ${document.name}`}
        actions={[
          ...(edit ? [{ label: "Edit", icon: LuPencil, onSelect: () => onEdit(document) }] : []),
          ...(canDelete
            ? [
                {
                  label: "Delete",
                  icon: LuTrash2,
                  onSelect: () => onDelete(document),
                  variant: "destructive" as const,
                  separated: edit,
                },
              ]
            : []),
        ]}
      />
    );
  }

  const columns: DataTableColumn<EmployeeDocument>[] = [
    {
      id: "name",
      header: "Name",
      cell: (document) => (
        <div className="min-w-0 max-w-72">
          <p className="truncate font-medium text-foreground">{document.name}</p>
          {document.notes && (
            <p className="truncate text-xs text-muted-foreground" title={document.notes}>
              {document.notes}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: (document) => (
        <span className="text-sm whitespace-nowrap text-muted-foreground">{DOCUMENT_TYPE_LABELS[document.type]}</span>
      ),
    },
    ...(showOwner
      ? [
          {
            id: "owner",
            header: "Owner",
            cell: (document: EmployeeDocument) =>
              document.user ? (
                <div className="min-w-0 max-w-48">
                  <p className="truncate text-sm text-foreground">{document.user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[document.user.employeeId, document.user.department?.name].filter(Boolean).join(" · ") ||
                      document.user.email}
                  </p>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
        ]
      : []),
    {
      id: "issue",
      header: "Issue date",
      cell: (document) => (
        <span className="text-sm whitespace-nowrap text-muted-foreground tabular-nums">
          {formatPlainDate(document.issueDate)}
        </span>
      ),
    },
    { id: "expiry", header: "Expiry", cell: (document) => <Expiry document={document} /> },
    {
      id: "file",
      header: "File",
      cell: (document) => (
        <FileCell document={document} onDownload={onDownload} downloading={downloadingId === document._id} />
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-12 text-right",
      cell: actions,
    },
  ];

  return (
    <DataTable
      caption="Employee documents"
      columns={columns}
      rows={documents}
      getRowId={(document) => document._id}
      getRowLabel={(document) => document.name}
      loading={loading}
      error={error}
      onRetry={onRetry}
      retrying={retrying}
      errorTitle="Couldn't load documents"
      dimmed={dimmed}
      empty={empty}
      footer={footer}
      mobileCard={(document) => (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{document.name}</p>
              <p className="text-xs text-muted-foreground">
                {DOCUMENT_TYPE_LABELS[document.type]}
                {showOwner && document.user ? ` · ${document.user.name}` : ""}
              </p>
            </div>
            {actions(document)}
          </div>
          <dl className="grid grid-cols-2 gap-2">
            <MobileField label="Issue date">{formatPlainDate(document.issueDate)}</MobileField>
            <MobileField label="Expiry">
              <Expiry document={document} />
            </MobileField>
          </dl>
          <FileCell document={document} onDownload={onDownload} downloading={downloadingId === document._id} />
        </div>
      )}
    />
  );
}
