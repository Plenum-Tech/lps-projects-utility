import { useEffect, useMemo, useState, type FormEvent } from "react";
import { LuLoaderCircle, LuUserCheck } from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useAssignableUsers } from "@/hooks/use-task-meta";

/** Head/admin: replace the assignees of the selected tasks. */
export function BulkAssignDialog({
  open,
  onOpenChange,
  count,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  pending: boolean;
  onConfirm: (assignees: string[]) => void;
}) {
  const people = useAssignableUsers(open);
  const [value, setValue] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setValue([]);
      setSubmitted(false);
    }
  }, [open]);

  const options = useMemo<MultiSelectOption[]>(
    () =>
      (people.data ?? []).map((user) => ({
        value: user._id,
        label: user.name,
        description: [user.email, user.department?.name].filter(Boolean).join(" · "),
      })),
    [people.data]
  );
  const invalid = submitted && value.length === 0;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (value.length === 0) return;
    onConfirm(value);
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Assign {count} task{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Replaces the current assignees. Tasks you can&apos;t edit are skipped and listed
            afterwards.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bulk-assignees">Assign to</Label>
            <MultiSelect
              id="bulk-assignees"
              options={options}
              value={value}
              onValueChange={setValue}
              placeholder={people.isPending ? "Loading people…" : "Search people…"}
              emptyText={people.isError ? "Couldn't load people." : "No one found."}
              invalid={invalid}
              max={20}
              aria-describedby={invalid ? "bulk-assignees-error" : undefined}
            />
            {invalid && (
              <p id="bulk-assignees-error" className="text-xs text-destructive">
                Pick at least one person.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuUserCheck aria-hidden />}
              Assign
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
