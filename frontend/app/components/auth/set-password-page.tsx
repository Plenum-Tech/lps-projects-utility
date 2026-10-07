import { useState, type FormEvent, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  LuCalendarX,
  LuCircleAlert,
  LuCircleCheck,
  LuHistory,
  LuKeyRound,
  LuLink2Off,
  LuLoaderCircle,
  LuLogIn,
  LuRefreshCw,
} from "react-icons/lu";
import { Link, useNavigate } from "react-router";

import {
  AuthCardSkeleton,
  AuthSplitLayout,
  AuthStateCard,
  SignedInAsSomeoneElse,
} from "@/components/auth/auth-shell";
import { NewPasswordFields, newPasswordValid } from "@/components/auth/new-password-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  passwordSetupFailure,
  useCompletePasswordSetup,
  usePasswordSetupPreview,
} from "@/hooks/use-password-setup";
import { getErrorMessage } from "@/lib/api";
import { PRODUCT_NAME } from "@/lib/brand";
import { formatDate } from "@/lib/format";
import type { PasswordSetupGoneReason, PasswordSetupPreview } from "@/types";

/**
 * Public /set-password/:token page for accounts that need a password (imported
 * users, or an admin-issued reset). Same split-screen look as sign-in and
 * invites. Handles unknown, used, expired and replaced links, and someone else
 * already being signed in on this browser.
 */
export function SetPasswordPage({ token }: { token: string }) {
  const me = useCurrentUser();
  const preview = usePasswordSetupPreview(token);

  let content: ReactNode;
  if (me.isPending || preview.isPending) {
    content = <AuthCardSkeleton label="Loading your link" fields={3} />;
  } else if (preview.isError) {
    const { status, reason } = passwordSetupFailure(preview.error);
    if (status === 404) {
      content = <InvalidLinkCard signedIn={Boolean(me.data)} />;
    } else if (status === 410 && reason) {
      content = <GoneLinkCard reason={reason} signedIn={Boolean(me.data)} />;
    } else {
      content = (
        <AuthStateCard
          icon={LuCircleAlert}
          tone="destructive"
          title="Couldn't load your link"
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
  } else if (me.data && me.data.email.toLowerCase() !== preview.data.email.toLowerCase()) {
    content = (
      <SignedInAsSomeoneElse name={me.data.name} email={me.data.email} purpose="set the password for this account" />
    );
  } else {
    // After success `me` becomes this same account, so the form stays mounted while it navigates.
    content = <SetPasswordCard token={token} account={preview.data} />;
  }

  return <AuthSplitLayout>{content}</AuthSplitLayout>;
}

/* ------------------------------------------------------------------ */
/* Valid link: choose a password                                       */
/* ------------------------------------------------------------------ */

function SetPasswordCard({ token, account }: { token: string; account: PasswordSetupPreview }) {
  const complete = useCompletePasswordSetup(token);
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const failure = complete.isError ? passwordSetupFailure(complete.error) : null;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!newPasswordValid(password, confirm)) return;
    complete.mutate(password, {
      onSuccess: (user) => {
        const firstName = user.name.split(/\s+/)[0] || user.name;
        toast.add({
          type: "success",
          title: `Welcome to ${PRODUCT_NAME}, ${firstName}!`,
          description: "Your password is set and you're signed in.",
        });
        navigate("/dashboard", { replace: true });
      },
    });
  }

  // The link stopped working between loading and submitting (used in another tab, replaced…).
  if (failure?.status === 410 && failure.reason) return <GoneLinkCard reason={failure.reason} signedIn={false} />;
  if (failure?.status === 404) return <InvalidLinkCard signedIn={false} />;

  return (
    <Card className="w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
      <CardHeader>
        <span className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <LuKeyRound aria-hidden className="size-5" />
        </span>
        <CardTitle className="text-xl">Set your password</CardTitle>
        <CardDescription>
          Choose a password for your {PRODUCT_NAME} account. You&apos;ll use it with your email to sign in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="set-password-name">Name</Label>
              <Input id="set-password-name" value={account.name} readOnly aria-readonly className="bg-muted/50" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="set-password-email">Email</Label>
              <Input
                id="set-password-email"
                type="email"
                value={account.email}
                readOnly
                aria-readonly
                autoComplete="username"
                className="bg-muted/50"
              />
            </div>
          </div>

          <NewPasswordFields
            idPrefix="set-password"
            label="New password"
            password={password}
            confirm={confirm}
            onPasswordChange={setPassword}
            onConfirmChange={setConfirm}
            submitted={submitted}
            autoFocus
          />

          {complete.isError && (
            <Alert variant="destructive">
              <LuCircleAlert aria-hidden className="size-4" />
              <AlertTitle>Couldn&apos;t set your password</AlertTitle>
              <AlertDescription>{getErrorMessage(complete.error)}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" className="w-full" disabled={complete.isPending || complete.isSuccess}>
            {complete.isPending || complete.isSuccess ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuCircleCheck aria-hidden />
            )}
            {complete.isPending || complete.isSuccess ? "Setting password…" : "Set password and sign in"}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            This link works once and expires on {formatDate(account.expiresAt)}.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Other states                                                        */
/* ------------------------------------------------------------------ */

function InvalidLinkCard({ signedIn }: { signedIn: boolean }) {
  return (
    <AuthStateCard
      icon={LuLink2Off}
      title="This link isn't valid"
      description="The link may be incomplete — open it straight from your email or message, or ask your administrator for a new one."
      action={
        signedIn ? (
          <Link to="/dashboard" className={buttonVariants({ variant: "outline", className: "w-full" })}>
            Go to dashboard
          </Link>
        ) : (
          <SignInLink variant="outline" />
        )
      }
    />
  );
}

const GONE_COPY: Record<PasswordSetupGoneReason, { icon: IconType; title: string; description: string }> = {
  used: {
    icon: LuCircleCheck,
    title: "This link was already used",
    description: "Your password has already been set with this link. Sign in with your email and password.",
  },
  expired: {
    icon: LuCalendarX,
    title: "This link has expired",
    description: "Set-password links are valid for 7 days. Ask your administrator for a new link.",
  },
  revoked: {
    icon: LuHistory,
    title: "A newer link was sent",
    description: "This link was replaced by a newer one. Use the latest link you received from your administrator.",
  },
};

function GoneLinkCard({ reason, signedIn }: { reason: PasswordSetupGoneReason; signedIn: boolean }) {
  const copy = GONE_COPY[reason];
  return (
    <AuthStateCard
      icon={copy.icon}
      title={copy.title}
      description={copy.description}
      action={
        signedIn ? (
          <Link to="/dashboard" className={buttonVariants({ variant: "outline", className: "w-full" })}>
            Go to dashboard
          </Link>
        ) : (
          <SignInLink variant={reason === "used" ? "default" : "outline"} />
        )
      }
    />
  );
}

function SignInLink({ variant }: { variant: "default" | "outline" }) {
  return (
    <Link to="/" className={buttonVariants({ variant, className: "w-full" })}>
      <LuLogIn aria-hidden />
      Go to sign in
    </Link>
  );
}
