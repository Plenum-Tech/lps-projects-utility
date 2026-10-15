import { useState, type FormEvent } from "react";
import axios from "axios";
import { AlertCircle, Eye, EyeOff, LoaderCircle, LogIn } from "lucide-react";
import { Link, useNavigate } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin } from "@/hooks/use-auth";
import { getErrorMessage } from "@/lib/api";

/**
 * Wrong credentials (401) or too many attempts (429): the way in is Forgot
 * password, which also sets a first password for accounts that have none yet
 * (sign-in answers those exactly like a wrong password).
 */
function suggestsPasswordReset(error: unknown): boolean {
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return status === 401 || status === 429;
}

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
        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            // Pre-fill the reset form with the typed email (router state, never the URL).
            state={email.trim() ? { email: email.trim() } : undefined}
            className="rounded-sm text-xs font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            Forgot password?
          </Link>
        </div>
      </div>

      {login.isError && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Sign-in failed</AlertTitle>
          <AlertDescription className="[&_p:not(:last-child)]:mb-1">
            <p>{getErrorMessage(login.error)}</p>
            {suggestsPasswordReset(login.error) && (
              <p>
                <Link
                  to="/forgot-password"
                  state={email.trim() ? { email: email.trim() } : undefined}
                  className="font-medium"
                >
                  Set or reset your password
                </Link>
              </p>
            )}
          </AlertDescription>
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
