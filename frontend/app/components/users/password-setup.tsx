import { useState } from "react";
import {
  LuCheck,
  LuCopy,
  LuKeyRound,
  LuLink,
  LuLockKeyhole,
  LuMailCheck,
  LuSend,
  LuSheet,
  LuTriangleAlert,
} from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { RowActions } from "@/components/globals/data-table/row-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/toast";
import {
  MAX_BULK_PASSWORD_LINKS,
  setupLinksCsv,
  useBulkPasswordLinks,
  useSetDefaultPassword,
  useCreatePasswordLink,
  writeClipboard,
  type BulkPasswordLinkRow,
  type BulkPasswordLinksResult,
} from "@/hooks/use-password-setup";
import { cn } from "@/lib/utils";
import type { User } from "@/types";

/* ------------------------------------------------------------------ */
/* Badge + filter chip                                                 */
/* ------------------------------------------------------------------ */

/** Shown on users who can't sign in until they set a password via a link. */
export function NeedsPasswordBadge() {
  return (
    <Badge
      variant="outline"
      className="shrink-0 border-warn/40 bg-warn/10 text-warn"
      title="This user can't sign in until they set a password with a link"
    >
      <LuKeyRound aria-hidden />
      Needs password
    </Badge>
  );
}

/** Toggle chip for the `passwordSetup=required` filter, with the live count. */
export function NeedsPasswordFilterChip({
  count,
  active,
  onToggle,
}: {
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "outline"}
      aria-pressed={active}
      onClick={onToggle}
      aria-label={`Needs password (${count})`}
      className={cn(active && "ring-1 ring-ring/40")}
    >
      <LuKeyRound aria-hidden className={cn(!active && "text-warn")} />
      Needs password
      <span
        aria-hidden
        className={cn(
          "rounded-full px-1.5 text-xs tabular-nums",
          active
            ? "bg-background text-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        {count}
      </span>
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* Row actions                                                         */
/* ------------------------------------------------------------------ */

/** Row ⋮ menu: email a new set-password link, or create one and copy it. */
export function PasswordLinkRowActions({ user }: { user: User }) {
  const create = useCreatePasswordLink();
  const pending = create.isPending;
  return (
    <RowActions
      label={`Password link actions for ${user.name}`}
      actions={[
        {
          label: "Send set-password link",
          icon: LuSend,
          disabled: pending,
          onSelect: () => create.mutate({ user, sendEmail: true }),
        },
        {
          label: "Copy link",
          icon: LuLink,
          disabled: pending,
          onSelect: () => create.mutate({ user, sendEmail: false }),
        },
      ]}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Bulk: confirm → results                                             */
/* ------------------------------------------------------------------ */

/** "Send links to all needing a password" with a confirm step and a results dialog. */
export function BulkPasswordLinksButton({ count }: { count: number }) {
  const bulk = useBulkPasswordLinks();
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<BulkPasswordLinksResult | null>(null);
  const capped = Math.min(count, MAX_BULK_PASSWORD_LINKS);

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setConfirming(true)}
        disabled={count === 0}
      >
        <LuSend aria-hidden />
        Send links to all needing a password
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Send set-password links to ${capped} ${capped === 1 ? "user" : "users"}?`}
        description={
          <>
            Each user gets a new link that works once and expires in 7 days; any
            older unused link stops working. Links are emailed when email is
            configured — either way you&apos;ll see every link to copy.
            {count > MAX_BULK_PASSWORD_LINKS &&
              ` Only the first ${MAX_BULK_PASSWORD_LINKS} are sent per batch.`}
          </>
        }
        confirmLabel="Send links"
        icon={<LuSend aria-hidden />}
        pending={bulk.isPending}
        onConfirm={() =>
          bulk.mutate(undefined, {
            onSuccess: (data) => {
              setConfirming(false);
              setResult(data);
            },
          })
        }
      />

      <PasswordLinksResultsDialog
        result={result}
        onOpenChange={(open) => {
          if (!open) setResult(null);
        }}
      />
    </>
  );
}

function PasswordLinksResultsDialog({
  result,
  onOpenChange,
}: {
  result: BulkPasswordLinksResult | null;
  onOpenChange: (open: boolean) => void;
}) {
  const rows = result?.rows ?? [];
  const ready = rows.filter((row) => row.setupUrl);
  const emailed = ready.filter((row) => row.emailed).length;
  const failed = rows.length - ready.length;

  async function copyCsv() {
    const ok = await writeClipboard(setupLinksCsv(rows));
    toast.add(
      ok
        ? {
            type: "success",
            title: `Copied ${ready.length} ${ready.length === 1 ? "link" : "links"} as CSV`,
            description:
              "Paste into a spreadsheet. Treat these links like passwords.",
          }
        : {
            type: "error",
            title: "Couldn't copy",
            description: "Your browser blocked clipboard access.",
          },
    );
  }

  return (
    <Dialog open={result !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Set-password links</DialogTitle>
          <DialogDescription>
            {rows.length === 0
              ? "Nobody needs a password right now."
              : result?.emailConfigured
                ? `${emailed} of ${ready.length} ${ready.length === 1 ? "link was" : "links were"} emailed. You can also copy any link and share it yourself.`
                : `Email isn't configured, so nothing was sent. Copy the links below and share each one with its owner.`}{" "}
            Links work once and expire in 7 days.
          </DialogDescription>
        </DialogHeader>

        {(failed > 0 || (result?.remaining ?? 0) > 0) && (
          <Alert>
            <LuTriangleAlert aria-hidden className="size-4" />
            <AlertTitle>Not everyone got a link</AlertTitle>
            <AlertDescription>
              {failed > 0 &&
                `${failed} ${failed === 1 ? "user" : "users"} couldn't get a link (they may have been deleted). `}
              {(result?.remaining ?? 0) > 0 &&
                `${result?.remaining} more ${result?.remaining === 1 ? "user needs" : "users need"} a password — run this again for the next batch.`}
            </AlertDescription>
          </Alert>
        )}

        {rows.length > 0 && (
          <ul
            className="-mx-1 min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border"
            aria-label="Links by user"
          >
            {rows.map((row) => (
              <ResultRow key={row.userId} row={row} />
            ))}
          </ul>
        )}

        <DialogFooter className="gap-2">
          {ready.length > 0 && (
            <Button variant="outline" onClick={() => void copyCsv()}>
              <LuSheet aria-hidden />
              Copy all as CSV (name,email,link)
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ResultRow({ row }: { row: BulkPasswordLinkRow }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!row.setupUrl) return;
    if (await writeClipboard(row.setupUrl)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } else {
      toast.add({
        type: "error",
        title: "Couldn't copy",
        description: "Your browser blocked clipboard access.",
      });
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
        <p className="truncate text-xs text-muted-foreground">{row.email}</p>
      </div>
      {row.failed ? (
        <Badge variant="destructive" className="shrink-0">
          No link
        </Badge>
      ) : row.emailed ? (
        <Badge variant="secondary" className="shrink-0">
          <LuMailCheck aria-hidden />
          Emailed
        </Badge>
      ) : (
        <Badge variant="outline" className="shrink-0">
          <LuLink aria-hidden />
          Link ready
        </Badge>
      )}
      {row.setupUrl && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => void copy()}
          aria-label={
            copied ? `Copied link for ${row.name}` : `Copy link for ${row.name}`
          }
          className="shrink-0"
        >
          {copied ? (
            <LuCheck aria-hidden className="text-primary" />
          ) : (
            <LuCopy aria-hidden />
          )}
        </Button>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Default password for everyone                                       */
/* ------------------------------------------------------------------ */

/** Admin: give every pending (or every) employee the same password; they change it at sign-in. */
export function DefaultPasswordButton({
  pendingCount,
}: {
  pendingCount: number;
}) {
  const setDefault = useSetDefaultPassword();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [scope, setScope] = useState<"pending" | "all">("pending");
  const [requireChange, setRequireChange] = useState(true);
  const [show, setShow] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const tooShort = password.length < 8;
  const mismatch = password !== confirm;

  function reset() {
    setPassword("");
    setConfirm("");
    setScope("pending");
    setRequireChange(true);
    setShow(false);
    setSubmitted(false);
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <LuLockKeyhole aria-hidden />
        Set default password
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (setDefault.isPending) return;
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Set a default password</DialogTitle>
            <DialogDescription>
              Everyone included can sign in with this password right away. Share
              it with them directly — it isn&apos;t emailed.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (tooShort || mismatch) return;
              setDefault.mutate(
                { password, scope, requireChange },
                {
                  onSuccess: () => {
                    setOpen(false);
                    reset();
                  },
                },
              );
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="default-password">Password</Label>
              <Input
                id="default-password"
                type={show ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                aria-invalid={(submitted && tooShort) || undefined}
                autoFocus
              />
              {submitted && tooShort && (
                <p className="text-xs text-destructive">
                  At least 8 characters.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="default-password-confirm">Confirm password</Label>
              <Input
                id="default-password-confirm"
                type={show ? "text" : "password"}
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="new-password"
                aria-invalid={(submitted && mismatch) || undefined}
              />
              {submitted && mismatch && (
                <p className="text-xs text-destructive">
                  The passwords don&apos;t match.
                </p>
              )}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                checked={show}
                onCheckedChange={(checked) => setShow(checked === true)}
              />
              Show password
            </label>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Apply to</legend>
              <RadioGroup
                value={scope}
                onValueChange={(value) => setScope(value as "pending" | "all")}
                className="gap-2"
              >
                <label className="flex cursor-pointer items-start gap-2.5">
                  <RadioGroupItem value="pending" className="mt-0.5" />
                  <span className="text-sm">
                    Employees without a password
                    <span className="block text-xs text-muted-foreground">
                      {pendingCount}{" "}
                      {pendingCount === 1 ? "account" : "accounts"} that
                      can&apos;t sign in yet
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-2.5">
                  <RadioGroupItem value="all" className="mt-0.5" />
                  <span className="text-sm">
                    Everyone except me
                    <span className="block text-xs text-muted-foreground">
                      Replaces existing passwords too and signs their other
                      devices out
                    </span>
                  </span>
                </label>
              </RadioGroup>
            </fieldset>
            <label className="flex cursor-pointer items-start gap-2.5">
              <Checkbox
                checked={requireChange}
                onCheckedChange={(checked) =>
                  setRequireChange(checked === true)
                }
                className="mt-0.5"
              />
              <span className="text-sm">
                Ask each person to choose their own password at the next sign-in
                <span className="block text-xs text-muted-foreground">
                  Recommended — the default password then stops working for
                  them.
                </span>
              </span>
            </label>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={setDefault.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  setDefault.isPending ||
                  (scope === "pending" && pendingCount === 0)
                }
              >
                {setDefault.isPending
                  ? "Setting…"
                  : scope === "all"
                    ? "Set for everyone"
                    : `Set for ${pendingCount}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
