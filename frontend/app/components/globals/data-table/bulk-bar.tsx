import type { ReactNode } from "react";
import { LuChevronDown, LuLoaderCircle, LuX } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Appears while rows are selected: "N selected", the bulk actions and Clear.
 * Announced politely so screen-reader users hear the selection change.
 */
export function BulkBar({
  count,
  onClear,
  children,
  pending,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
  pending?: boolean;
}) {
  if (count === 0) return null;
  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="flex flex-wrap items-center gap-2 rounded-xl border border-ring/40 bg-primary/5 px-3 py-2 duration-150 animate-in fade-in-0 slide-in-from-top-1"
    >
      <p aria-live="polite" className="mr-1 flex items-center gap-2 text-sm font-medium text-foreground">
        {pending && <LuLoaderCircle aria-hidden className="size-4 animate-spin text-primary" />}
        <span className="tabular-nums">{count}</span> selected
      </p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      <Button variant="ghost" size="sm" onClick={onClear} className="ml-auto">
        <LuX aria-hidden />
        Clear
      </Button>
    </div>
  );
}

/** Bulk "Change status" style dropdown. */
export function BulkMenu({
  label,
  icon,
  heading,
  options,
  onSelect,
  disabled,
}: {
  label: string;
  icon?: ReactNode;
  heading?: string;
  options: { value: string; label: string; dot?: string }[];
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={disabled} />}>
        {icon}
        {label}
        <LuChevronDown aria-hidden className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto min-w-44">
        <DropdownMenuGroup>
          {heading && <DropdownMenuLabel>{heading}</DropdownMenuLabel>}
          {options.map((option) => (
            <DropdownMenuItem key={option.value} onClick={() => onSelect(option.value)}>
              {option.dot && (
                <span aria-hidden className={cn("size-2 shrink-0 rounded-full", option.dot)} />
              )}
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
