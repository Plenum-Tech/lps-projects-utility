import { useState, type FormEvent } from "react";
import { AlertCircle, Eye, EyeOff, LoaderCircle, LogIn } from "lucide-react";
import { LuKeyRound } from "react-icons/lu";
import { useNavigate } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/hooks/use-auth";
import { isPasswordSetupRequiredError } from "@/hooks/use-password-setup";
import { getErrorMessage } from "@/lib/api";

/**
 * Email + password login form backed by POST /api/auth/login.
 *
 * On success the backend sets the httpOnly JWT cookie and `useLogin` seeds the
 * `me` cache — the token never touches localStorage/JS — then we navigate to
 * the dashboard.
 */
export function LoginForm() {
  const login = useLogin();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const emailInvalid = submitted && email.trim() === "";
  const passwordInvalid = submitted && password === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!email.trim() || !password) return;
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: () => navigate("/dashboard"),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="login-email">Email</Label>
        <Input
          id="login-email"
          type="email"
          placeholder="you@company.com"
          autoComplete="email"
          autoFocus
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          aria-invalid={emailInvalid}
          aria-describedby={emailInvalid ? "login-email-error" : undefined}
        />
        {emailInvalid && (
          <p id="login-email-error" className="text-xs text-destructive">
            Email is required.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="login-password">Password</Label>
          <p className="text-xs text-muted-foreground">Provided by your administrator</p>
        </div>
        <div className="relative">
          <Input
            id="login-password"
            type={showPassword ? "text" : "password"}
            placeholder="••••••••"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-invalid={passwordInvalid}
            aria-describedby={passwordInvalid ? "login-password-error" : undefined}
            className="pr-9"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setShowPassword((visible) => !visible)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showPassword ? <EyeOff /> : <Eye />}
          </Button>
        </div>
        {passwordInvalid && (
          <p id="login-password-error" className="text-xs text-destructive">
            Password is required.
          </p>
        )}
      </div>

      {login.isError && isPasswordSetupRequiredError(login.error) ? (
        <Alert className="border-primary/30 bg-primary/5">
          <LuKeyRound aria-hidden className="size-4" />
          <AlertTitle>Set your password first</AlertTitle>
          <AlertDescription>
            Your account needs a password — use the set-password link from your administrator. If you
            can&apos;t find it or it has expired, ask them to send a new one.
          </AlertDescription>
        </Alert>
      ) : login.isError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription>{getErrorMessage(login.error)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending ? (
          <LoaderCircle className="animate-spin" />
        ) : (
          <LogIn />
        )}
        {login.isPending ? "Signing in…" : "Sign in"}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Accounts are created by administrators — there is no public registration.
      </p>
    </form>
  );
}
