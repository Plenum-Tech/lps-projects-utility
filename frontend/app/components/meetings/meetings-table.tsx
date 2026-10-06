import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { LuClipboardPaste, LuDownload, LuEye, LuFileText, LuLock, LuPencil, LuTrash2 } from "react-icons/lu";

import { AvatarStack } from "@/components/globals/data-table/avatar-stack";
import { RowActions, type RowAction } from "@/components/globals/data-table/row-actions";
import { DataTable, MobileField, type DataTableColumn } from "@/components/globals/data-table/table";
import { ShortCode } from "@/components/projects/project-badges";
import { formatPlainDate } from "@/lib/time";
import type { MeetingListItem, Role } from "@/types";

export type MeetingDialogKind = "edit" | "delete";

/** Client-side mirror of the edit rule for the ⋮ menu (the server re-checks). */
export function canEditMeetingClient(meeting: MeetingListItem, me: { _id: string; role: Role }) {
  return me.role === "admin" || meeting.createdBy._id === me._id;
}

function ItemsCell({ meeting }: { meeting: MeetingListItem }) {
  const { suggested, tasksCreated } = meeting.counts;
  if (suggested === 0 && tasksCreated === 0) {
    return <span className="text-xs text-muted-foreground">None</span>;
  }
  return (
    <span className="text-xs text-foreground tabular-nums">
      {suggested > 0 && (
        <span className={tasksCreated === 0 ? "font-medium" : undefined}>{suggested} suggested</span>
      )}
      {suggested > 0 && tasksCreated > 0 && <span className="text-muted-foreground"> · </span>}
      {tasksCreated > 0 && (
        <span className="font-medium text-primary">
          {tasksCreated} task{tasksCreated === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

function ProjectCell({ meeting }: { meeting: MeetingListItem }) {
  if (!meeting.project) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <LuLock aria-hidden className="size-3" />
        Private
      </span>
    );
  }
  return (
    <Link
      to={`/projects/${meeting.project._id}`}
      className="inline-flex min-w-0 items-center gap-1.5 text-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
    >
      <ShortCode code={meeting.project.code} />
      <span className="truncate">{meeting.project.name}</span>
    </Link>
  );
}

function speakerUsers(meeting: MeetingListItem) {
  return meeting.speakers.map((speaker) => ({
    _id: speaker.user?._id ?? `name:${speaker.name}`,
    name: speaker.user?.name ?? speaker.name,
  }));
}

export function MeetingsTable({
  meetings,
  total,
  loading,
  error,
  onRetry,
  retrying,
  dimmed,
  me,
  hideProject,
  onDialog,
  onDownload,
  empty,
  footer,
}: {
  meetings: MeetingListItem[] | undefined;
  total: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  dimmed: boolean;
  me: { _id: string; role: Role };
  /** Embedded in a project — the project column is redundant. */
  hideProject?: boolean;
  onDialog: (kind: MeetingDialogKind, meeting: MeetingListItem) => void;
  onDownload: (meeting: MeetingListItem) => void;
  empty: ReactNode;
  footer: ReactNode;
}) {
  const navigate = useNavigate();

  function actions(meeting: MeetingListItem): RowAction[] {
    const list: RowAction[] = [
      { label: "Open", icon: LuEye, onSelect: () => void navigate(`/meetings/${meeting._id}`) },
    ];
    const editable = canEditMeetingClient(meeting, me);
    if (editable) list.push({ label: "Edit", icon: LuPencil, onSelect: () => onDialog("edit", meeting) });
    if (meeting.file) {
      list.push({ label: "Download transcript", icon: LuDownload, onSelect: () => onDownload(meeting) });
    }
    if (editable) {
      list.push({
        label: "Delete",
        icon: LuTrash2,
        variant: "destructive",
        separated: true,
        onSelect: () => onDialog("delete", meeting),
      });
    }
    return list;
  }

  function titleCell(meeting: MeetingListItem) {
    const SourceIcon = meeting.source === "paste" ? LuClipboardPaste : LuFileText;
    return (
      <div className="min-w-0">
        <Link
          to={`/meetings/${meeting._id}`}
          className="block truncate font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
        >
          {meeting.title}
        </Link>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <SourceIcon aria-hidden className="size-3 shrink-0" />
          <span className="truncate">
            {meeting.file?.filename ?? "Pasted transcript"} · {meeting.counts.segments.toLocaleString()} lines
          </span>
        </p>
      </div>
    );
  }

  const columns: DataTableColumn<MeetingListItem>[] = [
    {
      id: "title",
      header: "Meeting",
      className: "min-w-56 max-w-80 whitespace-normal",
      cell: titleCell,
    },
    {
      id: "date",
      header: "Date",
      className: "pt-3 tabular-nums",
      cell: (meeting) => formatPlainDate(meeting.meetingDate),
    },
    ...(hideProject
      ? []
      : [
          {
            id: "project",
            header: "Project",
            className: "max-w-56 pt-3",
            cell: (meeting: MeetingListItem) => <ProjectCell meeting={meeting} />,
          },
        ]),
    {
      id: "speakers",
      header: "Speakers",
      className: "pt-3",
      cell: (meeting) => <AvatarStack users={speakerUsers(meeting)} label="Speakers" />,
    },
    {
      id: "items",
      header: "Action items",
      className: "pt-3",
      cell: (meeting) => <ItemsCell meeting={meeting} />,
    },
    {
      id: "createdBy",
      header: "Added by",
      className: "pt-3 text-sm",
      cell: (meeting) => meeting.createdBy.name,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "w-12 pt-2 text-right",
      headClassName: "text-right",
      cell: (meeting) => <RowActions label={`Actions for ${meeting.title}`} actions={actions(meeting)} />,
    },
  ];

  return (
    <DataTable
      caption={`Meetings, ${total} total`}
      columns={columns}
      rows={meetings}
      getRowId={(meeting) => meeting._id}
      getRowLabel={(meeting) => meeting.title}
      loading={loading}
      error={error}
      onRetry={onRetry}
      retrying={retrying}
      errorTitle="Couldn't load meetings"
      dimmed={dimmed}
      empty={empty}
      footer={footer}
      mobileCard={(meeting) => (
        <div className="space-y-2.5">
          <div className="flex items-start justify-between gap-2">
            {titleCell(meeting)}
            <RowActions label={`Actions for ${meeting.title}`} actions={actions(meeting)} />
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            <MobileField label="Date">{formatPlainDate(meeting.meetingDate)}</MobileField>
            {!hideProject && (
              <MobileField label="Project">
                <ProjectCell meeting={meeting} />
              </MobileField>
            )}
            <MobileField label="Action items">
              <ItemsCell meeting={meeting} />
            </MobileField>
            <MobileField label="Speakers">
              <AvatarStack users={speakerUsers(meeting)} label="Speakers" />
            </MobileField>
          </dl>
        </div>
      )}
    />
  );
}
