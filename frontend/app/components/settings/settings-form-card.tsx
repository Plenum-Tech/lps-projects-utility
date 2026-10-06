import type { FormEvent, ReactNode } from "react";
import { LuLoaderCircle, LuSave, LuUndo2 } from "react-icons/lu";

import { useReportDirty } from "@/components/settings/unsaved-changes";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Settings content card: title, the form, and a footer Save button that stays
 * disabled until something changes. Reports its dirty state to the unsaved-
 * changes guard.
 */
export function SettingsFormCard({
  title,
  description,
  dirty,
  pending,
  onSubmit,
  onReset,
  children,
  saveLabel = "Save changes",
}: {
  title: string;
  description?: ReactNode;
  dirty: boolean;
  pending: boolean;
  onSubmit: () => void;
  onReset: () => void;
  children: ReactNode;
  saveLabel?: string;
}) {
  useReportDirty(dirty);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || pending) return;
    onSubmit();
  }

  return (
    <Card>
      <form onSubmit={handleSubmit} noValidate className="contents">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-5">{children}</CardContent>
        <CardFooter className="flex-wrap justify-end gap-2">
          {dirty && !pending && (
            <>
              <span className="mr-auto text-xs text-muted-foreground" role="status">
                Unsaved changes
              </span>
              <Button type="button" variant="ghost" onClick={onReset}>
                <LuUndo2 aria-hidden />
                Discard
              </Button>
            </>
          )}
          <Button type="submit" disabled={!dirty || pending}>
            {pending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
            {pending ? "Saving…" : saveLabel}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Loading placeholder shaped like a settings form. */
export function SettingsFormSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card aria-busy="true" aria-label="Loading settings">
      <CardContent className="space-y-5 p-6">
        <Skeleton className="h-5 w-40" />
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Inline field error / hint text. */
export function FieldMessage({ id, error, hint }: { id: string; error?: string | null; hint?: ReactNode }) {
  if (error) {
    return (
      <p id={id} className="text-xs text-destructive">
        {error}
      </p>
    );
  }
  if (!hint) return null;
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {hint}
    </p>
  );
}
