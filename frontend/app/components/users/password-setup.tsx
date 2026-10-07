import { useState } from "react";
import {
  LuCheck,
  LuCopy,
  LuKeyRound,
  LuLink,
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
import { toast } from "@/components/ui/toast";
import {
  MAX_BULK_PASSWORD_LINKS,
  setupLinksCsv,
  useBulkPasswordLinks,
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
          active ? "bg-background text-foreground" : "bg-muted text-muted-foreground"
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
      <Button variant="outline" onClick={() => setConfirming(true)} disabled={count === 0}>
        <LuSend aria-hidden />
        Send links to all needing a password
      </Button>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Send set-password links to ${capped} ${capped === 1 ? "user" : "users"}?`}
        description={
          <>
            Each user gets a new link that works once and expires in 7 days; any older unused link stops working. Links
            are emailed when email is configured — either way you&apos;ll see every link to copy.
            {count > MAX_BULK_PASSWORD_LINKS && ` Only the first ${MAX_BULK_PASSWORD_LINKS} are sent per batch.`}
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
        ? { type: "success", title: `Copied ${ready.length} ${ready.length === 1 ? "link" : "links"} as CSV`, description: "Paste into a spreadsheet. Treat these links like passwords." }
        : { type: "error", title: "Couldn't copy", description: "Your browser blocked clipboard access." }
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
              {failed > 0 && `${failed} ${failed === 1 ? "user" : "users"} couldn't get a link (they may have been deleted). `}
              {(result?.remaining ?? 0) > 0 &&
                `${result?.remaining} more ${result?.remaining === 1 ? "user needs" : "users need"} a password — run this again for the next batch.`}
            </AlertDescription>
          </Alert>
        )}

        {rows.length > 0 && (
          <ul className="-mx-1 min-h-0 flex-1 divide-y overflow-y-auto rounded-lg border" aria-label="Links by user">
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
      toast.add({ type: "error", title: "Couldn't copy", description: "Your browser blocked clipboard access." });
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
          aria-label={copied ? `Copied link for ${row.name}` : `Copy link for ${row.name}`}
          className="shrink-0"
        >
          {copied ? <LuCheck aria-hidden className="text-primary" /> : <LuCopy aria-hidden />}
        </Button>
      )}
    </li>
  );
}
