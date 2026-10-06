import { useEffect, useState, type FormEvent } from "react";
import { LuLoaderCircle } from "react-icons/lu";

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
import { Textarea } from "@/components/ui/textarea";

/**
 * Asks for a required reason (reject a time log / timesheet). Calls
 * `onConfirm(reason)`; the caller closes the dialog when its mutation settles.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Reject",
  pending,
  onConfirm,
  maxLength = 1000,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: (reason: string) => void;
  maxLength?: number;
}) {
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setReason("");
      setSubmitted(false);
    }
  }, [open]);

  const invalid = submitted && reason.trim() === "";

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!reason.trim()) return;
    onConfirm(reason.trim());
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="reason-dialog-reason">Reason</Label>
            <Textarea
              id="reason-dialog-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
              maxLength={maxLength}
              placeholder="Explain what needs to change…"
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? "reason-dialog-error" : undefined}
              autoFocus
            />
            {invalid && (
              <p id="reason-dialog-error" className="text-xs text-destructive">
                A reason is required.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending && <LuLoaderCircle aria-hidden className="animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
