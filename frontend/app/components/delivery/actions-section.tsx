import { useId, useState } from "react";
import { LuCircleCheck, LuClipboardCheck, LuFileWarning } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import { CsvButton } from "@/components/delivery/csv-button";
import { DASH, fmtNum, fmtPct, lowRateTone, rateTone, TONE_TEXT, userName, userNames } from "@/components/delivery/delivery-format";
import {
  DeliverySection,
  InfoTip,
  Panel,
  PanelState,
  RateBar,
  SortTable,
  useShowMore,
  type SortColumn,
} from "@/components/delivery/delivery-ui";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDeliveryBriefs, useDeliveryDelayed } from "@/hooks/use-delivery";
import { formatDateOnly } from "@/lib/format";
import { STATUS_META } from "@/lib/tasks";
import { cn } from "@/lib/utils";
import type {
  DeliveryBriefsResponse,
  DeliveryDelayedRow,
  DeliveryFilters,
  DeliveryTaskRow,
  DeliveryWeakBrief,
} from "@/types";

/** Task code + title cell. */
export function TaskCell({ task, className }: { task: DeliveryTaskRow; className?: string }) {
  return (
    <span className={cn("flex min-w-0 max-w-80 items-center gap-2", className)}>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[0.7rem] text-muted-foreground">
        {task.code}
      </span>
      <span className="truncate font-medium text-foreground" title={task.title}>
        {task.title}
      </span>
    </span>
  );
}

export function StatusCell({ status }: { status: DeliveryTaskRow["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span aria-hidden className={cn("size-2 rounded-full", meta?.dot ?? "bg-muted-foreground")} />
      {meta?.label ?? status}
    </span>
  );
}

export function TaskBrandCell({ task }: { task: DeliveryTaskRow }) {
  return (
    <BrandName name={task.brand.name} color={task.brand.color} noBrand={task.brand.noBrand} className="max-w-40" />
  );
}

/** 3 · Actions — delayed & open work, brief coverage. */
export function ActionsSection({
  filters,
  onOpenTask,
}: {
  filters: DeliveryFilters;
  onOpenTask: (id: string) => void;
}) {
  return (
    <DeliverySection id="actions" index={3} title="Actions" description="What needs chasing, and how well work is briefed.">
      <DelayedPanel filters={filters} onOpenTask={onOpenTask} />
      <BriefsPanel filters={filters} onOpenTask={onOpenTask} />
    </DeliverySection>
  );
}

function DelayedPanel({ filters, onOpenTask }: { filters: DeliveryFilters; onOpenTask: (id: string) => void }) {
  const [stale, setStale] = useState(false);
  const delayed = useDeliveryDelayed(filters, stale);
  const switchId = useId();
  const staleDays = delayed.data?.staleDays ?? 30;
  const rows = delayed.data?.rows ?? [];
  const { shown, more } = useShowMore(rows, 50);

  const columns: SortColumn<DeliveryDelayedRow>[] = [
    { id: "task", header: "Task", cell: (row) => <TaskCell task={row} />, sortValue: (row) => row.code },
    { id: "brand", header: "Brand", cell: (row) => <TaskBrandCell task={row} />, sortValue: (row) => row.brand.name },
    { id: "doers", header: "Doers", className: "max-w-48 truncate text-muted-foreground", cell: (row) => userNames(row.doers, "Unassigned"), sortValue: (row) => userNames(row.doers, "") },
    { id: "briefer", header: "Briefer", className: "text-muted-foreground", cell: (row) => userName(row.briefer), sortValue: (row) => userName(row.briefer) },
    { id: "due", header: "Due", cell: (row) => formatDateOnly(row.dueDate), sortValue: (row) => row.dueDate },
    {
      id: "late",
      header: "Days late",
      align: "right",
      cell: (row) =>
        row.daysLate === null ? (
          <span className="text-muted-foreground">{DASH}</span>
        ) : (
          <span className={cn("font-medium", row.stale ? "text-muted-foreground" : "text-critical")}>
            {row.daysLate}
            {row.stale && <span className="sr-only"> (stale)</span>}
          </span>
        ),
      sortValue: (row) => row.daysLate,
    },
    {
      id: "status",
      header: "Status",
      cell: (row) =>
        row.rejected ? (
          <Badge variant="destructive" className="text-[0.7rem]">Sent back</Badge>
        ) : (
          <StatusCell status={row.status} />
        ),
      sortValue: (row) => (row.rejected ? "0" : row.status),
    },
  ];

  return (
    <Panel
      title="Delayed & open work"
      description={
        <>
          Open tasks past their due date, plus tasks sent back (rejected). Click a row to open the task.
          {delayed.data && (
            <span className="block">
              {fmtNum(delayed.data.total)} {delayed.data.total === 1 ? "task" : "tasks"}
              {!stale && delayed.data.hiddenStale > 0 && ` · ${delayed.data.hiddenStale} stale hidden`}
              {delayed.data.truncated && " · showing the first 1,000 (export for all)"}
            </span>
          )}
        </>
      }
      action={
        <>
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={stale} onCheckedChange={setStale} />
            <Label htmlFor={switchId} className="cursor-pointer text-xs font-normal whitespace-nowrap">
              Include stale (&gt; {staleDays} days)
            </Label>
          </div>
          <CsvButton table="delayed" filters={filters} extra={{ stale: stale ? "1" : "0" }} disabled={!rows.length} />
        </>
      }
    >
      <PanelState
        query={delayed}
        errorTitle="Couldn't load delayed work"
        isEmpty={rows.length === 0}
        emptyIcon={LuCircleCheck}
        emptyTitle="Nothing delayed"
        emptyDescription={
          delayed.data?.hiddenStale
            ? `No recent delays. ${delayed.data.hiddenStale} stale ${delayed.data.hiddenStale === 1 ? "item is" : "items are"} hidden — turn on “Include stale” to see them.`
            : "Every open task is within its due date and nothing has been sent back."
        }
      >
        {() => (
          <>
            <SortTable
              caption="Delayed and open work"
              columns={columns}
              rows={shown}
              getRowId={(row) => row.id}
              onRowClick={(row) => onOpenTask(row.id)}
              rowLabel={(row) => `Open ${row.code} ${row.title}`}
              rowClassName={(row) => (row.stale ? "text-muted-foreground" : undefined)}
            />
            {more}
            {stale && (
              <p className="mt-3 text-xs text-muted-foreground">
                Items more than {staleDays} days late are probably abandoned — consider closing or re-planning them.
              </p>
            )}
          </>
        )}
      </PanelState>
    </Panel>
  );
}

function BriefsPanel({ filters, onOpenTask }: { filters: DeliveryFilters; onOpenTask: (id: string) => void }) {
  const briefs = useDeliveryBriefs(filters);
  const [tab, setTab] = useState("briefer");
  const data = briefs.data;

  return (
    <Panel
      title="Brief coverage by program manager"
      description={
        <>
          Each brief is scored against 7 rules; rules that don&apos;t apply are left out of its score.
          {data && data.totals.briefs > 0 && (
            <span className="block">
              {fmtNum(data.totals.briefs)} briefs in the period · average score{" "}
              <span className={cn("font-medium", TONE_TEXT[rateTone(data.totals.avgScore, 80, 60)])}>
                {fmtPct(data.totals.avgScore)}
              </span>
            </span>
          )}
        </>
      }
    >
      <PanelState query={briefs} errorTitle="Couldn't load brief coverage" skeletonHeight="h-64">
        {() =>
          data && (
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              <TabsList>
                <TabsTrigger value="briefer">By briefer</TabsTrigger>
                <TabsTrigger value="weakest">Weakest recent briefs</TabsTrigger>
              </TabsList>
              <TabsContent value="briefer" className="mt-3 space-y-3">
                <RuleLegend data={data} />
                <ByBrieferTable data={data} />
              </TabsContent>
              <TabsContent value="weakest" className="mt-3">
                <WeakestList data={data} onOpenTask={onOpenTask} />
              </TabsContent>
            </Tabs>
          )
        }
      </PanelState>
    </Panel>
  );
}

const RULE_NOTES: Record<string, string> = {
  attached: "A file attached within 24 h of creation, or a link in the description.",
  written: "The description, minus links, is long enough.",
  weekday: "Created on the briefing weekday.",
  leadTime: "Enough days between creation and due date. n/a without a due date.",
  noSameDay: "Not due on the day it was created (unless the brand is allowed). n/a without a due date.",
  teamMap: "Every doer is on the brand's team map. n/a when the brand has no map.",
  finalAsset: "Completed tasks only: any file on the task, or a final-asset link in the description, comments or notes.",
};

function RuleLegend({ data }: { data: DeliveryBriefsResponse }) {
  return (
    <details className="group rounded-lg border px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring/50">
        The 7 rules
      </summary>
      <ol className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {data.rules.map((rule) => {
          const total = data.totals.rules.find((rate) => rate.id === rule.id);
          return (
            <li key={rule.id} className="flex items-start gap-2">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-muted font-mono text-[0.65rem]">
                R{rule.id}
              </span>
              <span>
                <span className="font-medium text-foreground">{rule.label}</span>
                <span className="text-muted-foreground"> — {RULE_NOTES[rule.key] ?? ""}</span>
                {total && <span className="text-muted-foreground"> Overall {fmtPct(total.pct)}.</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

type BrieferRow = DeliveryBriefsResponse["byBriefer"][number];

function ByBrieferTable({ data }: { data: DeliveryBriefsResponse }) {
  if (data.byBriefer.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuClipboardCheck aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No briefs in this period</p>
        <p className="text-xs text-muted-foreground">Tasks created in the period appear here, grouped by who created them.</p>
      </div>
    );
  }
  const columns: SortColumn<BrieferRow>[] = [
    { id: "briefer", header: "Briefer", cell: (row) => <span className="font-medium">{userName(row.briefer)}</span>, sortValue: (row) => userName(row.briefer) },
    { id: "briefs", header: "Briefs", align: "right", cell: (row) => fmtNum(row.briefs), sortValue: (row) => row.briefs },
    {
      id: "score",
      header: "Avg score",
      align: "right",
      cell: (row) => <span className={cn("font-medium", TONE_TEXT[rateTone(row.avgScore, 80, 60)])}>{fmtPct(row.avgScore)}</span>,
      sortValue: (row) => row.avgScore,
    },
    ...data.rules.map<SortColumn<BrieferRow>>((rule) => ({
      id: `r${rule.id}`,
      header: `R${rule.id}`,
      hint: rule.label,
      cell: (row) => {
        const rate = row.rules.find((item) => item.id === rule.id);
        const pct = rate?.pct ?? null;
        return (
          <RateBar
            pct={pct}
            tone={rateTone(pct, 80, 50)}
            title={rate ? `${rule.label}: ${rate.passed} of ${rate.applicable} passed` : rule.label}
          />
        );
      },
      sortValue: (row) => row.rules.find((item) => item.id === rule.id)?.pct ?? null,
    })),
    {
      id: "rework",
      header: "Rework on their briefs",
      hint: "Share of their briefs that are rework",
      align: "right",
      cell: (row) => <span className={cn(row.reworkPct !== null && TONE_TEXT[lowRateTone(row.reworkPct)])}>{fmtPct(row.reworkPct)}</span>,
      sortValue: (row) => row.reworkPct,
    },
  ];
  return <SortTable caption="Brief coverage by briefer" columns={columns} rows={data.byBriefer} getRowId={(row) => row.briefer.id ?? `former-${row.briefer.name}`} defaultSort="briefs" />;
}

function WeakestList({ data, onOpenTask }: { data: DeliveryBriefsResponse; onOpenTask: (id: string) => void }) {
  const ruleLabel = (id: number) => data.rules.find((rule) => rule.id === id)?.label ?? `Rule ${id}`;
  if (data.weakest.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuFileWarning aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No briefs in the last {data.weakestWindowDays} days</p>
        <p className="text-xs text-muted-foreground">The weakest briefs are picked from tasks created in the last {data.weakestWindowDays} days (the period filter doesn&apos;t apply).</p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        The {data.weakest.length} lowest-scoring briefs created in the last {data.weakestWindowDays} days (period filter doesn&apos;t apply).
        <InfoTip label="About weakest briefs">Ties go to the newest brief. Click a brief to open the task.</InfoTip>
      </p>
      <ul className="max-h-[28rem] divide-y overflow-auto rounded-lg border">
        {data.weakest.map((brief: DeliveryWeakBrief) => (
          <li key={brief.id}>
            <button
              type="button"
              onClick={() => onOpenTask(brief.id)}
              className="flex w-full flex-col gap-2 px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:flex-row sm:items-center sm:gap-3"
            >
              <span className={cn("w-12 shrink-0 font-heading text-lg font-semibold tabular-nums", TONE_TEXT[rateTone(brief.score, 80, 50)])}>
                {Math.round(brief.score)}%
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <TaskCell task={brief} className="max-w-none" />
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <TaskBrandCell task={brief} />
                  <span>by {userName(brief.briefer)}</span>
                  <span>created {formatDateOnly(brief.createdDate)}</span>
                  <span>
                    {brief.passed}/{brief.applicable} rules
                  </span>
                </span>
              </span>
              <span className="flex flex-wrap gap-1 sm:max-w-[45%] sm:justify-end">
                {brief.failed.map((id) => (
                  <span
                    key={id}
                    className="inline-flex h-5 items-center gap-1 rounded-full border border-critical/30 bg-critical/10 px-2 text-[0.7rem] font-medium text-critical"
                    title={ruleLabel(id)}
                  >
                    R{id}
                    <span className="max-w-32 truncate font-normal">{ruleLabel(id)}</span>
                  </span>
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
