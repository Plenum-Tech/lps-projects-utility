import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import {
  LuArrowLeft,
  LuCircleAlert,
  LuCircleCheck,
  LuInfo,
  LuKeyRound,
  LuLoaderCircle,
  LuMail,
  LuMailCheck,
  LuRefreshCw,
  LuSend,
} from "react-icons/lu";
import { Link, useLocation, useNavigate } from "react-router";

import { AuthCardSkeleton, AuthSplitLayout, SignedInAsSomeoneElse } from "@/components/auth/auth-shell";
import { NewPasswordFields, newPasswordValid } from "@/components/auth/new-password-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import { useCurrentUser } from "@/hooks/use-auth";
import {
  passwordResetFailure,
  useCompletePasswordReset,
  useRequestPasswordReset,
  useVerifyPasswordReset,
} from "@/hooks/use-password-reset";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

const CODE_LENGTH = 6;
const CODE_TTL_SECONDS = 10 * 60;
const DEFAULT_RESEND_SECONDS = 60;

type Step = "email" | "code" | "password";

/** "bala.r@plenum-tech.com" → "b•••@plenum-tech.com". */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  return `${email[0]}•••${email.slice(at)}`;
}

/** "m:ss" for a countdown. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Current time, re-rendered every second while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

interface CodeSent {
  email: string;
  sentAt: number;
  resendAfterSeconds: number;
  message: string;
}

/**
 * Public /forgot-password page: email → 6-digit code → new password, in the
 * same split-screen style as sign-in. On success the user is signed in and
 * every other session is signed out.
 */
export function ForgotPasswordPage() {
  const me = useCurrentUser();
  const location = useLocation();
  const prefill = (location.state as { email?: unknown } | null)?.email;
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(typeof prefill === "string" ? prefill : "");
  const [sent, setSent] = useState<CodeSent | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the new password is submitted: the session that follows is ours, not "someone else".
  const [finishing, setFinishing] = useState(false);

  function restart(message: string | null) {
    setNotice(message);
    setResetToken(null);
    setSent(null);
    setStep("email");
  }

  let content: ReactNode;
  if (me.isPending) {
    content = <AuthCardSkeleton label="Loading" fields={1} />;
  } else if (me.data && !finishing) {
    content = <SignedInAsSomeoneElse name={me.data.name} email={me.data.email} purpose="reset a password" />;
  } else if (step === "code" && sent) {
    content = (
      <CodeStep
        sent={sent}
        onResent={(next) => setSent(next)}
        onVerified={(token) => {
          setResetToken(token);
          setStep("password");
        }}
        onChangeEmail={() => restart(null)}
      />
    );
  } else if (step === "password" && resetToken) {
    content = (
      <PasswordStep
        resetToken={resetToken}
        email={sent?.email ?? email}
        onSubmitting={() => setFinishing(true)}
        onExpired={() => {
          setFinishing(false);
          restart("Your reset session expired — request a new code.");
        }}
      />
    );
  } else {
    content = (
      <EmailStep
        email={email}
        onEmailChange={setEmail}
        notice={notice}
        onSent={(next) => {
          setNotice(null);
          setSent(next);
          setStep("code");
        }}
      />
    );
  }

  return <AuthSplitLayout>{content}</AuthSplitLayout>;
}

/* ------------------------------------------------------------------ */
/* Shared card chrome                                                  */
/* ------------------------------------------------------------------ */

const STEP_INDEX: Record<Step, number> = { email: 1, code: 2, password: 3 };

function StepCard({
  step,
  icon,
  title,
  description,
  children,
}: {
  step: Step;
  icon: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const index = STEP_INDEX[step];
  return (
    <Card className="w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
      <CardHeader>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Step {index} of 3</span>
            <div className="flex gap-1" aria-hidden>
              {[1, 2, 3].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "h-1 w-5 rounded-full transition-colors duration-200 ease-out",
                    n <= index ? "bg-primary" : "bg-muted"
                  )}
                />
              ))}
            </div>
          </div>
        </div>
        <CardTitle className="text-xl">
          <h1>{title}</h1>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function BackToSignIn() {
  return (
    <p className="text-center text-xs text-muted-foreground">
      Remembered it?{" "}
      <Link
        to="/"
        className="rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Back to sign in
      </Link>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1: email                                                       */
/* ------------------------------------------------------------------ */

function EmailStep({
  email,
  onEmailChange,
  notice,
  onSent,
}: {
  email: string;
  onEmailChange: (value: string) => void;
  notice: string | null;
  onSent: (sent: CodeSent) => void;
}) {
  const request = useRequestPasswordReset();
  const [submitted, setSubmitted] = useState(false);
  const trimmed = email.trim();
  const emailInvalid = submitted && !/^\S+@\S+\.\S+$/.test(trimmed);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) return;
    request.mutate(trimmed, {
      onSuccess: (data) =>
        onSent({
          email: trimmed,
          sentAt: Date.now(),
          resendAfterSeconds: data.resendAfterSeconds || DEFAULT_RESEND_SECONDS,
          message: data.message,
        }),
    });
  }

  return (
    <StepCard
      step="email"
      icon={<LuMail aria-hidden className="size-5" />}
      title="Forgot your password?"
      description="Enter the email you sign in with and we'll send you a 6-digit code to reset it — or to set your first password."
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {notice && (
          <Alert className="border-primary/30 bg-primary/5" role="status">
            <LuInfo aria-hidden className="size-4" />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="forgot-email">Email</Label>
          <Input
            id="forgot-email"
            type="email"
            inputMode="email"
            placeholder="you@company.com"
            autoComplete="email"
            autoFocus
            maxLength={254}
            value={email}
            onChange={(event) => onEmailChange(event.target.value)}
            aria-invalid={emailInvalid}
            aria-describedby={emailInvalid ? "forgot-email-error" : undefined}
          />
          {emailInvalid && (
            <p id="forgot-email-error" className="text-xs text-destructive">
              Enter a valid email address.
            </p>
          )}
        </div>

        {request.isError && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t send the code</AlertTitle>
            <AlertDescription>{getErrorMessage(request.error)}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={request.isPending}>
          {request.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSend aria-hidden />}
          {request.isPending ? "Sending code…" : "Send code"}
        </Button>
        <BackToSignIn />
      </form>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2: code                                                        */
/* ------------------------------------------------------------------ */

function CodeStep({
  sent,
  onResent,
  onVerified,
  onChangeEmail,
}: {
  sent: CodeSent;
  onResent: (sent: CodeSent) => void;
  onVerified: (resetToken: string) => void;
  onChangeEmail: () => void;
}) {
  const verify = useVerifyPasswordReset();
  const resend = useRequestPasswordReset();
  const [code, setCode] = useState("");
  const now = useNow(true);

  const resendIn = sent.resendAfterSeconds - (now - sent.sentAt) / 1000;
  const expiresIn = CODE_TTL_SECONDS - (now - sent.sentAt) / 1000;
  const expired = expiresIn <= 0;
  const failure = verify.isError ? passwordResetFailure(verify.error) : null;
  const locked = failure?.status === 429 && failure.reason === "locked";
  const codeGone = failure?.status === 400 && failure.reason === "expired";

  let errorText: string | null = null;
  if (verify.isError && failure) {
    if (locked) errorText = "Too many attempts — request a new code.";
    else if (codeGone) errorText = "This code is no longer valid — request a new code.";
    else if (failure.status === 400 && typeof failure.attemptsLeft === "number" && failure.attemptsLeft > 0)
      errorText = `Incorrect code — ${failure.attemptsLeft} ${failure.attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
    else errorText = getErrorMessage(verify.error);
  }
  const blocked = locked || codeGone || expired;

  function submit(value: string) {
    if (value.length !== CODE_LENGTH || blocked || verify.isPending) return;
    verify.mutate(
      { email: sent.email, code: value },
      {
        onSuccess: (data) => onVerified(data.resetToken),
        onError: () => setCode(""),
      }
    );
  }

  function handleResend() {
    resend.mutate(sent.email, {
      onSuccess: (data) => {
        verify.reset();
        setCode("");
        onResent({
          email: sent.email,
          sentAt: Date.now(),
          resendAfterSeconds: data.resendAfterSeconds || DEFAULT_RESEND_SECONDS,
          message: data.message,
        });
        toast.add({ type: "info", title: "New code requested", description: data.message });
      },
    });
  }

  return (
    <StepCard
      step="code"
      icon={<LuMailCheck aria-hidden className="size-5" />}
      title="Check your email"
      description={
        <>
          Code sent to <span className="font-medium text-foreground">{maskEmail(sent.email)}</span>. {sent.message}
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(code);
        }}
        noValidate
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor="forgot-code">6-digit code</Label>
          <InputOTP
            id="forgot-code"
            maxLength={CODE_LENGTH}
            pattern={REGEXP_ONLY_DIGITS}
            // Pasted codes like "123 456" or "Code: 123-456" keep only their digits.
            pasteTransformer={(text) => text.replace(/\D/g, "").slice(0, CODE_LENGTH)}
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            value={code}
            disabled={blocked}
            onChange={(value) => {
              setCode(value);
              if (verify.isError && !blocked) verify.reset();
            }}
            onComplete={submit}
            aria-invalid={Boolean(errorText)}
            aria-describedby="forgot-code-status"
            containerClassName="justify-center"
          >
            <InputOTPGroup className="gap-2">
              {Array.from({ length: CODE_LENGTH }).map((_, index) => (
                <InputOTPSlot
                  key={index}
                  index={index}
                  aria-invalid={Boolean(errorText)}
                  className="size-11 rounded-lg border text-lg font-semibold tabular-nums first:rounded-lg first:border-l last:rounded-r-lg sm:size-12"
                />
              ))}
            </InputOTPGroup>
          </InputOTP>
          <div id="forgot-code-status" className="space-y-1 text-center text-xs" aria-live="polite">
            {errorText ? (
              <p className="text-destructive" role="alert">
                {errorText}
              </p>
            ) : null}
            <p className={cn(expired ? "text-destructive" : "text-muted-foreground")}>
              {expired ? "This code has expired — request a new one." : `Code expires in ${clock(expiresIn)}`}
            </p>
          </div>
        </div>

        {resend.isError && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t send a new code</AlertTitle>
            <AlertDescription>{getErrorMessage(resend.error)}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={code.length !== CODE_LENGTH || blocked || verify.isPending}>
          {verify.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuCircleCheck aria-hidden />}
          {verify.isPending ? "Checking…" : "Verify code"}
        </Button>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onChangeEmail}>
            <LuArrowLeft aria-hidden />
            Change email
          </Button>
          <Button
            type="button"
            variant={blocked ? "default" : "outline"}
            size="sm"
            onClick={handleResend}
            disabled={resendIn > 0 || resend.isPending}
          >
            {resend.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuRefreshCw aria-hidden />}
            {resendIn > 0 ? (
              <span>
                Resend code in <span className="tabular-nums">{clock(resendIn)}</span>
              </span>
            ) : (
              "Resend code"
            )}
          </Button>
        </div>
      </form>
    </StepCard>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3: new password                                                */
/* ------------------------------------------------------------------ */

function PasswordStep({
  resetToken,
  email,
  onSubmitting,
  onExpired,
}: {
  resetToken: string;
  email: string;
  onSubmitting: () => void;
  onExpired: () => void;
}) {
  const complete = useCompletePasswordReset();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const valid = newPasswordValid(password, confirm);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!valid) return;
    onSubmitting();
    complete.mutate(
      { resetToken, password, confirmPassword: confirm },
      {
        onSuccess: () => {
          toast.add({ type: "success", title: "Password updated — other sessions were signed out" });
          navigate("/dashboard", { replace: true });
        },
        onError: (error) => {
          if (passwordResetFailure(error).status === 410) onExpired();
        },
      }
    );
  }

  return (
    <StepCard
      step="password"
      icon={<LuKeyRound aria-hidden className="size-5" />}
      title="Choose a new password"
      description="Code verified. Pick a new password — you'll be signed in and every other session will be signed out."
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {/* Lets password managers file the new password under the right account. */}
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <NewPasswordFields
          idPrefix="forgot"
          label="New password"
          confirmLabel="Confirm new password"
          password={password}
          confirm={confirm}
          onPasswordChange={setPassword}
          onConfirmChange={setConfirm}
          submitted={submitted}
          liveMatch
          autoFocus
        />

        {complete.isError && passwordResetFailure(complete.error).status !== 410 && (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t update your password</AlertTitle>
            <AlertDescription>{getErrorMessage(complete.error)}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" className="w-full" disabled={!valid || complete.isPending || complete.isSuccess}>
          {complete.isPending || complete.isSuccess ? (
            <LuLoaderCircle aria-hidden className="animate-spin" />
          ) : (
            <LuCircleCheck aria-hidden />
          )}
          {complete.isPending || complete.isSuccess ? "Updating password…" : "Update password"}
        </Button>
      </form>
    </StepCard>
  );
}
