import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { LuGraduationCap, LuTriangleAlert } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCurrentUser } from "@/hooks/use-auth";
import { useRequiredTrainings } from "@/hooks/use-trainings";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const SNOOZE_KEY = "mandatory-training-snoozed";

function snoozed(): boolean {
  try {
    return window.sessionStorage.getItem(SNOOZE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Pop-up at sign-in for mandatory trainings the person hasn't completed.
 * "Later" hides it for this browser session while every deadline is still
 * ahead; once one is overdue the pop-up can't be dismissed. Never shown on
 * the training pages themselves.
 */
export function MandatoryTrainingPrompt() {
  const { data: me } = useCurrentUser();
  const location = useLocation();
  const navigate = useNavigate();
  const onTrainingPage = location.pathname.startsWith("/training");
  const enabled = Boolean(me) && !me?.mustChangePassword;
  const required = useRequiredTrainings(enabled);
  const [laterThisSession, setLaterThisSession] = useState(snoozed);

  const trainings = required.data ?? [];
  const overdue = trainings.some((t) => t.overdue);
  const open = enabled && !onTrainingPage && trainings.length > 0 && (overdue || !laterThisSession);
  if (!open) return null;

  function later() {
    try {
      window.sessionStorage.setItem(SNOOZE_KEY, "1");
    } catch {
      // storage unavailable: hide for this page view only
    }
    setLaterThisSession(true);
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !overdue && later()}>
      <DialogContent className="sm:max-w-md" showCloseButton={!overdue}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LuGraduationCap aria-hidden className="size-5 text-primary" />
            Mandatory training
          </DialogTitle>
          <DialogDescription>
            {overdue
              ? "The time to complete this training has passed. Please complete it now to continue."
              : "Please read the training below and confirm when you've finished."}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {trainings.map((t) => (
            <li key={t._id} className="rounded-lg border px-3 py-2">
              <p className="font-medium text-foreground">{t.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                <span>{t.slideCount} slides</span>
                <span>·</span>
                <span>
                  {t.viewedCount > 0 ? `${t.viewedCount} of ${t.slideCount} read` : "not started"}
                </span>
                <span>·</span>
                <span className={cn(t.overdue && "inline-flex items-center gap-1 font-medium text-destructive")}>
                  {t.overdue && <LuTriangleAlert aria-hidden className="size-3.5" />}
                  {t.overdue ? "overdue since" : "complete by"} {formatDate(t.deadline)}
                </span>
              </p>
            </li>
          ))}
        </ul>
        <DialogFooter>
          {!overdue && (
            <Button variant="outline" onClick={later}>
              Later
            </Button>
          )}
          <Button onClick={() => navigate(`/training/${trainings[0]!._id}`)}>
            {trainings[0]!.viewedCount > 0 ? "Continue training" : "Start now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
