import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { LuListTodo, LuMessageSquareOff, LuNotebookPen, LuScrollText, LuTrash2 } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { EmptyState, QueryError } from "@/components/globals/query-states";
import { ActionItemsPane } from "@/components/meetings/action-items-pane";
import { CreateTasksSheet, type TaskEntry } from "@/components/meetings/create-tasks-sheet";
import { MeetingEditDialog } from "@/components/meetings/meeting-edit-dialog";
import { MeetingHeader } from "@/components/meetings/meeting-header";
import { MeetingNotes } from "@/components/meetings/meeting-notes";
import { TranscriptPane, type TranscriptJump } from "@/components/meetings/transcript-pane";
import { errorStatus } from "@/components/projects/project-fields";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  useAddActionItem,
  useDeleteMeeting,
  useMeeting,
  useMeetingAssignees,
} from "@/hooks/use-meetings";
import { tasksBySegment } from "@/lib/meetings";
import type { MeetingActionItem, MeetingDetailResponse } from "@/types";

type MobileTab = "transcript" | "items" | "notes";
type SideTab = "items" | "notes";

/** True from the `lg` breakpoint (two panes side by side). */
function useIsDesktop() {
  const [desktop, setDesktop] = useState(true);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return desktop;
}

/** The /meetings/:id workspace: header, transcript pane, action items + notes. */
export function MeetingDetailPage({ meetingId }: { meetingId: string }) {
  const detail = useMeeting(meetingId);

  if (detail.isPending) return <MeetingSkeleton />;
  if (detail.isError) {
    const status = errorStatus(detail.error);
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {status === 403 || status === 404 ? (
          <EmptyState
            icon={LuMessageSquareOff}
            title="Meeting unavailable"
            description={
              status === 404
                ? "This meeting doesn't exist or was deleted."
                : "You don't have access to this meeting. Project meetings are visible to the project's members; meetings without a project only to their creator and admins."
            }
            className="py-16"
          >
            <Link to="/meetings" className={buttonVariants({ variant: "outline" })}>
              Back to meetings
            </Link>
          </EmptyState>
        ) : (
          <QueryError
            title="Couldn't load the meeting"
            error={detail.error}
            onRetry={() => void detail.refetch()}
            retrying={detail.isRefetching}
          />
        )}
      </div>
    );
  }
  return <MeetingWorkspace detail={detail.data} />;
}

function MeetingWorkspace({ detail }: { detail: MeetingDetailResponse }) {
  const { meeting, permissions } = detail;
  const navigate = useNavigate();
  const desktop = useIsDesktop();
  const [searchParams, setSearchParams] = useSearchParams();
  const people = useMeetingAssignees(meeting._id, permissions.canEdit || permissions.canCreateTasks);
  const addItem = useAddActionItem(meeting._id);
  const remove = useDeleteMeeting();

  const [mobileTab, setMobileTab] = useState<MobileTab>("transcript");
  const [sideTab, setSideTab] = useState<SideTab>("items");
  const [jump, setJump] = useState<TranscriptJump | null>(null);
  const [entries, setEntries] = useState<TaskEntry[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // `?seg=<idx>` (task "From meeting" links): scroll to and flash that line.
  const segParam = searchParams.get("seg");
  const handledSeg = useRef<string | null>(null);
  useEffect(() => {
    if (segParam === null || segParam === handledSeg.current) return;
    handledSeg.current = segParam;
    const idx = Number(segParam);
    if (!Number.isInteger(idx) || idx < 0) return;
    setMobileTab("transcript");
    setJump({ idx, nonce: Date.now() });
  }, [segParam]);

  const onJump = useCallback(
    (idx: number) => {
      setMobileTab("transcript");
      setJump({ idx, nonce: Date.now() });
      handledSeg.current = String(idx);
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);
          next.set("seg", String(idx));
          return next;
        },
        { replace: true, preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  const hintIdxs = useMemo(() => new Set(meeting.hintSegmentIdxs), [meeting.hintSegmentIdxs]);
  const taskChips = useMemo(() => tasksBySegment(meeting.actionItems), [meeting.actionItems]);

  const segmentText = useCallback(
    (idxs: number[]) =>
      meeting.segments
        .filter((segment) => idxs.includes(segment.idx))
        .map((segment) => segment.text)
        .join(" "),
    [meeting.segments]
  );

  function onTranscriptAction(segmentIdxs: number[], title?: string) {
    if (permissions.canEdit) {
      addItem.mutate({ segmentIdxs, ...(title ? { title } : {}) });
      return;
    }
    // Viewers can't add suggestions, but may create a task straight from the lines.
    setEntries([
      {
        key: `raw-${segmentIdxs.join("-")}`,
        segmentIdxs,
        title: title || segmentText(segmentIdxs).slice(0, 200),
        assignee: null,
        dueDate: null,
        priority: "medium",
      },
    ]);
    setSheetOpen(true);
  }

  function openCreate(items: MeetingActionItem[]) {
    setEntries(
      items.map((item) => ({
        key: item._id,
        itemId: item._id,
        segmentIdxs: item.segmentIdxs,
        title: item.title,
        assignee: item.assignee,
        dueDate: item.dueDate,
        priority: item.priority,
      }))
    );
    setSheetOpen(true);
  }

  const suggestedCount = meeting.actionItems.filter((item) => item.status === "suggested").length;
  const selectable = permissions.canEdit || permissions.canCreateTasks;

  const transcript = (
    <TranscriptPane
      segments={meeting.segments}
      hintIdxs={hintIdxs}
      tasksBySeg={taskChips}
      jump={jump}
      selectable={selectable}
      actionLabel={permissions.canEdit ? "Action item" : "Create task"}
      onAction={onTranscriptAction}
      className="h-full"
    />
  );
  const items = (
    <ActionItemsPane
      meeting={meeting}
      permissions={permissions}
      people={people.data ?? []}
      peopleLoading={people.isPending && permissions.canEdit}
      onJump={onJump}
      onCreate={openCreate}
    />
  );
  const notes = <MeetingNotes meeting={meeting} canEdit={permissions.canEdit} />;
  const itemsLabel = (
    <>
      <LuListTodo aria-hidden />
      Action items
      {suggestedCount > 0 && (
        <span className="rounded-full bg-primary/10 px-1.5 text-[0.7rem] text-primary tabular-nums">
          {suggestedCount}
        </span>
      )}
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[90rem] px-4 py-6 sm:px-6 lg:px-8">
      <MeetingHeader detail={detail} onEdit={() => setEditOpen(true)} onDelete={() => setDeleteOpen(true)} />

      {desktop ? (
        <div className="mt-5 grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-5">
          <section
            aria-label="Transcript"
            className="h-[calc(100dvh-13rem)] min-h-[30rem] overflow-hidden rounded-xl border bg-card"
          >
            {transcript}
          </section>
          <Tabs
            value={sideTab}
            onValueChange={(value) => setSideTab(value as SideTab)}
            className="h-[calc(100dvh-13rem)] min-h-[30rem] gap-3"
          >
            <TabsList variant="line" className="w-full justify-start border-b pb-0.5">
              <TabsTrigger value="items" className="flex-none px-2.5">
                {itemsLabel}
              </TabsTrigger>
              <TabsTrigger value="notes" className="flex-none px-2.5">
                <LuNotebookPen aria-hidden />
                Notes
              </TabsTrigger>
            </TabsList>
            <TabsContent value="items" className="min-h-0 overflow-y-auto pr-1">
              {items}
            </TabsContent>
            <TabsContent value="notes" className="min-h-0 overflow-y-auto pr-1">
              {notes}
            </TabsContent>
          </Tabs>
        </div>
      ) : (
        <Tabs value={mobileTab} onValueChange={(value) => setMobileTab(value as MobileTab)} className="mt-5 gap-3">
          <TabsList className="w-full">
            <TabsTrigger value="transcript">
              <LuScrollText aria-hidden />
              Transcript
            </TabsTrigger>
            <TabsTrigger value="items">{itemsLabel}</TabsTrigger>
            <TabsTrigger value="notes">
              <LuNotebookPen aria-hidden />
              Notes
            </TabsTrigger>
          </TabsList>
          <TabsContent value="transcript">
            <section aria-label="Transcript" className="h-[70dvh] overflow-hidden rounded-xl border bg-card">
              {mobileTab === "transcript" && transcript}
            </section>
          </TabsContent>
          <TabsContent value="items">{mobileTab === "items" && items}</TabsContent>
          <TabsContent value="notes">{mobileTab === "notes" && notes}</TabsContent>
        </Tabs>
      )}

      <CreateTasksSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        meeting={meeting}
        entries={entries}
        onCreated={() => setEntries([])}
        people={people.data ?? []}
        peopleLoading={people.isPending}
      />
      {permissions.canEdit && (
        <MeetingEditDialog meetingId={meeting._id} open={editOpen} onOpenChange={setEditOpen} />
      )}
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        pending={remove.isPending}
        destructive
        title={`Delete “${meeting.title}”?`}
        description="The transcript, notes and suggestions are removed for everyone. Tasks created from it are kept — they just lose the link back to the meeting."
        confirmLabel="Delete meeting"
        icon={<LuTrash2 aria-hidden />}
        onConfirm={() =>
          remove.mutate(meeting._id, {
            onSuccess: () => {
              setDeleteOpen(false);
              void navigate(meeting.project ? `/projects/${meeting.project._id}?tab=meetings` : "/meetings");
            },
          })
        }
      />
    </div>
  );
}

function MeetingSkeleton() {
  return (
    <div
      className="mx-auto w-full max-w-[90rem] space-y-5 px-4 py-6 sm:px-6 lg:px-8"
      aria-busy="true"
      aria-label="Loading meeting"
    >
      <Skeleton className="h-4 w-28" />
      <Skeleton className="h-8 w-2/3 max-w-lg" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-xl border p-4">
          {Array.from({ length: 7 }).map((_, index) => (
            <div key={index} className="space-y-1.5">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="h-4 w-full" />
            </div>
          ))}
        </div>
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}
