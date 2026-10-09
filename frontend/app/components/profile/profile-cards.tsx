import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Building2,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  UserRound,
} from "lucide-react";

import { useReportDirty } from "@/components/settings/unsaved-changes";
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
import { useCurrentUser } from "@/hooks/use-auth";
import { useMyDepartment } from "@/hooks/use-departments";
import { useUpdateProfile } from "@/hooks/use-users";
import { getErrorMessage } from "@/lib/api";

/** Profile → name (editable) and sign-in email (admin-managed). */
export function PersonalInfoCard() {
  const { data: user } = useCurrentUser();
  const update = useUpdateProfile();

  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (user) setName(user.name);
  }, [user]);

  const nameInvalid = submitted && name.trim() === "";
  useReportDirty(Boolean(user) && name.trim() !== user?.name);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!name.trim() || name.trim() === user?.name) return;
    update.mutate({ name: name.trim() });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserRound className="size-4 text-muted-foreground" />
          Personal information
        </CardTitle>
        <CardDescription>Your display name and sign-in email.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="profile-name">Name</Label>
            <Input
              id="profile-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={update.isPending}
              aria-invalid={nameInvalid}
              aria-describedby={nameInvalid ? "profile-name-error" : undefined}
            />
            {nameInvalid && (
              <p id="profile-name-error" className="text-xs text-destructive">
                Name is required.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="profile-email">Email</Label>
            <Input
              id="profile-email"
              value={user?.email ?? ""}
              readOnly
              disabled
              aria-describedby="profile-email-note"
            />
            <p
              id="profile-email-note"
              className="text-xs text-muted-foreground"
            >
              Your email is managed by your administrator.
            </p>
          </div>

          {update.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t update your profile</AlertTitle>
              <AlertDescription>
                {getErrorMessage(update.error)}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <UserRound />
              )}
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            {update.isSuccess && (
              <p className="text-sm text-muted-foreground" role="status">
                Saved.
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Security → change password (current + new + confirm). */
export function ChangePasswordCard() {
  const update = useUpdateProfile();
  const { data: me } = useCurrentUser();
  const mustChange = Boolean(me?.mustChangePassword);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const currentInvalid = submitted && currentPassword === "";
  const newPasswordInvalid = submitted && newPassword.length < 8;
  const confirmInvalid = submitted && confirmPassword !== newPassword;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (
      !currentPassword ||
      newPassword.length < 8 ||
      confirmPassword !== newPassword
    ) {
      return;
    }
    update.mutate(
      { currentPassword, password: newPassword },
      {
        onSuccess: () => {
          setCurrentPassword("");
          setNewPassword("");
          setConfirmPassword("");
          setSubmitted(false);
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          Change password
        </CardTitle>
        <CardDescription>
          Keep your account secure with a strong password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {mustChange && (
          <Alert className="mb-4">
            <KeyRound className="size-4" />
            <AlertTitle>Choose your own password</AlertTitle>
            <AlertDescription>
              Your administrator gave you a temporary password. Enter it as the
              current password and pick a new one to continue using the app.
            </AlertDescription>
          </Alert>
        )}
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="current-password">Current password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={update.isPending}
              autoComplete="current-password"
              aria-invalid={currentInvalid}
              aria-describedby={
                currentInvalid ? "current-password-error" : undefined
              }
            />
            {currentInvalid && (
              <p
                id="current-password-error"
                className="text-xs text-destructive"
              >
                Enter your current password.
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-password">New password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={update.isPending}
                autoComplete="new-password"
                aria-invalid={newPasswordInvalid}
                aria-describedby={
                  newPasswordInvalid ? "new-password-error" : undefined
                }
              />
              {newPasswordInvalid && (
                <p id="new-password-error" className="text-xs text-destructive">
                  Password must be at least 8 characters.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                disabled={update.isPending}
                autoComplete="new-password"
                aria-invalid={confirmInvalid}
                aria-describedby={
                  confirmInvalid ? "confirm-password-error" : undefined
                }
              />
              {confirmInvalid && (
                <p
                  id="confirm-password-error"
                  className="text-xs text-destructive"
                >
                  Passwords don&apos;t match.
                </p>
              )}
            </div>
          </div>

          {update.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Couldn&apos;t change your password</AlertTitle>
              <AlertDescription>
                {getErrorMessage(update.error)}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <KeyRound />
              )}
              {update.isPending ? "Updating…" : "Update password"}
            </Button>
            {update.isSuccess && (
              <p className="text-sm text-muted-foreground" role="status">
                Password updated.
              </p>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Profile → the department the user belongs to. */
export function DepartmentCard() {
  const {
    data: department,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useMyDepartment();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2 className="size-4 text-muted-foreground" />
          My department
        </CardTitle>
        <CardDescription>
          Information about the department you belong to.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div
            className="space-y-2"
            aria-busy="true"
            aria-label="Loading department"
          >
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load your department</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : department ? (
          <div>
            <p className="font-heading text-lg font-semibold text-foreground">
              {department.name}
            </p>
            {department.description && (
              <p className="mt-1 text-sm text-muted-foreground">
                {department.description}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 py-4 text-sm text-muted-foreground">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Building2 className="size-4" />
            </span>
            You&apos;re not assigned to a department yet. Contact your
            administrator.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
