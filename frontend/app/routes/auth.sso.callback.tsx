import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, LoaderCircle } from "lucide-react";

import { BrandPanel } from "@/components/auth/login-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { BrandHeader } from "@/components/layout/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { meKeys } from "@/hooks/use-auth";
import { completeEntraSso, safeReturnPath } from "@/lib/sso";

const LOGIN_NEXT_KEY = "utility.login-next";

/**
 * Entra redirect lands here with ?code=&state=. We POST to the API, which sets
 * the same httpOnly session cookie as password login, then continue.
 */
export default function SsoCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");

  useEffect(() => {
    const entraError = searchParams.get("error_description") || searchParams.get("error");
    if (entraError) {
      setError(entraError.replace(/\+/g, " "));
      return;
    }
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    if (!code || !state) {
      setError("Missing sign-in response from Microsoft.");
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const data = await completeEntraSso(code, state);
        if (cancelled) return;
        queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== meKeys.all[0] });
        queryClient.setQueryData(meKeys.all, data.user);
        let stored = "";
        try {
          stored = sessionStorage.getItem(LOGIN_NEXT_KEY) || "";
          sessionStorage.removeItem(LOGIN_NEXT_KEY);
        } catch {
          /* ignore */
        }
        navigate(safeReturnPath(data.next || stored || "/dashboard"), { replace: true });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Microsoft sign-in failed");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [navigate, queryClient, searchParams]);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <BrandHeader className="mb-8 lg:hidden" />
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="text-xl">{error ? "Sign-in failed" : "Signing you in"}</CardTitle>
              <CardDescription>
                {error ? "Microsoft sign-in could not be completed." : "Completing Microsoft sign-in…"}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {error ? (
                <>
                  <Alert variant="destructive">
                    <AlertCircle className="size-4" />
                    <AlertTitle>Could not sign in</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                  <Link
                    to="/"
                    className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Back to sign in
                  </Link>
                </>
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  Please wait
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </section>
    </div>
  );
}
