import { useEffect, useState } from "react";
import { Link } from "react-router";
import { LuLoaderCircle, LuSend } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSendPlanEmail, useSendPlanForApproval } from "@/hooks/use-manpower";
import { useAssignableUsers } from "@/hooks/use-task-meta";
import { formatDate, formatTimeOfDay } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PendingPlanRequestInfo, PlanNoticeInfo, PlanNoticeRecipient } from "@/types";

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
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
 * Leadership's (and plan editors') saves go live quietly: "Version 36 saved — 4 changes not emailed yet — Send email".
 * "Send email" opens a picker of everyone who'd get it (all ticked); one email then to the ticked people:
 * approvers / anyone added get every change, each person whose lines changed their own lines.
 */
export function PlanEmailBanner({ month, notice, className }: { month: string; notice: PlanNoticeInfo; className?: string }) {
  const [open, setOpen] = useState(false);
  const emailed = notice.emailedAt
    ? `Emailed${notice.emailedTo ? ` to ${plural(notice.emailedTo, "person", "people")}` : ""}${notice.emailedBy ? ` by ${notice.emailedBy.name}` : ""}, ${when(notice.emailedAt)}${notice.emailedVersion ? ` (version ${notice.emailedVersion})` : ""}`
    : "";
  if (notice.changes === 0) {
    return emailed ? <p className={cn("text-xs text-muted-foreground", className)}>{emailed}.</p> : null;
  }
  const saved = `Last saved${notice.savedBy ? ` by ${notice.savedBy.name}` : ""}, ${when(notice.savedAt)}`;
  const label = notice.emailedAt ? "Send update" : "Send email";
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
          {` · Changes since ${notice.baseVersion != null ? `version ${notice.baseVersion}` : "the start"}; you pick who gets the email.`}
        </p>
      </div>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <LuSend aria-hidden />
        {label}
      </Button>
      <PlanEmailDialog month={month} notice={notice} label={label} open={open} onClose={() => setOpen(false)} />
    </div>
  );
}

/** "Who gets the email": the would-be recipients, all ticked, grouped; untick anyone, add someone; optional note. */
function PlanEmailDialog({ month, notice, label, open, onClose }: { month: string; notice: PlanNoticeInfo; label: string; open: boolean; onClose: () => void }) {
  const send = useSendPlanEmail();
  const recipients = notice.recipients ?? [];
  const [note, setNote] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState<Array<{ _id: string; name: string }>>([]);
  const [search, setSearch] = useState("");
  const staff = useAssignableUsers(open && search.trim().length >= 2, search.trim());

  // Opening starts with everyone ticked.
  useEffect(() => {
    if (!open) return;
    setTicked(new Set(recipients.map((r) => r._id)));
    setExtra([]);
    setSearch("");
    setNote("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const known = new Set([...recipients.map((r) => r._id), ...extra.map((x) => x._id)]);
  const matches = (staff.data ?? []).filter((u) => !known.has(u._id) && u._id !== notice.savedBy?._id).slice(0, 6);
  const toggle = (id: string, on: boolean) =>
    setTicked((t) => {
      const next = new Set(t);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const groups: Array<{ title: string; hint: string; people: PlanNoticeRecipient[] }> = [
    { title: "Leadership (FYI)", hint: "Every change", people: recipients.filter((r) => r.group === "leadership") },
    { title: "People whose lines changed", hint: "Their own changes", people: recipients.filter((r) => r.group === "people") },
  ];
  const count = ticked.size;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !send.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Who gets the email?</DialogTitle>
          <DialogDescription>
            {plural(notice.changes, "change")} in the {month} plan. Untick anyone who shouldn't get it — only ticked people are emailed and notified.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {groups.map((g) =>
            g.people.length ? (
              <section key={g.title} className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {g.title} · {g.hint}
                </h3>
                {g.people.map((r) => (
                  <label key={r._id} className="flex cursor-pointer items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={ticked.has(r._id)} onChange={(e) => toggle(r._id, e.target.checked)} />
                    <span className="min-w-0">
                      <span className="font-medium">{r.name}</span>
                      {r.lines.length ? <span className="block text-xs text-muted-foreground">{r.lines.join("; ")}</span> : null}
                    </span>
                  </label>
                ))}
              </section>
            ) : null,
          )}
          {extra.length > 0 && (
            <section className="space-y-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">Added by you · Every change</h3>
              {extra.map((x) => (
                <label key={x._id} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={ticked.has(x._id)} onChange={(e) => toggle(x._id, e.target.checked)} />
                  <span className="font-medium">{x.name}</span>
                </label>
              ))}
            </section>
          )}
          <div className="space-y-1">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="+ Add someone (type a name)" className="h-8" aria-label="Add someone" />
            {matches.length > 0 && (
              <ul className="rounded-md border bg-card text-sm">
                {matches.map((u) => (
                  <li key={u._id}>
                    <button
                      type="button"
                      className="w-full px-2 py-1 text-left hover:bg-muted"
                      onClick={() => {
                        setExtra((x) => [...x, { _id: u._id, name: u.name }]);
                        toggle(u._id, true);
                        setSearch("");
                      }}
                    >
                      {u.name}
                      {u.department?.name ? <span className="text-xs text-muted-foreground"> · {u.department.name}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the email (optional)" maxLength={500} className="h-8" aria-label="Note for the email" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={send.isPending || count === 0}
            onClick={() => send.mutate({ month, note: note.trim() || undefined, recipients: [...ticked] }, { onSuccess: onClose })}
          >
            {send.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
            {count === 0 ? "Pick at least one person" : `${label} to ${plural(count, "person", "people")}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
