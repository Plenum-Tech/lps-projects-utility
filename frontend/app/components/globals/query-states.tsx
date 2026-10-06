import type { ReactNode } from "react";
import type { IconType } from "react-icons";
import { LuCircleAlert, LuLoaderCircle, LuRefreshCw, LuShieldCheck } from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { getErrorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Destructive alert with the server message and a Retry button. */
export function QueryError({
  title,
  error,
  onRetry,
  retrying,
  className,
}: {
  title: string;
  error: unknown;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <Alert variant="destructive" className={className}>
      <LuCircleAlert aria-hidden className="size-4" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-2">
        {getErrorMessage(error)}
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            {retrying ? (
              <LuLoaderCircle aria-hidden className="animate-spin" />
            ) : (
              <LuRefreshCw aria-hidden />
            )}
            Retry
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Dashed empty state with icon, title, description and optional actions. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
  className,
}: {
  icon: IconType;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Empty className={cn("border border-dashed py-12", className)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {children && <EmptyContent>{children}</EmptyContent>}
    </Empty>
  );
}

/** Full-page "you can't see this" state for role-gated routes. */
export function AccessDenied({ title, description }: { title: string; description: string }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-16 sm:px-6">
      <EmptyState icon={LuShieldCheck} title={title} description={description} className="border-0" />
    </div>
  );
}

/** Standard page heading block used by the work pages. */
export function PageHeader({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** Small KPI card: label, big value, optional hint and icon. */
export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: IconType;
  tone?: "default" | "primary" | "warning" | "destructive";
  className?: string;
}) {
  const toneClass = {
    default: "bg-muted text-muted-foreground",
    primary: "bg-primary/10 text-primary",
    warning: "bg-chart-4/15 text-foreground",
    destructive: "bg-destructive/10 text-destructive",
  }[tone];
  return (
    <div className={cn("rounded-xl border bg-card p-4 text-card-foreground", className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        {Icon && (
          <span className={cn("flex size-7 items-center justify-center rounded-lg", toneClass)}>
            <Icon aria-hidden className="size-4" />
          </span>
        )}
      </div>
      <p className="mt-2 font-heading text-2xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
