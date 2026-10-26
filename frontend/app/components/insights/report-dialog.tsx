import { useEffect, useState } from "react";
import { LuLoaderCircle, LuSend } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/hooks/use-auth";
import { useInsightBoard, useInsightOptions, useSendReport, useUpdateBoard } from "@/hooks/use-insights";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api";
import { SCHEDULE_LABELS, type InsightSchedule } from "@/lib/insights/types";

// ---------------------------------------------------------------------------
// "Send me a report": a board's scheduled email + in-app report. Leadership
// recipients only (the server refuses anyone else); sharing with other staff
// isn't built yet. "Send now" runs it at once (also how it's tested locally,
// where scheduled jobs are off).
// ---------------------------------------------------------------------------

export function ReportDialog({ boardId, onClose }: { boardId: string | null; onClose: () => void }) {
  const toast = useToast();
  const { data: me } = useCurrentUser();
  const board = useInsightBoard(boardId);
  const options = useInsightOptions();
  const update = useUpdateBoard();
  const send = useSendReport();
  const [schedule, setSchedule] = useState<InsightSchedule>("off");
  const [recipients, setRecipients] = useState<string[]>([]);
  const [sendUnchanged, setSendUnchanged] = useState(false);

  useEffect(() => {
    if (!board.data) return;
    setSchedule(board.data.report.schedule);
    setRecipients(board.data.report.recipients.length ? board.data.report.recipients.map(String) : me ? [me._id] : []);
    setSendUnchanged(board.data.report.sendUnchanged);
  }, [board.data, me]);

  async function save() {
    if (!boardId) return;
    try {
      await update.mutateAsync({ id: boardId, report: { schedule, recipients, sendUnchanged } });
      toast.success(schedule === "off" ? "Report schedule turned off" : `Report scheduled: ${SCHEDULE_LABELS[schedule].toLowerCase()}`);
      onClose();
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  async function sendNow() {
    if (!boardId) return;
    try {
      await update.mutateAsync({ id: boardId, report: { schedule, recipients, sendUnchanged } });
      const { outcome } = await send.mutateAsync({ id: boardId, force: true });
      if (outcome.sent) toast.success(`Report sent to ${outcome.recipients} ${outcome.recipients === 1 ? "person" : "people"}`);
      else toast.info(`Not sent: ${outcome.reason}`);
    } catch (err) {
      toast.error(getErrorMessage(err));
    }
  }

  const report = board.data?.report;
  return (
    <Dialog open={Boolean(boardId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Board report</DialogTitle>
          <DialogDescription>
            On schedule the board's blocks are re-run on live data and sent as one email and notification. No AI is used, and nothing is sent when the numbers haven't changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <label className="grid gap-1.5">
            <span className="font-medium">Send</span>
            <NativeSelect value={schedule} onChange={(e) => setSchedule(e.target.value as InsightSchedule)} className="w-full">
              {(Object.keys(SCHEDULE_LABELS) as InsightSchedule[]).map((s) => (
                <NativeSelectOption key={s} value={s}>
                  {s === "off" ? "Never (off)" : SCHEDULE_LABELS[s]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <fieldset className="grid gap-1.5">
            <legend className="mb-1 font-medium">To (leadership only)</legend>
            {(options.data?.leaders ?? []).map((l) => (
              <label key={l.id} className="flex items-center gap-2">
                <Checkbox
                  checked={recipients.includes(l.id)}
                  onCheckedChange={(checked) => setRecipients((r) => (checked ? [...new Set([...r, l.id])] : r.filter((id) => id !== l.id)))}
                />
                {l.name}
                {l.id === me?._id && <span className="text-xs text-muted-foreground">(you)</span>}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center justify-between gap-3">
            <span>Send even if nothing changed</span>
            <Switch checked={sendUnchanged} onCheckedChange={(v) => setSendUnchanged(Boolean(v))} />
          </label>
          {report && (
            <p className="text-xs text-muted-foreground">
              {report.lastSentAt ? `Last sent ${new Date(report.lastSentAt).toLocaleString()}.` : "Not sent yet."}
              {report.schedule !== "off" && report.nextRunAt ? ` Next: ${new Date(report.nextRunAt).toLocaleString()}.` : ""}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => void sendNow()} disabled={send.isPending || recipients.length === 0 || !board.data?.blocks.length}>
            {send.isPending ? <LuLoaderCircle className="size-3.5 animate-spin" /> : <LuSend className="size-3.5" />}
            Send now
          </Button>
          <Button onClick={() => void save()} disabled={update.isPending || recipients.length === 0}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
