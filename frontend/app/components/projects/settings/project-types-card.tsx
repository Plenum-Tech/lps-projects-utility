import { useState, type FormEvent } from "react";
import {
  LuArrowDown,
  LuArrowUp,
  LuCircleAlert,
  LuLoaderCircle,
  LuPlus,
  LuRefreshCw,
  LuTag,
  LuTrash2,
} from "react-icons/lu";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjectTypes, useUpdateProjectSettings } from "@/hooks/use-project-meta";
import { getErrorMessage } from "@/lib/api";
import { NAMING_SEPARATOR, tidyNamePart } from "@/lib/projects";

const TYPE_MAX = 30;

/**
 * Admin list of project name Types (`Brand_Type_MonYYYY_Name`). Removing a type
 * only hides it from new names — existing projects keep theirs.
 */
export function ProjectTypesCard() {
  const types = useProjectTypes();
  const update = useUpdateProjectSettings();
  const [name, setName] = useState("");

  const list = types.data ?? [];
  const value = tidyNamePart(name);
  const duplicate = list.some((type) => type.name.toLowerCase() === value.toLowerCase());
  const error = value.includes(NAMING_SEPARATOR)
    ? "Types can't contain “_” (it separates the name parts)."
    : duplicate
      ? "That type already exists."
      : null;

  function save(next: string[], onSuccess?: () => void) {
    update.mutate({ projectTypes: next }, { onSuccess });
  }

  function handleAdd(event: FormEvent) {
    event.preventDefault();
    if (!value || error) return;
    save([...list.map((type) => type.name), value], () => setName(""));
  }

  function move(index: number, delta: number) {
    const names = list.map((type) => type.name);
    const [item] = names.splice(index, 1);
    names.splice(index + delta, 0, item);
    save(names);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LuTag aria-hidden className="size-4 text-muted-foreground" />
          Project types
        </CardTitle>
        <CardDescription>
          The Type part of project names, e.g. <code className="font-mono">Wasl_Campaign_Oct2026_JGE Launch</code>.
          Removing a type keeps it on existing projects.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleAdd} className="space-y-1.5">
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={TYPE_MAX}
              placeholder="New type, e.g. Retainer"
              aria-label="New project type"
              aria-invalid={Boolean(value && error) || undefined}
              disabled={update.isPending}
            />
            <Button type="submit" disabled={update.isPending || !value || Boolean(error)}>
              {update.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuPlus aria-hidden />}
              Add
            </Button>
          </div>
          {value && error && <p className="text-xs text-destructive">{error}</p>}
        </form>

        {types.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading project types">
            {Array.from({ length: 3 }).map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : types.isError ? (
          <Alert variant="destructive">
            <LuCircleAlert aria-hidden className="size-4" />
            <AlertTitle>Couldn&apos;t load project types</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(types.error)}
              <Button variant="outline" size="sm" onClick={() => void types.refetch()}>
                <LuRefreshCw aria-hidden />
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <ul className="divide-y rounded-lg border">
            {list.map((type, index) => (
              <li key={type.name} className="flex items-center gap-2 px-3 py-2">
                <span className="flex-1 truncate text-sm text-foreground">{type.name}</span>
                <Badge variant="outline" className="tabular-nums">
                  {type.projectCount} project{type.projectCount === 1 ? "" : "s"}
                </Badge>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(index, -1)}
                  disabled={index === 0 || update.isPending}
                  aria-label={`Move ${type.name} up`}
                >
                  <LuArrowUp aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(index, 1)}
                  disabled={index === list.length - 1 || update.isPending}
                  aria-label={`Move ${type.name} down`}
                >
                  <LuArrowDown aria-hidden />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => save(list.filter((t) => t.name !== type.name).map((t) => t.name))}
                  disabled={list.length <= 1 || update.isPending}
                  aria-label={`Remove ${type.name}`}
                  title={list.length <= 1 ? "Keep at least one type" : undefined}
                >
                  <LuTrash2 aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
