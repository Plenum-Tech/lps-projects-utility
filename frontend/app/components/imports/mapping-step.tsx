import { useMemo } from "react";
import { LuCircleAlert, LuCircleCheck, LuCircleDashed, LuHistory } from "react-icons/lu";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { duplicateTargets, missingRequired } from "@/lib/imports";
import { cn } from "@/lib/utils";
import type { ImportField, ImportMapping, ImportPreviewResponse } from "@/types";

const IGNORE = "";

function requirementNote(field: ImportField): string | null {
  if (field.required === true) return "required";
  if (field.required === "create") return "needed for new records";
  return null;
}

/**
 * Step 2 — one row per detected column with a target-field dropdown.
 * Required fields are listed on top with a tick once mapped.
 */
export function MappingStep({
  preview,
  mapping,
  onChange,
  rememberedCount,
}: {
  preview: ImportPreviewResponse;
  mapping: ImportMapping;
  onChange: (mapping: ImportMapping) => void;
  rememberedCount: number;
}) {
  const fields = preview.fields;
  const fieldByKey = useMemo(() => new Map(fields.map((field) => [field.key, field])), [fields]);
  const dupes = duplicateTargets(mapping);
  const missing = missingRequired(fields, mapping);
  const mappedCount = Object.values(mapping).filter(Boolean).length;
  const required = fields.filter((field) => field.required !== false);

  function setColumn(index: number, field: string) {
    const next: ImportMapping = { ...mapping };
    if (field === IGNORE) delete next[String(index)];
    else next[String(index)] = field;
    onChange(next);
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground tabular-nums">{mappedCount}</span> of{" "}
          <span className="tabular-nums">{preview.columns.length}</span> columns will be imported. Columns set to
          “Don&apos;t import” are ignored.
        </p>
        {rememberedCount > 0 && (
          <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <LuHistory aria-hidden className="size-3.5" />
            Using your choices from the last import for {rememberedCount} column{rememberedCount === 1 ? "" : "s"}.
          </p>
        )}
        <ul className="flex flex-wrap gap-1.5" aria-label="Required fields">
          {required.map((field) => {
            const done = Object.values(mapping).includes(field.key);
            const hard = field.required === true;
            return (
              <li
                key={field.key}
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs font-medium",
                  done
                    ? "border-primary/25 bg-primary/10 text-primary"
                    : hard
                      ? "border-destructive/25 bg-destructive/10 text-destructive"
                      : "border-border text-muted-foreground"
                )}
              >
                {done ? (
                  <LuCircleCheck aria-hidden className="size-3.5" />
                ) : hard ? (
                  <LuCircleAlert aria-hidden className="size-3.5" />
                ) : (
                  <LuCircleDashed aria-hidden className="size-3.5" />
                )}
                {field.label}
                <span className="sr-only">{done ? "(mapped)" : `(${requirementNote(field)}, not mapped)`}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="overflow-hidden rounded-xl border">
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-4 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground sm:grid"
        >
          <span>Column in your file</span>
          <span>Imports as</span>
        </div>
        <ul className="divide-y">
          {preview.columns.map((column) => {
            const value = mapping[String(column.index)] ?? IGNORE;
            const field = value ? fieldByKey.get(value) : undefined;
            const duplicate = Boolean(value) && dupes.has(value);
            const selectId = `import-map-${column.index}`;
            return (
              <li
                key={column.index}
                className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-4"
              >
                <div className="min-w-0">
                  <label htmlFor={selectId} className="block truncate text-sm font-medium text-foreground">
                    {column.header}
                  </label>
                  <p className="truncate text-xs text-muted-foreground">
                    {column.samples.filter(Boolean).length > 0
                      ? column.samples.filter(Boolean).join(" · ")
                      : "Empty in the first rows"}
                  </p>
                </div>
                <div className="min-w-0 space-y-1">
                  <NativeSelect
                    id={selectId}
                    className="w-full"
                    value={value}
                    onChange={(event) => setColumn(column.index, event.target.value)}
                    aria-invalid={duplicate || undefined}
                    aria-describedby={field || duplicate ? `${selectId}-hint` : undefined}
                  >
                    <NativeSelectOption value={IGNORE}>Don&apos;t import</NativeSelectOption>
                    {fields.map((option) => (
                      <NativeSelectOption key={option.key} value={option.key}>
                        {option.label}
                        {option.required === true ? " *" : ""}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  {duplicate ? (
                    <p id={`${selectId}-hint`} className="text-xs text-destructive">
                      Another column already imports as {field?.label ?? value}.
                    </p>
                  ) : field ? (
                    <p id={`${selectId}-hint`} className="text-xs text-muted-foreground">
                      {field.accepts}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {missing.length > 0 && (
        <p role="status" className="text-xs text-destructive">
          Map a column to {missing.map((field) => field.label).join(" and ")} to continue.
        </p>
      )}
    </div>
  );
}
