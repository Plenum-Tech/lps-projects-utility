import { useEffect, useMemo, useState } from "react";
import { LuMessagesSquare, LuPlus, LuTrash2 } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { DateRangeFilter, FiltersBar } from "@/components/globals/data-table/filters-bar";
import { DataTablePager } from "@/components/globals/data-table/pagination";
import { DataTableToolbar } from "@/components/globals/data-table/toolbar";
import { FilterSelect } from "@/components/globals/filter-select";
import { EmptyState, PageHeader } from "@/components/globals/query-states";
import { MeetingEditDialog } from "@/components/meetings/meeting-edit-dialog";
import { MeetingUploadDialog } from "@/components/meetings/meeting-upload-dialog";
import { MeetingsTable, type MeetingDialogKind } from "@/components/meetings/meetings-table";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/hooks/use-auth";
import { useDeleteMeeting, useDownloadTranscript, useMeetings } from "@/hooks/use-meetings";
import { useProjectOptions } from "@/hooks/use-projects";
import { useTableState } from "@/hooks/use-table-state";
import type { MeetingListItem, Role } from "@/types";

const DEFAULTS = { search: "", from: "", to: "", project: "" };
const FILTER_KEYS: (keyof typeof DEFAULTS)[] = ["search", "from", "to", "project"];

/**
 * Meetings list: the /meetings page, or embedded in a project's "Meetings"
 * tab (`project` set — filters live in memory, no project column/filter).
 */
export function MeetingsWorkspace({
  project,
}: {
  project?: { _id: string; archived: boolean };
}) {
  const embedded = Boolean(project);
  const { data: user } = useCurrentUser();
  const role: Role = user?.role ?? "employee";
  const me = useMemo(() => ({ _id: user?._id ?? "", role }), [user?._id, role]);

  const table = useTableState({
    storageKey: "meetings",
    defaults: DEFAULTS,
    mode: embedded ? "memory" : "url",
  });
  const { filters } = table;

  const meetings = useMeetings(
    {
      project: project?._id ?? filters.project,
      from: filters.from,
      to: filters.to,
      search: filters.search,
      limit: table.pageSize,
      offset: table.offset,
    },
    Boolean(user)
  );
  const { clampPage } = table;
  useEffect(() => {
    if (meetings.data) clampPage(meetings.data.total);
  }, [meetings.data, clampPage]);

  const projects = useProjectOptions(Boolean(user) && !embedded);
  const projectOptions = useMemo(
    () => [
      { value: "none", label: "No project (private)" },
      ...(projects.data ?? []).map((item) => ({ value: item._id, label: `${item.code} · ${item.name}` })),
    ],
    [projects.data]
  );

  const [uploadOpen, setUploadOpen] = useState(false);
  const [dialog, setDialog] = useState<{ kind: MeetingDialogKind; meeting: MeetingListItem } | null>(null);
  const remove = useDeleteMeeting();
  const download = useDownloadTranscript();

  const filtered = table.countActive(embedded ? ["search", "from", "to"] : FILTER_KEYS) > 0;
  const canAdd = !project?.archived;
  const items = meetings.data?.meetings;
  const total = meetings.data?.total ?? 0;

  const empty = filtered ? (
    <EmptyState
      icon={LuMessagesSquare}
      title="No matching meetings"
      description="Try a different search or clear the filters."
      className="border-0"
    >
      <Button variant="outline" onClick={() => table.clearFilters()}>
        Clear filters
      </Button>
    </EmptyState>
  ) : (
    <EmptyState
      icon={LuMessagesSquare}
      title={embedded ? "No meetings for this project yet" : "No meetings yet"}
      description="Upload a Teams transcript (.vtt or .docx) or paste one — LPS suggests action items you can turn into tasks."
      className="border-0"
    >
      {canAdd && (
        <Button onClick={() => setUploadOpen(true)}>
          <LuPlus aria-hidden />
          New meeting
        </Button>
      )}
    </EmptyState>
  );

  const content = (
    <div className="space-y-4">
      <DataTableToolbar
        actions={
          canAdd && (
            <Button onClick={() => setUploadOpen(true)}>
              <LuPlus aria-hidden />
              New meeting
            </Button>
          )
        }
      />
      <FiltersBar
        search={filters.search}
        onSearchChange={(search) => table.setFilters({ search })}
        searchPlaceholder="Search title or notes…"
        canClear={filtered}
        onClearAll={() => table.clearFilters()}
      >
        <DateRangeFilter
          label="Date"
          from={filters.from}
          to={filters.to}
          onChange={(range) => table.setFilters(range)}
          description="Meetings held in this range."
        />
        {!embedded && (
          <FilterSelect
            label="Project"
            value={filters.project}
            onChange={(value) => table.setFilters({ project: value })}
            options={projectOptions}
          />
        )}
      </FiltersBar>

      <MeetingsTable
        meetings={items}
        total={total}
        loading={meetings.isPending}
        error={meetings.isError ? meetings.error : null}
        onRetry={() => void meetings.refetch()}
        retrying={meetings.isRefetching}
        dimmed={meetings.isPlaceholderData}
        me={me}
        hideProject={embedded}
        onDialog={(kind, meeting) => setDialog({ kind, meeting })}
        onDownload={(meeting) =>
          download.mutate({ id: meeting._id, filename: meeting.file?.filename ?? "transcript.txt" })
        }
        empty={empty}
        footer={
          meetings.data && total > 0 ? (
            <DataTablePager
              page={table.page}
              pageSize={table.pageSize}
              total={total}
              shown={items?.length ?? 0}
              onPageChange={table.setPage}
              onPageSizeChange={table.setPageSize}
            />
          ) : null
        }
      />

      <MeetingUploadDialog open={uploadOpen} onOpenChange={setUploadOpen} defaultProjectId={project?._id} />

      {dialog && (
        <MeetingEditDialog
          meetingId={dialog.meeting._id}
          open={dialog.kind === "edit"}
          onOpenChange={(open) => !open && setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => !open && setDialog(null)}
        pending={remove.isPending}
        destructive
        title={`Delete “${dialog?.meeting.title ?? "meeting"}”?`}
        description="The transcript, notes and suggestions are removed for everyone. Tasks created from it are kept — they just lose the link back to the meeting."
        confirmLabel="Delete meeting"
        icon={<LuTrash2 aria-hidden />}
        onConfirm={() =>
          dialog && remove.mutate(dialog.meeting._id, { onSuccess: () => setDialog(null) })
        }
      />
    </div>
  );

  if (embedded) return content;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <PageHeader
        title="Meetings"
        description="Turn Teams meeting transcripts into tracked tasks."
      />
      <div className="mt-6">{content}</div>
    </div>
  );
}
