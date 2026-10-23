import { useState } from "react";
import { Link } from "react-router";
import { LuLoaderCircle, LuSend } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useSendPlanEmail, useSendPlanForApproval } from "@/hooks/use-manpower";
import { formatDate, formatTimeOfDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PendingPlanRequestInfo, PlanNoticeInfo } from "@/types";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (at: string) => `${formatDate(at)} ${formatTimeOfDay(at)}`;

/**
 * Plan saves are kept quietly: leadership is told only when someone sends them.
 * "3 changes saved, not sent yet — Send for approval" / "1 new change since it was sent — Send update".
 * `canSend`: plan editors (and the person who saved); leadership (`savesApproved`) gets a link to review instead.
 */
export function PlanSendBanner({
  month,
  request,
  canSend,
  savesApproved,
  className,
}: {
  month: string;
  request: PendingPlanRequestInfo;
  canSend: boolean;
  savesApproved?: boolean;
  className?: string;
}) {
  const send = useSendPlanForApproval();
  const [note, setNote] = useState("");
  const saved = `Last saved${request.savedBy ? ` by ${request.savedBy.name}` : ""}, ${when(request.savedAt)}`;
  const sent = request.sentAt ? `Sent${request.sentBy ? ` by ${request.sentBy.name}` : ""}, ${when(request.sentAt)}` : "";

  if (request.sent && request.unsent === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        {sent || "Sent for approval"} — waiting for leadership.
      </p>
    );
  }

  const headline = request.sent
    ? `${plural(request.unsent, "new change")} since it was sent — not sent yet`
    : `${plural(request.changes, "change")} saved, not sent for approval yet`;
  const showSend = canSend && !savesApproved;

  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-foreground", className)}
    >
      <div className="min-w-0 flex-1">
        <p>
          <span className="font-medium">{headline}</span>
          {!showSend && <span className="text-muted-foreground"> · leadership hasn't been told</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {saved}
          {sent ? ` · ${sent}` : ""}
          {showSend ? " · Saves add up; leadership gets one email when you send." : ""}
        </p>
      </div>
      {showSend ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate({ month, note: note.trim() || undefined }, { onSuccess: () => setNote("") });
          }}
        >
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for leadership (optional)"
            maxLength={500}
            className="h-8 w-56"
            aria-label="Note for leadership"
          />
          <Button type="submit" size="sm" disabled={send.isPending}>
            {send.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
            {request.sent ? "Send update" : "Send for approval"}
          </Button>
        </form>
      ) : (
        <Link to={`/approvals/${request._id}`} className="text-primary underline underline-offset-2">
          Review the changes
        </Link>
      )}
    </div>
  );
}

/**
 * Leadership's saves go live quietly: "Version 36 saved — 4 changes not emailed yet — Send email".
 * One email then: the approvers get every change, each person affected their own lines.
 */
export function PlanEmailBanner({ month, notice, className }: { month: string; notice: PlanNoticeInfo; className?: string }) {
  const send = useSendPlanEmail();
  const [note, setNote] = useState("");
  const emailed = notice.emailedAt
    ? `Emailed${notice.emailedBy ? ` by ${notice.emailedBy.name}` : ""}, ${when(notice.emailedAt)}${notice.emailedVersion ? ` (version ${notice.emailedVersion})` : ""}`
    : "";
  if (notice.changes === 0) {
    return emailed ? <p className={cn("text-xs text-muted-foreground", className)}>{emailed}.</p> : null;
  }
  const saved = `Last saved${notice.savedBy ? ` by ${notice.savedBy.name}` : ""}, ${when(notice.savedAt)}`;
  return (
    <div
      role="status"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-sm text-foreground", className)}
    >
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {notice.emailedAt
            ? `${plural(notice.changes, "new change")} since the email — not emailed yet`
            : `Version ${notice.version} saved — ${plural(notice.changes, "change")} not emailed yet`}
        </p>
        <p className="text-xs text-muted-foreground">
          {saved}
          {emailed ? ` · ${emailed}` : ""}
          {` · Changes since ${notice.baseVersion != null ? `version ${notice.baseVersion}` : "the start"}; one email to leadership and the people affected.`}
        </p>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate({ month, note: note.trim() || undefined }, { onSuccess: () => setNote("") });
        }}
      >
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the email (optional)"
          maxLength={500}
          className="h-8 w-56"
          aria-label="Note for the email"
        />
        <Button type="submit" size="sm" disabled={send.isPending}>
          {send.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
          {notice.emailedAt ? "Send update" : "Send email"}
        </Button>
      </form>
    </div>
  );
}
