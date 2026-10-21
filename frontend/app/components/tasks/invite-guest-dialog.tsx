import { useEffect, useState, type FormEvent } from "react";
import { LuCheck, LuCopy, LuLoaderCircle, LuUserPlus } from "react-icons/lu";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { toast } from "@/components/ui/toast";
import { writeClipboard } from "@/hooks/use-password-setup";
import { useInviteTaskGuest } from "@/hooks/use-tasks";
import { getErrorMessage } from "@/lib/api";
import type { Task } from "@/types";

/** Marks an outside person (invited to specific tasks only). */
export function GuestBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="outline"
      className={className ?? "h-4 shrink-0 px-1.5 text-[10px]"}
      title="Outside guest — sees only the tasks they are invited to"
    >
      Guest
    </Badge>
  );
}

/**
 * "Invite outside person": name + email → the server adds them to the task as
 * an assignee and emails a set-password link (an existing employee is just
 * assigned; company emails can't be guests). When email is off, admins get
 * the link to pass on.
 */
export function InviteGuestDialog({
  task,
  open,
  onOpenChange,
}: {
  task: Task;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invite = useInviteTaskGuest();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setEmail("");
      setSetupUrl(null);
      setCopied(false);
      invite.reset();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim()) return;
    invite.mutate(
      { id: task._id, name: name.trim(), email: email.trim() },
      {
        onSuccess: (data) => {
          if (data.invite.setupUrl) setSetupUrl(data.invite.setupUrl);
          else onOpenChange(false);
        },
      }
    );
  }

  async function copy() {
    if (!setupUrl) return;
    if (await writeClipboard(setupUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.add({ type: "error", title: "Couldn't copy", description: "Your browser blocked clipboard access." });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !invite.isPending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite outside person</DialogTitle>
          <DialogDescription>
            They get an email to set a password and can then open only this task (and any other they&apos;re
            invited to): comment, add files, log time and submit it.
          </DialogDescription>
        </DialogHeader>
        {setupUrl ? (
          <div className="space-y-3">
            <Alert>
              <AlertDescription>
                Email is off, so nothing was sent. Send this one-time set-password link to the person yourself — it
                expires in 7 days.
              </AlertDescription>
            </Alert>
            <div className="flex gap-2">
              <Input readOnly value={setupUrl} aria-label="Set-password link" className="font-mono text-xs" />
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {copied ? <LuCheck aria-hidden /> : <LuCopy aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="guest-name">Name</Label>
              <Input
                id="guest-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={100}
                autoComplete="off"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="guest-email">Email</Label>
              <Input
                id="guest-email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                autoComplete="off"
                required
              />
              <p className="text-xs text-muted-foreground">
                A colleague&apos;s company email adds them as a normal assignee instead.
              </p>
            </div>
            {invite.isError && (
              <p role="alert" className="text-sm text-destructive">
                {getErrorMessage(invite.error)}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={invite.isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={invite.isPending || !name.trim() || !email.trim()}>
                {invite.isPending ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuUserPlus aria-hidden />
                )}
                Invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
