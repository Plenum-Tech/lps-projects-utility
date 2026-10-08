import type { ReactNode } from "react";

import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface OptionItem {
  value: string;
  label: string;
  /** Secondary text inside the dropdown. */
  description?: string;
  icon?: ReactNode;
}

/** Single-value select with labels resolved through Base UI `items`. */
export function OptionSelect({
  id,
  value,
  onChange,
  options,
  disabled,
  invalid,
  className,
  placeholder,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: OptionItem[];
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
  /** Shown while `value` is "" (nothing picked yet). */
  placeholder?: string;
  "aria-label"?: string;
}) {
  const items: Record<string, string> = {};
  if (placeholder) items[""] = placeholder;
  for (const option of options) items[option.value] = option.label;
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null && next !== undefined) onChange(String(next));
      }}
      items={items}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        className={cn("w-full", placeholder && value === "" && "text-muted-foreground", className)}
        aria-invalid={invalid || undefined}
        aria-label={ariaLabel}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.icon}
            {option.description ? (
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {option.description}
                </span>
              </span>
            ) : (
              option.label
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Labelled switch row with a short description. */
export function SwitchRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 px-3 py-2.5">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
          {label}
        </Label>
        <p id={`${id}-description`} className="mt-0.5 text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(Boolean(next))}
        disabled={disabled}
        aria-describedby={`${id}-description`}
        className="mt-0.5"
      />
    </div>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-xs text-destructive">
      {children}
    </p>
  );
}

/** Returns the HTTP status of an axios-style error (or undefined). */
export function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}
