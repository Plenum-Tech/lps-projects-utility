import { useId, type ReactNode } from "react";
import { LuFilterX } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";

const ANY = "__any";

/**
 * Side sheet holding the advanced filters. Changes apply immediately (and
 * land in the URL); "Clear" resets only the filters inside the sheet.
 */
export function FiltersSheet({
  open,
  onOpenChange,
  activeCount,
  onClear,
  children,
  description = "Narrow the list further. Changes apply as you go.",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCount: number;
  onClear: () => void;
  children: ReactNode;
  description?: string;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-sm">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Filters</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-4 overflow-y-auto p-4">{children}</div>
        <SheetFooter className="flex-row justify-between border-t">
          <Button variant="ghost" onClick={onClear} disabled={activeCount === 0}>
            <LuFilterX aria-hidden />
            Clear{activeCount ? ` (${activeCount})` : ""}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** Full-width labelled select for the filters sheet; `""` means any. */
export function SheetSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  anyLabel?: string;
  placeholder?: string;
}) {
  const id = useId();
  const items: Record<string, string> = { [ANY]: anyLabel ?? `Any ${label.toLowerCase()}` };
  for (const option of options) items[option.value] = option.label;
  // Keep an unknown (e.g. loading) value selectable instead of resetting it.
  if (value && !items[value]) items[value] = placeholder ?? "Loading…";

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value || ANY}
        onValueChange={(next) => onChange(!next || next === ANY ? "" : String(next))}
        items={items}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(items).map(([itemValue, itemLabel]) => (
            <SelectItem key={itemValue} value={itemValue}>
              {itemLabel}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** On/off filter row for the sheet (e.g. "Overdue only"). */
export function SheetSwitch({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}
