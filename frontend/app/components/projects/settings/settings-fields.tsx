import type { ReactNode } from "react";
import { LuLoaderCircle, LuSave, LuUndo2 } from "react-icons/lu";

import { useReportDirty } from "@/components/settings/unsaved-changes";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** Bordered label + hint + switch row used by the settings cards. */
export function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div>
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Save / discard footer with dirty tracking. */
export function SaveBar({
  dirty,
  pending,
  invalid,
  onReset,
  label,
}: {
  dirty: boolean;
  pending: boolean;
  invalid?: boolean;
  onReset: () => void;
  label: string;
}) {
  // Feeds the Settings area's unsaved-changes guard (no-op elsewhere).
  useReportDirty(dirty);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" disabled={pending || invalid || !dirty}>
        {pending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuSave aria-hidden />}
        {label}
      </Button>
      {dirty && !pending && (
        <>
          <Button type="button" variant="ghost" onClick={onReset}>
            <LuUndo2 aria-hidden />
            Discard
          </Button>
          <span className="text-xs text-muted-foreground" role="status">
            Unsaved changes
          </span>
        </>
      )}
    </div>
  );
}
