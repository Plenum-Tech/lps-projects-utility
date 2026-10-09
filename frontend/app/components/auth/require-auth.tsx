import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Navigate, useLocation } from "react-router";

import { useCurrentUser } from "@/hooks/use-auth";

/**
 * Guards protected routes (used by the `protected` pathless layout).
 *
 * Auth is cookie-based, so the session can only be verified in the browser via
 * GET /auth/me — hence a client-side guard backed by the `me` query rather
 * than a server loader. While the session resolves we render a loading state
 * (never flash protected content, never bounce the user); once resolved,
 * signed-out users are redirected to the login page.
 *
 * A network failure is treated as "no verifiable session" → the login page,
 * where submitting the form surfaces the readable network error.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { isPending, data: user } = useCurrentUser();
  const location = useLocation();

  if (isPending) {
    return (
      <div
        role="status"
        aria-label="Checking session"
        className="flex min-h-dvh items-center justify-center"
      >
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/" replace />;
  }

  // An admin-set default password: choose your own before using the app.
  if (
    user.mustChangePassword &&
    !location.pathname.startsWith("/settings/security")
  ) {
    return <Navigate to="/settings/security" replace />;
  }

  return children;
}
