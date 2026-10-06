import { useEffect, useMemo, useState } from "react";
import { LuFileText, LuPlus, LuTrash2 } from "react-icons/lu";

import { DocumentFormDialog } from "@/components/documents/document-form-dialog";
import { DocumentsTable } from "@/components/documents/documents-table";
import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { DataTableSearch } from "@/components/globals/data-table-search";
import { FilterSelect } from "@/components/globals/filter-select";
import { EmptyState, PageHeader } from "@/components/globals/query-states";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  useDeleteDocument,
  useDocuments,
  useDownloadDocument,
} from "@/hooks/use-documents";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { useTableState } from "@/hooks/use-table-state";
import { DOCUMENT_TYPE_LABELS, DOCUMENT_TYPES } from "@/lib/documents";
import type { DocumentType, EmployeeDocument } from "@/types";

const DEFAULTS = { user: "", type: "", search: "", expiring: "" };
const FILTER_KEYS = ["user", "type", "search", "expiring"] as const;

const EXPIRING_OPTIONS = [
  { value: "7", label: "≤ 7 days" },
  { value: "30", label: "≤ 30 days" },
  { value: "60", label: "≤ 60 days" },
  { value: "90", label: "≤ 90 days" },
];

/**
 * /documents: employees see their own documents; admins and heads also get a
 * person filter (heads are read-only for others). Upload / edit / delete per
 * row permissions from the API.
 */
export function DocumentsPage() {
  const { data: me } = useCurrentUser();
  const role = me?.role ?? "employee";
  const isAdmin = role === "admin";
  const canFilterPeople = role === "admin" || role === "head";

  const table = useTableState({ storageKey: "documents", defaults: DEFAULTS });
  const { filters } = table;
  const expiring = /^\d+$/.test(filters.expiring) ? Number(filters.expiring) : null;
  // Admins / heads: "" = everyone in scope; employees always see their own.
  const userParam = canFilterPeople ? filters.user || "all" : "me";

  const query = useDocuments({
    user: userParam,
    type: (DOCUMENT_TYPES as string[]).includes(filters.type) ? (filters.type as DocumentType) : "",
    search: filters.search,
    expiring,
    limit: table.pageSize,
    offset: table.offset,
  });
  const { clampPage } = table;
  useEffect(() => {
    if (query.data) clampPage(query.data.total);
  }, [query.data, clampPage]);

  const people = useAssignableUsers(canFilterPeople);
  const peopleOptions = useMemo(
    () => (people.data ?? []).map((person) => ({ value: person._id, label: person.name })),
    [people.data]
  );
  const ownerOptions = useMemo(
    () =>
      isAdmin
        ? [
            ...(me ? [{ value: me._id, label: `${me.name} (me)` }] : []),
            ...peopleOptions.filter((option) => option.value !== me?._id),
          ]
        : undefined,
    [isAdmin, me, peopleOptions]
  );

  const [dialog, setDialog] = useState<{ document: EmployeeDocument | null } | null>(null);
  const [deleting, setDeleting] = useState<EmployeeDocument | null>(null);
  const del = useDeleteDocument();
  const download = useDownloadDocument();

  const filtered = table.countActive([...FILTER_KEYS]) > 0;
  const total = query.data?.total ?? 0;

  const empty = filtered ? (
    <EmptyState
      icon={LuFileText}
      title="No matching documents"
      description="Try a different person, type or expiry window."
      className="border-0"
    >
      <Button variant="outline" onClick={() => table.clearFilters([...FILTER_KEYS])}>
        Clear filters
      </Button>
    </EmptyState>
  ) : (
    <EmptyState
      icon={LuFileText}
      title="No documents yet"
      description="Add passports, visas, contracts and certificates to get reminders before they expire."
      className="border-0"
    >
      <Button onClick={() => setDialog({ document: null })}>
        <LuPlus aria-hidden />
        Add document
      </Button>
    </EmptyState>
  );

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title={canFilterPeople ? "Documents" : "My documents"}
        description={
          isAdmin
            ? "Employee documents with expiry reminders for everyone."
            : role === "head"
              ? "Your documents and your department's (read-only)."
              : "Your documents, with reminders before they expire."
        }
        actions={
          <Button onClick={() => setDialog({ document: null })}>
            <LuPlus aria-hidden />
            Add document
          </Button>
        }
      />

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <DataTableSearch
          value={filters.search}
          onValueChange={(search) => table.setFilters({ search })}
          placeholder="Search documents…"
        />
        {canFilterPeople && (
          <FilterSelect
            label="Person"
            value={filters.user}
            onChange={(user) => table.setFilters({ user })}
            anyLabel={isAdmin ? "Everyone" : "Me & my department"}
            options={[
              { value: "me", label: "Only mine" },
              ...peopleOptions.filter((option) => option.value !== me?._id),
            ]}
          />
        )}
        <FilterSelect
          label="Type"
          value={filters.type}
          onChange={(type) => table.setFilters({ type })}
          options={DOCUMENT_TYPES.map((type) => ({ value: type, label: DOCUMENT_TYPE_LABELS[type] }))}
        />
        <FilterSelect
          label="Expiring"
          value={EXPIRING_OPTIONS.some((option) => option.value === filters.expiring) || !filters.expiring
            ? filters.expiring
            : ""}
          onChange={(value) => table.setFilters({ expiring: value })}
          anyLabel="Any expiry"
          options={EXPIRING_OPTIONS}
        />
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => table.clearFilters([...FILTER_KEYS])}>
            Clear
          </Button>
        )}
      </div>

      <div className="mt-4">
        <DocumentsTable
          documents={query.data?.documents}
          loading={query.isPending}
          error={query.isError ? query.error : null}
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
          dimmed={query.isPlaceholderData}
          showOwner={canFilterPeople}
          empty={empty}
          onEdit={(document) => setDialog({ document })}
          onDelete={setDeleting}
          onDownload={(document) => download.mutate(document)}
          downloadingId={download.isPending ? (download.variables?._id ?? null) : null}
          footer={
            query.data && total > 0 ? (
              <DataTablePager
                page={table.page}
                pageSize={table.pageSize}
                total={total}
                shown={query.data.documents.length}
                onPageChange={table.setPage}
                onPageSizeChange={table.setPageSize}
                noun="documents"
              />
            ) : null
          }
        />
      </div>

      {me && (
        <DocumentFormDialog
          open={dialog !== null}
          document={dialog?.document ?? null}
          onOpenChange={(open) => !open && setDialog(null)}
          ownerOptions={ownerOptions}
          meId={me._id}
        />
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete document?"
        description={
          deleting ? (
            <>
              <span className="font-medium text-foreground">{deleting.name}</span>
              {deleting.file ? " and its file" : ""} will be permanently deleted.
            </>
          ) : null
        }
        confirmLabel="Delete"
        destructive
        icon={<LuTrash2 aria-hidden />}
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting._id, { onSettled: () => setDeleting(null) })}
      />
    </div>
  );
}
