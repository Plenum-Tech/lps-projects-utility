import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuLoaderCircle, LuLogOut } from "react-icons/lu";
import { Link } from "react-router";

import { BrandPanel } from "@/components/auth/login-page";
import { BrandHeader } from "@/components/layout/brand";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useLogout } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";

/** Split-screen layout shared by the public auth pages (invite, set password). */
export function AuthSplitLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <BrandHeader className="mb-8 lg:hidden" />
          {children}
        </div>
      </main>
    </div>
  );
}

/** Icon + title + description card for non-form states (invalid, expired, used…). */
export function AuthStateCard({
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

/** Someone else is signed in on this browser: offer sign out before using the link. */
export function SignedInAsSomeoneElse({ name, email, purpose }: { name: string; email: string; purpose: string }) {
  const logout = useLogout();
  return (
    <AuthStateCard
      icon={LuLogOut}
      title="You're already signed in"
      description={
        <>
          You&apos;re signed in as <span className="font-medium text-foreground">{name}</span> ({email}). Sign out to{" "}
          {purpose}.
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

/** Loading placeholder shaped like an auth form card. */
export function AuthCardSkeleton({ label, fields = 3 }: { label: string; fields?: number }) {
  return (
    <Card aria-busy="true" aria-label={label} className="w-full">
      <CardHeader>
        <Skeleton className="mb-2 size-10 rounded-xl" />
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.from({ length: fields }).map((_, index) => (
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
