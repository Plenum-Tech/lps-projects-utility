import { Link } from "react-router";
import { LuExternalLink } from "react-icons/lu";

import { DataBlock } from "@/components/insights/data-block";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useInsightOptions } from "@/hooks/use-insights";
import type { BlockSpec, DrillTarget } from "@/lib/insights/types";

// ---------------------------------------------------------------------------
// Drill-down from a row / bar / slice: a side sheet of live blocks about that
// brand, person, team or pitch lead (tasks open in the task page directly).
// ---------------------------------------------------------------------------

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

function blocksFor(target: DrillTarget): Array<Omit<BlockSpec, "id">> {
  const v = target.value;
  switch (target.kind) {
    case "brand":
      return [
        { title: `${v} — scope usage by project`, tool: "scopeUsage", params: { brand: v, month: thisMonth() }, list: "projects" },
        { title: `${v} — tasks by person, last 30 days`, tool: "tasksSummary", params: { brand: v, groupBy: "person" } },
        { title: `${v} — late and overdue tasks`, tool: "lateTasks", params: { brand: v, kind: "both" } },
      ];
    case "person":
      return [
        { title: `${v} — today`, tool: "teamDay", params: { person: v }, list: "tasks" },
        { title: `${v} — updates, last 24 hours`, tool: "taskActivity", params: { person: v } },
        { title: `${v} — tasks by brand, last 30 days`, tool: "tasksSummary", params: { person: v, groupBy: "brand" } },
        { title: `${v} — hours by brand, last 30 days`, tool: "timeLogged", params: { person: v, groupBy: "brand" }, view: "bar" },
        { title: `${v} — late and overdue tasks`, tool: "lateTasks", params: { person: v, kind: "both" } },
      ];
    case "team":
      return [
        { title: `${v} — tasks by person, last 30 days`, tool: "tasksSummary", params: { team: v, groupBy: "person" } },
        { title: `${v} — rework by person, last 3 months`, tool: "reworkStats", params: { team: v, groupBy: "person", from: monthsAgo(2), to: today() } },
      ];
    case "lead":
      return [{ title: `${v} — pitches this quarter`, tool: "pitchPipeline", params: { lead: v }, list: "pitches" }];
    default:
      return [];
  }
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function monthsAgo(n: number) {
  const d = new Date(new Date().getFullYear(), new Date().getMonth() - n, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

const KIND_LABEL = { brand: "Brand", person: "Person", team: "Team", lead: "Pitch lead", task: "Task" } as const;

export function DrillSheet({ target, onClose }: { target: DrillTarget | null; onClose: () => void }) {
  const options = useInsightOptions();
  const brandId = target?.kind === "brand" ? options.data?.brands.find((b) => b.name === target.value)?.id : undefined;
  return (
    <Sheet open={Boolean(target)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-2xl">
        {target && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle>{target.value}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-3">
                {KIND_LABEL[target.kind]} details from live data.
                {brandId && (
                  <Link to={`/brands/${brandId}`} className="inline-flex items-center gap-1 text-primary hover:underline">
                    Open brand page <LuExternalLink className="size-3" aria-hidden />
                  </Link>
                )}
                {target.kind === "lead" && (
                  <Link to="/pitches" className="inline-flex items-center gap-1 text-primary hover:underline">
                    Open Pitch &amp; Growth <LuExternalLink className="size-3" aria-hidden />
                  </Link>
                )}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-3 overflow-y-auto p-4">
              {blocksFor(target).map((spec) => (
                <DataBlock key={spec.title} spec={spec} mode="sheet" />
              ))}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
