import { useState, type FormEvent } from "react";
import {
  LuCircleAlert,
  LuCircleCheck,
  LuLoaderCircle,
  LuMail,
  LuRefreshCw,
  LuSend,
  LuTriangleAlert,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmailStatus, useSendTestEmail } from "@/hooks/use-task-meta";
import { getErrorMessage } from "@/lib/api";
import type { SmtpStatus } from "@/types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** SMTP connection status (verified server-side) + "send test email". */
export function SmtpStatusCard({ adminEmail }: { adminEmail: string }) {
  const status = useEmailStatus();
  const sendTest = useSendTestEmail();
  const [to, setTo] = useState("");
  const toInvalid = to.trim() !== "" && !EMAIL_PATTERN.test(to.trim());

  const failure = (sendTest.error as { response?: { data?: { hint?: string } } } | null)
    ?.response?.data?.hint;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (toInvalid) return;
    sendTest.mutate(to.trim() || undefined);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuMail aria-hidden className="size-4 text-muted-foreground" />
          Email delivery (SMTP)
        </CardTitle>
        <CardDescription>
          Credentials live in the server&apos;s <code className="text-xs">.env</code> — never in
          the database.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {status.isPending || status.isFetching ? (
          <div className="flex items-center gap-3" aria-busy="true">
            <Skeleton className="size-9 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
            <span className="sr-only">Checking the SMTP connection…</span>
          </div>
        ) : status.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t check SMTP status</AlertTitle>
            <AlertDescription>{getErrorMessage(status.error)}</AlertDescription>
          </Alert>
        ) : (
          <StatusSummary status={status.data} />
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void status.refetch()}
            disabled={status.isFetching}
          >
            {status.isFetching ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuRefreshCw aria-hidden />
            )}
            Re-check connection
          </Button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="space-y-2 border-t pt-4">
          <Label htmlFor="test-email-to">Send a test email</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="test-email-to"
              type="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
              placeholder={adminEmail || "you@company.com"}
              aria-invalid={toInvalid || undefined}
              aria-describedby="test-email-hint"
              disabled={sendTest.isPending}
            />
            <Button type="submit" disabled={sendTest.isPending || toInvalid}>
              {sendTest.isPending ? (
                <LuLoaderCircle aria-hidden className="animate-spin" />
              ) : (
                <LuSend aria-hidden />
              )}
              {sendTest.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
          <p id="test-email-hint" className="text-xs text-muted-foreground">
            {toInvalid
              ? "Enter a valid email address."
              : "Leave empty to send it to your own address."}
          </p>

          {sendTest.isSuccess && (
            <Alert>
              <LuCircleCheck aria-hidden className="size-4" />
              <AlertTitle>Test email sent</AlertTitle>
              <AlertDescription>
                Sent to {sendTest.data.to}
                {sendTest.data.deliveredTo !== sendTest.data.to &&
                  ` (redirected to ${sendTest.data.deliveredTo})`}
                . Check the inbox — and spam — in a minute.
              </AlertDescription>
            </Alert>
          )}
          {sendTest.isError && (
            <Alert variant="destructive">
              <LuCircleAlert aria-hidden className="size-4" />
              <AlertTitle>Test email failed</AlertTitle>
              <AlertDescription>
                <p>{getErrorMessage(sendTest.error)}</p>
                {failure && <p className="mt-1">{failure}</p>}
              </AlertDescription>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function StatusSummary({ status }: { status: SmtpStatus }) {
  const tone = status.ok
    ? { icon: LuCircleCheck, box: "bg-primary/10 text-primary", title: "Connected" }
    : !status.configured
      ? { icon: LuTriangleAlert, box: "bg-chart-4/15 text-foreground", title: "Not configured" }
      : { icon: LuCircleAlert, box: "bg-destructive/10 text-destructive", title: "Connection failed" };
  const Icon = tone.icon;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tone.box}`}>
          <Icon aria-hidden className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{tone.title}</p>
          <p className="text-xs text-muted-foreground">
            {status.configured
              ? `${status.host ?? "SMTP"} · from ${status.from ?? "—"}`
              : "Set SMTP_HOST, SMTP_USER and SMTP_PASS in backend/.env — emails are skipped until then."}
          </p>
        </div>
      </div>
      {status.redirectTo && (
        <p className="rounded-md bg-chart-4/15 px-3 py-2 text-xs text-foreground">
          Dev redirect active: every email is delivered to <strong>{status.redirectTo}</strong>.
        </p>
      )}
      {(status.error || status.hint) && !status.ok && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
          {status.error && <p className="text-destructive">{status.error}</p>}
          {status.hint && <p className="mt-1 text-foreground">{status.hint}</p>}
        </div>
      )}
    </div>
  );
}
