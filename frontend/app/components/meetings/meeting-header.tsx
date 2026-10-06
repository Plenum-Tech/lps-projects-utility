import { useState } from "react";
import { Link } from "react-router";
import {
  LuArrowLeft,
  LuCalendarDays,
  LuClipboardPaste,
  LuDownload,
  LuEllipsisVertical,
  LuFileText,
  LuLightbulb,
  LuLoaderCircle,
  LuLock,
  LuPencil,
  LuShieldCheck,
  LuSparkles,
  LuTrash2,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { ShortCode } from "@/components/projects/project-badges";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useDownloadTranscript,
  useExtractWithAi,
  useRegenerateHints,
} from "@/hooks/use-meetings";
import { hasSeenAiNotice, markAiNoticeSeen, speakerTones } from "@/lib/meetings";
import { formatPlainDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { MeetingDetailResponse } from "@/types";

/** Title, facts, speakers and the meeting actions (Extract with AI, Download, Edit, …). */
export function MeetingHeader({
  detail,
  onEdit,
  onDelete,
}: {
  detail: MeetingDetailResponse;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { meeting, permissions, aiEnabled } = detail;
  const extract = useExtractWithAi(meeting._id);
  const hints = useRegenerateHints(meeting._id);
  const download = useDownloadTranscript();
  const [noticeOpen, setNoticeOpen] = useState(false);
  const tones = speakerTones(meeting.speakers.map((speaker) => speaker.name));
  const SourceIcon = meeting.source === "paste" ? LuClipboardPaste : LuFileText;

  function runExtract() {
    if (!hasSeenAiNotice()) {
      setNoticeOpen(true);
      return;
    }
    extract.mutate();
  }

  const showAi = aiEnabled && permissions.canEdit;
  const hasMenu = permissions.canEdit || permissions.canDelete;

  return (
    <header className="space-y-3">
      <Link
        to={meeting.project ? `/projects/${meeting.project._id}?tab=meetings` : "/meetings"}
        className="inline-flex items-center gap-1.5 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <LuArrowLeft aria-hidden className="size-4" />
        {meeting.project ? meeting.project.name : "Meetings"}
      </Link>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight break-words text-foreground sm:text-3xl">
            {meeting.title}
          </h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <LuCalendarDays aria-hidden className="size-4" />
              {formatPlainDate(meeting.meetingDate, "EEE, d MMM yyyy")}
            </span>
            {meeting.project ? (
              <Link
                to={`/projects/${meeting.project._id}`}
                className="inline-flex items-center gap-1.5 text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline"
              >
                <ShortCode code={meeting.project.code} />
                {meeting.project.name}
              </Link>
            ) : (
              <span className="inline-flex items-center gap-1.5" title="Visible only to the creator and admins">
                <LuLock aria-hidden className="size-3.5" />
                Private
              </span>
            )}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <SourceIcon aria-hidden className="size-4 shrink-0" />
              <span className="truncate">{meeting.file?.filename ?? "Pasted transcript"}</span>
            </span>
            <span>Added by {meeting.createdBy.name}</span>
          </p>
          {meeting.speakers.length > 0 && (
            <ul aria-label="Speakers" className="flex flex-wrap gap-1.5">
              {meeting.speakers.map((speaker) => (
                <li
                  key={speaker.name}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background py-0.5 pr-2.5 pl-1 text-xs"
                  title={speaker.user ? `${speaker.name} → ${speaker.user.name}` : `${speaker.name} (not in EMS)`}
                >
                  <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", tones.get(speaker.name)?.dot)} />
                  <span className="truncate font-medium text-foreground">{speaker.user?.name ?? speaker.name}</span>
                  {!speaker.user && <span className="text-muted-foreground">· guest</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showAi && (
            <Button onClick={runExtract} disabled={extract.isPending} aria-describedby="ai-note">
              {extract.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSparkles aria-hidden />
              )}
              {extract.isPending ? "Extracting… (up to a minute)" : "Extract with AI"}
            </Button>
          )}
          {meeting.file && (
            <Button
              variant="outline"
              onClick={() => download.mutate({ id: meeting._id, filename: meeting.file?.filename ?? "transcript" })}
              disabled={download.isPending}
            >
              {download.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuDownload aria-hidden />}
              Download
            </Button>
          )}
          {permissions.canEdit && (
            <Button variant="outline" onClick={onEdit}>
              <LuPencil aria-hidden />
              Edit
            </Button>
          )}
          {hasMenu && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="More meeting actions" />}>
                <LuEllipsisVertical aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-auto min-w-52">
                <DropdownMenuGroup>
                  {permissions.canEdit && (
                    <DropdownMenuItem onClick={() => hints.mutate()} disabled={hints.isPending}>
                      <LuLightbulb aria-hidden />
                      Regenerate smart hints
                    </DropdownMenuItem>
                  )}
                  {permissions.canDelete && (
                    <>
                      {permissions.canEdit && <DropdownMenuSeparator />}
                      <DropdownMenuItem variant="destructive" onClick={onDelete}>
                        <LuTrash2 aria-hidden />
                        Delete meeting
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {showAi && (
        <p id="ai-note" className="flex items-center gap-1.5 text-xs text-muted-foreground lg:justify-end">
          <LuShieldCheck aria-hidden className="size-3.5" />
          Smart hints run on the EMS server. “Extract with AI” sends the transcript to Google Gemini.
          {meeting.aiExtractedAt && ` Last run ${formatPlainDate(meeting.aiExtractedAt)}.`}
        </p>
      )}

      <ConfirmDialog
        open={noticeOpen}
        onOpenChange={setNoticeOpen}
        title="Send this transcript to Google Gemini?"
        description={
          <>
            Extract with AI sends the transcript text of this meeting to Google Gemini to propose
            action items, owners and due dates. Nothing becomes a task until you create it. Smart
            hints keep everything on the EMS server. You won&apos;t see this notice again on this
            browser.
          </>
        }
        confirmLabel="Continue"
        icon={<LuSparkles aria-hidden />}
        onConfirm={() => {
          markAiNoticeSeen();
          setNoticeOpen(false);
          extract.mutate();
        }}
      />
    </header>
  );
}
