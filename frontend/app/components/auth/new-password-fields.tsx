import { useState } from "react";
import { LuCheck, LuEye, LuEyeOff } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export const MIN_PASSWORD_LENGTH = 8;

const STRENGTH_RULES: { label: string; test: (value: string) => boolean; required?: boolean }[] = [
  { label: `At least ${MIN_PASSWORD_LENGTH} characters`, test: (v) => v.length >= MIN_PASSWORD_LENGTH, required: true },
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

/** Client-side check shared by the forms: long enough and both fields match. */
export function newPasswordValid(password: string, confirm: string) {
  return password.length >= MIN_PASSWORD_LENGTH && confirm === password;
}

/**
 * New password + confirm fields with a strength meter, rule hints and one
 * show/hide toggle for both. Errors appear once `submitted` is true.
 */
export function NewPasswordFields({
  idPrefix,
  password,
  confirm,
  onPasswordChange,
  onConfirmChange,
  submitted,
  autoFocus,
  label = "Password",
}: {
  idPrefix: string;
  password: string;
  confirm: string;
  onPasswordChange: (value: string) => void;
  onConfirmChange: (value: string) => void;
  submitted: boolean;
  autoFocus?: boolean;
  label?: string;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const passed = STRENGTH_RULES.filter((rule) => rule.test(password)).length;
  const level = password.length < MIN_PASSWORD_LENGTH ? 0 : passed;
  const passwordInvalid = submitted && password.length < MIN_PASSWORD_LENGTH;
  const confirmInvalid = submitted && confirm !== password;
  const passwordId = `${idPrefix}-password`;
  const confirmId = `${idPrefix}-confirm`;
  const hintsId = `${idPrefix}-password-hints`;

  return (
    <>
      <div className="space-y-1.5">
        <Label htmlFor={passwordId}>{label}</Label>
        <div className="relative">
          <Input
            id={passwordId}
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => onPasswordChange(event.target.value)}
            autoComplete="new-password"
            placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            autoFocus={autoFocus}
            maxLength={128}
            aria-invalid={passwordInvalid}
            aria-describedby={hintsId}
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
        <div id={hintsId} className="space-y-2 pt-1">
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
        <Label htmlFor={confirmId}>Confirm password</Label>
        <Input
          id={confirmId}
          type={showPassword ? "text" : "password"}
          value={confirm}
          onChange={(event) => onConfirmChange(event.target.value)}
          autoComplete="new-password"
          maxLength={128}
          aria-invalid={confirmInvalid}
          aria-describedby={confirmInvalid ? `${confirmId}-error` : undefined}
        />
        {confirmInvalid && (
          <p id={`${confirmId}-error`} className="text-xs text-destructive">
            Passwords don&apos;t match.
          </p>
        )}
      </div>
    </>
  );
}
