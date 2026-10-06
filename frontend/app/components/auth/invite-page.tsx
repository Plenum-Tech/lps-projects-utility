import { useState, type FormEvent, type ReactNode } from "react";
import axios from "axios";
import type { IconType } from "react-icons";
import {
  LuBan,
  LuCalendarX,
  LuCheck,
  LuCircleAlert,
  LuCircleCheck,
  LuEye,
  LuEyeOff,
  LuLink2Off,
  LuLoaderCircle,
  LuLogIn,
  LuLogOut,
  LuRefreshCw,
  LuUserPlus,
} from "react-icons/lu";
import { Link, useNavigate } from "react-router";

import { formatDate } from "@/lib/format";
import { BrandPanel } from "@/components/auth/login-page";
import { BrandHeader } from "@/components/layout/brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useCurrentUser, useLogout } from "@/hooks/use-auth";
import { useAcceptInvitation, useInvitationPreview } from "@/hooks/use-invitations";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { InvitationPreview, Role } from "@/types";

const ROLE_LABELS: Record<Role, string> = {
  employee: "an employee",
  head: "head of department",
  admin: "an admin",
};

type GoneReason = "expired" | "revoked" | "accepted";

function previewFailure(error: unknown): { status?: number; reason?: GoneReason } {
  if (!axios.isAxiosError<{ reason?: GoneReason }>(error)) return {};
  return { status: error.response?.status, reason: error.response?.data?.reason };
}

/**
 * Public /invite/:token page: shows who invited you and lets you set a name and
 * password. Same split-screen look as the sign-in page. Handles invalid,
 * expired, revoked and used links, and someone else already being signed in.
 */
export function InvitePage({ token }: { token: string }) {
  const me = useCurrentUser();
  const preview = useInvitationPreview(token);

  let content: ReactNode;
  if (me.isPending || preview.isPending) {
    content = <InviteSkeleton />;
  } else if (preview.isError) {
    const { status, reason } = previewFailure(preview.error);
    if (status === 404) {
      content = (
        <StateCard
          icon={LuLink2Off}
          title="This invite link isn't valid"
          description="The link may be incomplete, or a newer invite replaced it. Ask your admin for a new invite."
        />
      );
    } else if (status === 410 && reason) {
      content = <GoneCard reason={reason} signedIn={Boolean(me.data)} />;
    } else {
      content = (
        <StateCard
          icon={LuCircleAlert}
          tone="destructive"
          title="Couldn't load your invite"
          description={getErrorMessage(preview.error)}
          action={
            status === 429 ? undefined : (
              <Button variant="outline" onClick={() => void preview.refetch()} disabled={preview.isRefetching}>
                {preview.isRefetching ? (
                  <LuLoaderCircle aria-hidden className="animate-spin" />
                ) : (
                  <LuRefreshCw aria-hidden />
                )}
                Try again
              </Button>
            )
          }
        />
      );
    }
  } else if (me.data && me.data.email !== preview.data.email) {
    // After accepting, `me` becomes the invited user: the form stays mounted while it navigates.
    content = <SignedInAsSomeoneElse name={me.data.name} email={me.data.email} />;
  } else {
    content = <AcceptCard token={token} invite={preview.data} />;
  }

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <BrandHeader className="mb-8 lg:hidden" />
          {content}
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Valid invite: create account                                        */
/* ------------------------------------------------------------------ */

const STRENGTH_RULES: { label: string; test: (value: string) => boolean; required?: boolean }[] = [
  { label: "At least 8 characters", test: (v) => v.length >= 8, required: true },
  { label: "Upper and lower case letters", test: (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) },
  { label: "A number", test: (v) => /\d/.test(v) },
  { label: "A symbol", test: (v) => /[^A-Za-z0-9]/.test(v) },
];

const STRENGTH_LEVELS = [
  { label: "Too short", className: "bg-destructive" },
  { label: "Weak", className: "bg-destructive" },
  { label: "Fair", className: "bg-chart-4" },
  { label: "Good", className: "bg-primary/70" },
  { label: "Strong", className: "bg-primary" },
];

function AcceptCard({ token, invite }: { token: string; invite: InvitationPreview }) {
  const accept = useAcceptInvitation(token);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const passed = STRENGTH_RULES.filter((rule) => rule.test(password)).length;
  const level = password.length < 8 ? 0 : passed;
  const nameInvalid = submitted && name.trim() === "";
  const passwordInvalid = submitted && password.length < 8;
  const confirmInvalid = submitted && confirm !== password;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || password.length < 8 || confirm !== password) return;
    accept.mutate(
      { name: name.trim(), password },
      {
        onSuccess: (data) => {
          const firstName = data.user.name.split(/\s+/)[0] || data.user.name;
          toast.add({
            type: "success",
            title: `Welcome to EMS, ${firstName}!`,
            description: "Your account is ready.",
          });
          for (const notice of data.notices) toast.add({ type: "warning", title: notice });
          navigate("/dashboard", { replace: true });
        },
      }
    );
  }

  const expires = formatDate(invite.expiresAt);

  return (
    <Card className="w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
      <CardHeader>
        <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LuUserPlus aria-hidden className="size-5" />
        </span>
        <CardTitle className="text-xl">Join EMS</CardTitle>
        <CardDescription>
          <span className="font-medium text-foreground">{invite.invitedBy.name}</span> invited you as{" "}
          {ROLE_LABELS[invite.role]}
          {invite.department ? (
            <>
              {" "}
              in <span className="font-medium text-foreground">{invite.department.name}</span>
            </>
          ) : null}
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" value={invite.email} readOnly aria-readonly className="bg-muted/50" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-name">Full name</Label>
            <Input
              id="invite-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jane Doe"
              autoComplete="name"
              autoFocus
              maxLength={100}
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "invite-name-error" : undefined}
            />
            {nameInvalid && (
              <p id="invite-name-error" className="text-xs text-destructive">
                Enter your name.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-password">Password</Label>
            <div className="relative">
              <Input
                id="invite-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                aria-invalid={passwordInvalid}
                aria-describedby="invite-password-hints"
                className="pr-9"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? <LuEyeOff aria-hidden /> : <LuEye aria-hidden />}
              </Button>
            </div>
            <div id="invite-password-hints" className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <div className="flex flex-1 gap-1" aria-hidden>
                  {[1, 2, 3, 4].map((step) => (
                    <span
                      key={step}
                      className={cn(
                        "h-1 flex-1 rounded-full bg-muted transition-colors duration-200 ease-out",
                        password && level >= step && STRENGTH_LEVELS[level]!.className
                      )}
                    />
                  ))}
                </div>
                <span className="w-16 text-right text-xs text-muted-foreground" aria-live="polite">
                  {password ? STRENGTH_LEVELS[level]!.label : ""}
                </span>
              </div>
              <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
                {STRENGTH_RULES.map((rule) => {
                  const ok = rule.test(password);
                  return (
                    <li
                      key={rule.label}
                      className={cn(
                        "flex items-center gap-1.5",
                        ok ? "text-foreground" : passwordInvalid && rule.required ? "text-destructive" : "text-muted-foreground"
                      )}
                    >
                      {ok ? (
                        <LuCheck aria-hidden className="size-3 text-primary" />
                      ) : (
                        <span aria-hidden className="size-1.5 rounded-full bg-current opacity-50" />
                      )}
                      {rule.label}
                      {rule.required ? "" : " (recommended)"}
                      <span className="sr-only">{ok ? ": met" : ": not met"}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-confirm">Confirm password</Label>
            <Input
              id="invite-confirm"
              type={showPassword ? "text" : "password"}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              aria-invalid={confirmInvalid}
              aria-describedby={confirmInvalid ? "invite-confirm-error" : undefined}
            />
            {confirmInvalid && (
              <p id="invite-confirm-error" className="text-xs text-destructive">
                Passwords don&apos;t match.
              </p>
            )}
          </div>

          {accept.isError && (
            <Alert variant="destructive">
              <LuCircleAlert aria-hidden className="size-4" />
              <AlertTitle>Couldn&apos;t create your account</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{getErrorMessage(accept.error)}</p>
                {previewFailure(accept.error).status === 409 && (
                  <Link to="/" className={buttonVariants({ variant: "outline", size: "sm" })}>
                    <LuLogIn aria-hidden />
                    Go to sign in
                  </Link>
                )}
              </AlertDescription>
            </Alert>
          )}

          <Button type="submit" className="w-full" disabled={accept.isPending}>
            {accept.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
            {accept.isPending ? "Creating account…" : "Create account"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">This invite expires on {expires}.</p>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Other states                                                        */
/* ------------------------------------------------------------------ */

function StateCard({
  icon: Icon,
  title,
  description,
  action,
  tone = "muted",
}: {
  icon: IconType;
  title: string;
  description: ReactNode;
  action?: ReactNode;
  tone?: "muted" | "destructive";
}) {
  return (
    <Card className="w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200" role="status">
      <CardHeader>
        <span
          className={cn(
            "mb-2 flex size-10 items-center justify-center rounded-xl",
            tone === "destructive" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon aria-hidden className="size-5" />
        </span>
        <CardTitle className="text-xl">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {action && <CardFooter className="flex flex-wrap gap-2">{action}</CardFooter>}
    </Card>
  );
}

const GONE_COPY: Record<GoneReason, { icon: IconType; title: string; description: string }> = {
  expired: {
    icon: LuCalendarX,
    title: "This invite has expired",
    description: "Invite links are valid for 7 days. Ask your admin for a new invite.",
  },
  revoked: {
    icon: LuBan,
    title: "This invite was revoked",
    description: "An admin cancelled this invite. Ask your admin for a new invite if you still need access.",
  },
  accepted: {
    icon: LuCircleCheck,
    title: "This invite was already used",
    description: "An account was already created with this link. Sign in with your email and password.",
  },
};

function GoneCard({ reason, signedIn }: { reason: GoneReason; signedIn: boolean }) {
  const copy = GONE_COPY[reason];
  return (
    <StateCard
      icon={copy.icon}
      title={copy.title}
      description={copy.description}
      action={
        signedIn ? (
          <Link to="/dashboard" className={buttonVariants({ variant: "outline", className: "w-full" })}>
            Go to dashboard
          </Link>
        ) : reason === "accepted" ? (
          <Link to="/" className={buttonVariants({ className: "w-full" })}>
            <LuLogIn aria-hidden />
            Go to sign in
          </Link>
        ) : undefined
      }
    />
  );
}

function SignedInAsSomeoneElse({ name, email }: { name: string; email: string }) {
  const logout = useLogout();
  return (
    <StateCard
      icon={LuLogOut}
      title="You're already signed in"
      description={
        <>
          You&apos;re signed in as <span className="font-medium text-foreground">{name}</span> ({email}). Sign out to
          accept this invite.
        </>
      }
      action={
        <>
          <Button onClick={() => logout.mutate()} disabled={logout.isPending}>
            {logout.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuLogOut aria-hidden />}
            Sign out
          </Button>
          <Link to="/dashboard" className={buttonVariants({ variant: "outline" })}>
            Go to dashboard
          </Link>
        </>
      }
    />
  );
}

function InviteSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Loading invite" className="w-full">
      <CardHeader>
        <Skeleton className="mb-2 size-10 rounded-xl" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="space-y-1.5">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-8 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}
