import { useEffect } from "react";
import { Building2, CalendarDays, ShieldCheck, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router";

import { LoginForm } from "@/components/auth/login-form";
import { BrandHeader } from "@/components/layout/brand";
import { PRODUCT_COMPANY, PRODUCT_NAME } from "@/lib/brand";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/hooks/use-auth";

/**
 * Home route: a branded split-screen sign-in page.
 *
 * While the `me` query resolves, a skeleton is shown instead of the form so a
 * signed-in user never sees a flash of the login UI — they get redirected to
 * the dashboard as soon as their session is confirmed.
 */
export function LoginPage() {
  const { isPending, data: user } = useCurrentUser();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && user) navigate("/dashboard", { replace: true });
  }, [isPending, user, navigate]);

  return (
    <div className="grid min-h-dvh lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <BrandPanel />
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <BrandHeader className="mb-8 lg:hidden" />
          {isPending ? <LoginCardSkeleton /> : <LoginCard />}
        </div>
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Brand panel                                                         */
/* ------------------------------------------------------------------ */

/** Branded left panel (lg+). Shared by the sign-in and invite pages. */
export function BrandPanel() {
  return (
    <aside className="relative hidden flex-col justify-between overflow-hidden bg-primary p-10 text-primary-foreground lg:flex xl:p-14">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-40 -right-24 size-[28rem] rounded-full bg-primary-foreground/10 blur-3xl" />
        <div className="absolute -bottom-48 -left-24 size-[26rem] rounded-full bg-primary-foreground/5 blur-3xl" />
        <div className="absolute top-1/3 left-1/4 size-64 rounded-full bg-primary-foreground/[0.04] blur-2xl" />
      </div>

      <BrandHeader className="relative" />

      <div className="relative">
        <h2 className="max-w-md font-heading text-3xl font-semibold tracking-tight xl:text-4xl">
          Everything your workforce needs, in one place.
        </h2>
        <ul className="mt-8 space-y-5">
          <Feature
            icon={ShieldCheck}
            title="Role-based access control"
            description="Admins and employees get exactly the permissions they need."
          />
          <Feature
            icon={CalendarDays}
            title="Leave & attendance"
            description="Request time off and track its status in real time."
          />
          <Feature
            icon={Building2}
            title="Departments & records"
            description="Manage employees, departments, and announcements."
          />
        </ul>
      </div>

      <p className="relative text-sm opacity-70">
        © {new Date().getFullYear()} {PRODUCT_COMPANY} · {PRODUCT_NAME}
      </p>
    </aside>
  );
}

function Feature({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-foreground/10 text-primary-foreground">
        <Icon className="size-4" />
      </span>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-sm opacity-70">{description}</p>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* Login card                                                          */
/* ------------------------------------------------------------------ */

function LoginCard() {
  return (
    <Card className="w-full animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
      <CardHeader>
        <CardTitle className="text-xl">Welcome back</CardTitle>
        <CardDescription>
          Sign in to your account to continue to the dashboard.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm />
      </CardContent>
    </Card>
  );
}

function LoginCardSkeleton() {
  return (
    <Card aria-busy="true" aria-label="Checking session" className="w-full">
      <CardHeader>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-8 w-full" />
        </div>
        <div className="space-y-1.5">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-8 w-full" />
        </div>
        <Skeleton className="h-8 w-full" />
      </CardContent>
    </Card>
  );
}
