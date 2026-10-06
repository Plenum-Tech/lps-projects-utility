import { LuX } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** Compact from/to date inputs ("YYYY-MM-DD"); empty = open-ended. */
export function DateRangeFields({
  idPrefix,
  from,
  to,
  onChange,
  clearable,
  className,
}: {
  idPrefix: string;
  from: string;
  to: string;
  onChange: (range: { from: string; to: string }) => void;
  clearable?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end gap-2", className)}>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-from`} className="text-xs text-muted-foreground">
          From
        </Label>
        <Input
          id={`${idPrefix}-from`}
          type="date"
          value={from}
          max={to || undefined}
          onChange={(event) => onChange({ from: event.target.value, to })}
          className="h-7 w-36 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${idPrefix}-to`} className="text-xs text-muted-foreground">
          To
        </Label>
        <Input
          id={`${idPrefix}-to`}
          type="date"
          value={to}
          min={from || undefined}
          onChange={(event) => onChange({ from, to: event.target.value })}
          className="h-7 w-36 text-sm"
        />
      </div>
      {clearable && (from || to) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ from: "", to: "" })}
          aria-label="Clear date range"
        >
          <LuX aria-hidden />
          Clear
        </Button>
      )}
    </div>
  );
}
