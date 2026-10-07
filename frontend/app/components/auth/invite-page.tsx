import { useState, type FormEvent, type ReactNode } from "react";
import axios from "axios";
import type { IconType } from "react-icons";
import {
  LuBan,
  LuCalendarX,
  LuCircleAlert,
  LuCircleCheck,
  LuLink2Off,
  LuLoaderCircle,
  LuLogIn,
  LuRefreshCw,
  LuUserPlus,
} from "react-icons/lu";
import { Link, useNavigate } from "react-router";

import { formatDate } from "@/lib/format";
import {
  AuthCardSkeleton,
  AuthSplitLayout,
  AuthStateCard as StateCard,
  SignedInAsSomeoneElse,
} from "@/components/auth/auth-shell";
import { NewPasswordFields, newPasswordValid } from "@/components/auth/new-password-fields";
import { PRODUCT_NAME } from "@/lib/brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useCurrentUser } from "@/hooks/use-auth";
import { useAcceptInvitation, useInvitationPreview } from "@/hooks/use-invitations";
import { getErrorMessage } from "@/lib/api";
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
    content = <AuthCardSkeleton label="Loading invite" />;
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
    content = <SignedInAsSomeoneElse name={me.data.name} email={me.data.email} purpose="accept this invite" />;
  } else {
    content = <AcceptCard token={token} invite={preview.data} />;
  }

  return <AuthSplitLayout>{content}</AuthSplitLayout>;
}

/* ------------------------------------------------------------------ */
/* Valid invite: create account                                        */
/* ------------------------------------------------------------------ */

function AcceptCard({ token, invite }: { token: string; invite: InvitationPreview }) {
  const accept = useAcceptInvitation(token);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const nameInvalid = submitted && name.trim() === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || !newPasswordValid(password, confirm)) return;
    accept.mutate(
      { name: name.trim(), password },
      {
        onSuccess: (data) => {
          const firstName = data.user.name.split(/\s+/)[0] || data.user.name;
          toast.add({
            type: "success",
            title: `Welcome to ${PRODUCT_NAME}, ${firstName}!`,
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
        <CardTitle className="text-xl">Join {PRODUCT_NAME}</CardTitle>
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

          <NewPasswordFields
            idPrefix="invite"
            password={password}
            confirm={confirm}
            onPasswordChange={setPassword}
            onConfirmChange={setConfirm}
            submitted={submitted}
          />

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
