import { useId, useState } from "react";
import { LuCircleCheck, LuClipboardCheck, LuFileWarning } from "react-icons/lu";

import { BrandName } from "@/components/delivery/brand-dot";
import { CsvButton } from "@/components/delivery/csv-button";
import {
  DASH,
  fmtNum,
  fmtPct,
  lowRateTone,
  rateTone,
  TONE_TEXT,
  userName,
  userNames,
} from "@/components/delivery/delivery-format";
import {
  DeliverySection,
  InfoTip,
  Panel,
  PanelState,
  RateBar,
  ScorePill,
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
  DeliveryBriefAttention,
  DeliveryBriefRuleKey,
} from "@/types";

/** Task code + title cell. */
export function TaskCell({
  task,
  className,
}: {
  task: DeliveryTaskRow;
  className?: string;
}) {
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
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          meta?.dot ?? "bg-muted-foreground",
        )}
      />
      {meta?.label ?? status}
    </span>
  );
}

export function TaskBrandCell({ task }: { task: DeliveryTaskRow }) {
  return (
    <BrandName
      name={task.brand.name}
      color={task.brand.color}
      noBrand={task.brand.noBrand}
      className="max-w-40"
    />
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
    <DeliverySection
      id="actions"
      index={3}
      title="Actions"
      description="What needs chasing, and how well work is briefed."
    >
      <DelayedPanel filters={filters} onOpenTask={onOpenTask} />
      <BriefsPanel filters={filters} onOpenTask={onOpenTask} />
    </DeliverySection>
  );
}

function DelayedPanel({
  filters,
  onOpenTask,
}: {
  filters: DeliveryFilters;
  onOpenTask: (id: string) => void;
}) {
  const [stale, setStale] = useState(false);
  const delayed = useDeliveryDelayed(filters, stale);
  const switchId = useId();
  const staleDays = delayed.data?.staleDays ?? 30;
  const rows = delayed.data?.rows ?? [];
  const { shown, more } = useShowMore(rows, 50);

  const columns: SortColumn<DeliveryDelayedRow>[] = [
    {
      id: "task",
      header: "Task",
      cell: (row) => <TaskCell task={row} />,
      sortValue: (row) => row.code,
    },
    {
      id: "brand",
      header: "Brand",
      cell: (row) => <TaskBrandCell task={row} />,
      sortValue: (row) => row.brand.name,
    },
    {
      id: "doers",
      header: "Doers",
      className: "max-w-48 truncate text-muted-foreground",
      cell: (row) => userNames(row.doers, "Unassigned"),
      sortValue: (row) => userNames(row.doers, ""),
    },
    {
      id: "briefer",
      header: "Briefed by",
      className: "text-muted-foreground",
      cell: (row) => userName(row.briefer),
      sortValue: (row) => userName(row.briefer),
    },
    {
      id: "created",
      header: "Created",
      className: "whitespace-nowrap text-muted-foreground",
      cell: (row) => formatDateOnly(row.createdDate),
      sortValue: (row) => row.createdDate,
    },
    {
      id: "due",
      header: "Due",
      cell: (row) => formatDateOnly(row.dueDate),
      sortValue: (row) => row.dueDate,
    },
    {
      id: "late",
      header: "Days late",
      align: "right",
      cell: (row) =>
        row.daysLate === null ? (
          <span className="text-muted-foreground">{DASH}</span>
        ) : (
          <span
            className={cn(
              "font-medium",
              row.stale ? "text-muted-foreground" : "text-critical",
            )}
          >
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
          <Badge variant="destructive" className="text-[0.7rem]">
            Sent back
          </Badge>
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
          Open tasks past their due date, plus tasks sent back (rejected). Click
          a row to open the task.
          {delayed.data && (
            <span className="block">
              {fmtNum(delayed.data.total)}{" "}
              {delayed.data.total === 1 ? "task" : "tasks"}
              {!stale &&
                delayed.data.hiddenStale > 0 &&
                ` · ${delayed.data.hiddenStale} stale hidden`}
              {delayed.data.truncated &&
                " · showing the first 1,000 (export for all)"}
            </span>
          )}
        </>
      }
      action={
        <>
          <div className="flex items-center gap-2">
            <Switch id={switchId} checked={stale} onCheckedChange={setStale} />
            <Label
              htmlFor={switchId}
              className="cursor-pointer text-xs font-normal whitespace-nowrap"
            >
              Include stale (&gt; {staleDays} days)
            </Label>
          </div>
          <CsvButton
            table="delayed"
            filters={filters}
            extra={{ stale: stale ? "1" : "0" }}
            disabled={!rows.length}
          />
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
              rowClassName={(row) =>
                row.stale ? "text-muted-foreground" : undefined
              }
            />
            {more}
            {stale && (
              <p className="mt-3 text-xs text-muted-foreground">
                Items more than {staleDays} days late are probably abandoned —
                consider closing or re-planning them.
              </p>
            )}
          </>
        )}
      </PanelState>
    </Panel>
  );
}

function BriefsPanel({
  filters,
  onOpenTask,
}: {
  filters: DeliveryFilters;
  onOpenTask: (id: string) => void;
}) {
  const briefs = useDeliveryBriefs(filters);
  const [tab, setTab] = useState("briefer");
  const data = briefs.data;

  return (
    <Panel
      title="Brief coverage and quality"
      description={
        <>
          Every task created in the period is checked against the 7 LPS brief
          rules; its brief score is the share of the rules that apply that it
          passes (0–100). Coverage: a task has a brief when it has a
          description or an attachment.
          {data?.aiConfigured
            ? " Each written brief is also read by an AI check that flags gibberish, off-context or off-brand text."
            : " The AI quality check is not configured yet (OpenAI key)."}
          {data && data.totals.briefs > 0 && (
            <span className="block">
              {fmtNum(data.totals.briefs)} tasks in the period
              {data.totals.score != null && (
                <>
                  {" "}· mean brief score{" "}
                  <span className={cn("font-medium", TONE_TEXT[rateTone(data.totals.score, 80, 50)])}>
                    {data.totals.score}
                  </span>
                </>
              )}{" "}
              · coverage{" "}
              <span
                className={cn(
                  "font-medium",
                  TONE_TEXT[rateTone(data.totals.coveragePct, 95, 80)],
                )}
              >
                {fmtPct(data.totals.coveragePct)}
              </span>
              {data.aiConfigured && data.totals.ai.checked > 0 && (
                <>
                  {" "}
                  · AI: {fmtNum(data.totals.ai.ok)} ok,{" "}
                  {fmtNum(data.totals.ai.weak)} weak,{" "}
                  <span
                    className={cn(
                      data.totals.ai.flagged > 0 && "font-medium text-critical",
                    )}
                  >
                    {fmtNum(data.totals.ai.flagged)} flagged
                  </span>
                </>
              )}
            </span>
          )}
        </>
      }
    >
      <PanelState
        query={briefs}
        errorTitle="Couldn't load brief coverage"
        skeletonHeight="h-64"
      >
        {() =>
          data && (
            <div className="space-y-4">
            {data.rules && data.totals.checks && <CheckTiles data={data} />}
            <Tabs value={tab} onValueChange={(value) => setTab(String(value))}>
              <TabsList className="h-auto flex-wrap">
                <TabsTrigger value="briefer">By briefer</TabsTrigger>
                <TabsTrigger value="coverage">Coverage &amp; AI check</TabsTrigger>
                <TabsTrigger value="weakest">Weakest recent briefs</TabsTrigger>
                <TabsTrigger value="attention">Needs attention</TabsTrigger>
              </TabsList>
              <TabsContent value="briefer" className="mt-3">
                <RulesByBrieferTable data={data} />
              </TabsContent>
              <TabsContent value="coverage" className="mt-3">
                <ByBrieferTable data={data} />
              </TabsContent>
              <TabsContent value="weakest" className="mt-3">
                <WeakestList data={data} onOpenTask={onOpenTask} />
              </TabsContent>
              <TabsContent value="attention" className="mt-3">
                <AttentionList data={data} onOpenTask={onOpenTask} />
              </TabsContent>
            </Tabs>
            </div>
          )
        }
      </PanelState>
    </Panel>
  );
}

type BrieferRow = DeliveryBriefsResponse["byBriefer"][number];

/** Short column headers for the LPS rules (the full label is the hint). */
const RULE_SHORT: Record<DeliveryBriefRuleKey, string> = {
  brief_attached: "Attached",
  written_brief: "Written",
  monday: "Monday",
  lead_time: "Lead time",
  not_same_day: "Not same-day",
  on_map: "On map",
  final_asset: "Final asset",
};

/** Pass-rate tone for the rule checks: good ≥ 80, warn ≥ 50. */
const checkTone = (pct: number | null) => rateTone(pct, 80, 50);

/** One tile per LPS rule: % of the period's tasks passing (where the rule applies). */
function CheckTiles({ data }: { data: DeliveryBriefsResponse }) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {data.rules.map((rule) => {
        const rate = data.totals.checks[rule.key];
        return (
          <li key={rule.key} className="flex flex-col rounded-lg border p-3">
            <span
              className={cn(
                "font-heading text-2xl font-semibold tabular-nums",
                rate?.pct == null ? "text-muted-foreground" : TONE_TEXT[checkTone(rate.pct)],
              )}
            >
              {rate?.pct == null ? DASH : `${Math.round(rate.pct)}%`}
            </span>
            <span className="mt-1 text-xs leading-snug">{rule.label}</span>
            <span className="mt-auto pt-1 text-[0.7rem] text-muted-foreground tabular-nums">
              {rate ? `${fmtNum(rate.passed)} of ${fmtNum(rate.applicable)}` : DASH}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function RulesByBrieferTable({ data }: { data: DeliveryBriefsResponse }) {
  if (data.byBriefer.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuClipboardCheck aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No tasks created in this period</p>
      </div>
    );
  }
  const columns: SortColumn<BrieferRow>[] = [
    {
      id: "briefer",
      header: "Briefer",
      cell: (row) => <span className="font-medium">{userName(row.briefer)}</span>,
      sortValue: (row) => userName(row.briefer),
    },
    {
      id: "briefs",
      header: "Briefs",
      align: "right",
      cell: (row) => fmtNum(row.briefs),
      sortValue: (row) => row.briefs,
    },
    {
      id: "score",
      header: "Score",
      hint: "Mean brief score (0–100): share of the applicable LPS rules passed",
      align: "right",
      cell: (row) => <ScorePill score={row.score ?? null} />,
      sortValue: (row) => row.score ?? null,
    },
    ...data.rules.map(
      (rule): SortColumn<BrieferRow> => ({
        id: `rule-${rule.key}`,
        header: RULE_SHORT[rule.key] ?? rule.label,
        hint: rule.label,
        align: "right",
        cell: (row) => {
          const rate = row.checks?.[rule.key];
          return (
            <span
              className={cn("tabular-nums", rate?.pct != null && TONE_TEXT[checkTone(rate.pct)])}
              title={rate ? `${rate.passed} of ${rate.applicable}` : undefined}
            >
              {rate?.pct == null ? DASH : `${Math.round(rate.pct)}%`}
            </span>
          );
        },
        sortValue: (row) => row.checks?.[rule.key]?.pct ?? null,
      }),
    ),
    {
      id: "rework",
      header: "Rework on their briefs",
      hint: "Share of their briefs marked as rework",
      align: "right",
      cell: (row) => (
        <span className={cn(row.reworkPct !== null && TONE_TEXT[lowRateTone(row.reworkPct)])}>
          {fmtPct(row.reworkPct)}
        </span>
      ),
      sortValue: (row) => row.reworkPct,
    },
  ];
  return (
    <SortTable
      caption="LPS brief rules by briefer"
      columns={columns}
      rows={data.byBriefer}
      getRowId={(row) => row.briefer.id ?? `former-${row.briefer.name}`}
      defaultSort="briefs"
    />
  );
}

function WeakestList({
  data,
  onOpenTask,
}: {
  data: DeliveryBriefsResponse;
  onOpenTask: (id: string) => void;
}) {
  const weakest = data.weakest ?? [];
  if (weakest.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuCircleCheck aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No weak briefs</p>
        <p className="text-xs text-muted-foreground">Every task created in the period passes all the rules that apply.</p>
      </div>
    );
  }
  const labels = new Map(data.rules.map((rule) => [rule.key, rule.label]));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Lowest brief scores among tasks created in the period, newest first among ties. Click a task to open it.
      </p>
      <ul className="max-h-[28rem] divide-y overflow-auto rounded-lg border">
        {weakest.map((brief) => (
          <li key={brief.id}>
            <button
              type="button"
              onClick={() => onOpenTask(brief.id)}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <span className="min-w-0 flex-1 space-y-1">
                <TaskCell task={brief} className="max-w-none" />
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <TaskBrandCell task={brief} />
                  <span>created {formatDateOnly(brief.createdDate)}</span>
                  <span>by {userName(brief.briefer)}</span>
                </span>
                <span className="line-clamp-2 block text-xs text-foreground/80">
                  {brief.snippet || <span className="text-muted-foreground italic">No description</span>}
                </span>
                {brief.failed.length > 0 && (
                  <span className="block text-[0.7rem] text-critical">
                    Missed: {brief.failed.map((key) => labels.get(key) ?? key).join(" · ")}
                  </span>
                )}
              </span>
              <ScorePill score={brief.score} title={`${brief.passed} of ${brief.applicable} rules passed`} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ByBrieferTable({ data }: { data: DeliveryBriefsResponse }) {
  if (data.byBriefer.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuClipboardCheck
          aria-hidden
          className="size-5 text-muted-foreground"
        />
        <p className="text-sm font-medium">No tasks created in this period</p>
        <p className="text-xs text-muted-foreground">
          Tasks created in the period appear here, grouped by who created them.
        </p>
      </div>
    );
  }
  const columns: SortColumn<BrieferRow>[] = [
    {
      id: "briefer",
      header: "Person",
      cell: (row) => (
        <span className="font-medium">{userName(row.briefer)}</span>
      ),
      sortValue: (row) => userName(row.briefer),
    },
    {
      id: "briefs",
      header: "Tasks",
      align: "right",
      cell: (row) => fmtNum(row.briefs),
      sortValue: (row) => row.briefs,
    },
    {
      id: "coverage",
      header: "With brief",
      hint: "Description or attachment",
      cell: (row) => (
        <RateBar
          pct={row.coveragePct}
          tone={rateTone(row.coveragePct, 95, 80)}
          title={`${row.covered} of ${row.briefs} tasks have a description or an attachment`}
        />
      ),
      sortValue: (row) => row.coveragePct,
    },
    ...(data.aiConfigured
      ? ([
          {
            id: "aiScore",
            header: "Brief score",
            hint: "Average AI brief score (0–100): English, clear, on-brand, actionable; links score higher",
            align: "right",
            cell: (row) => (row.ai.avgScore == null ? "—" : `${row.ai.avgScore}`),
            sortValue: (row) => row.ai.avgScore ?? -1,
          },
          {
            id: "aiOk",
            header: "AI: good",
            hint: "Share of checked briefs the AI rated ok",
            cell: (row) => (
              <RateBar
                pct={row.ai.okPct}
                tone={rateTone(row.ai.okPct, 85, 60)}
                title={`${row.ai.ok} of ${row.ai.checked} checked briefs rated ok`}
              />
            ),
            sortValue: (row) => row.ai.okPct,
          },
          {
            id: "aiWeak",
            header: "Weak",
            align: "right",
            cell: (row) => fmtNum(row.ai.weak),
            sortValue: (row) => row.ai.weak,
          },
          {
            id: "aiFlagged",
            header: "Flagged",
            align: "right",
            cell: (row) => (
              <span
                className={cn(
                  row.ai.flagged > 0 && "font-medium text-critical",
                )}
              >
                {fmtNum(row.ai.flagged)}
              </span>
            ),
            sortValue: (row) => row.ai.flagged,
          },
        ] satisfies SortColumn<BrieferRow>[])
      : []),
    {
      id: "rework",
      header: "Rework",
      hint: "Share of their tasks marked as rework",
      align: "right",
      cell: (row) => (
        <span
          className={cn(
            row.reworkPct !== null && TONE_TEXT[lowRateTone(row.reworkPct)],
          )}
        >
          {fmtPct(row.reworkPct)}
        </span>
      ),
      sortValue: (row) => row.reworkPct,
    },
  ];
  return (
    <SortTable
      caption="Brief coverage and quality by person"
      columns={columns}
      rows={data.byBriefer}
      getRowId={(row) => row.briefer.id ?? `former-${row.briefer.name}`}
      defaultSort="briefs"
    />
  );
}

const ISSUE_META: Record<
  DeliveryBriefAttention["issue"],
  { label: string; className: string }
> = {
  flagged: {
    label: "Flagged",
    className: "border-critical/30 bg-critical/10 text-critical",
  },
  missing: {
    label: "No brief",
    className: "border-critical/30 bg-critical/10 text-critical",
  },
  weak: { label: "Weak", className: "border-warn/40 bg-warn/10 text-warn" },
};

function AttentionList({
  data,
  onOpenTask,
}: {
  data: DeliveryBriefsResponse;
  onOpenTask: (id: string) => void;
}) {
  if (data.attention.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center">
        <LuCircleCheck aria-hidden className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">Nothing needs attention</p>
        <p className="text-xs text-muted-foreground">
          Every task created in the last {data.attentionWindowDays} days has a
          brief{data.aiConfigured ? " and none was flagged" : ""}.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        Tasks created in the last {data.attentionWindowDays} days with no brief
        {data.aiConfigured ? ", or a brief the AI flagged or rated weak" : ""}{" "}
        (period filter doesn&apos;t apply).
        <InfoTip label="About this list">
          Flagged first, then missing, then weak; newest first. Click a task to
          open it.
        </InfoTip>
      </p>
      <ul className="max-h-[28rem] divide-y overflow-auto rounded-lg border">
        {data.attention.map((brief) => (
          <li key={brief.id}>
            <button
              type="button"
              onClick={() => onOpenTask(brief.id)}
              className="flex w-full flex-col gap-2 px-3 py-2.5 text-left outline-none transition-colors duration-150 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:flex-row sm:items-center sm:gap-3"
            >
              <span
                className={cn(
                  "inline-flex h-6 w-20 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                  ISSUE_META[brief.issue].className,
                )}
              >
                {ISSUE_META[brief.issue].label}
              </span>
              <span className="min-w-0 flex-1 space-y-1">
                <TaskCell task={brief} className="max-w-none" />
                <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <TaskBrandCell task={brief} />
                  <span>by {userName(brief.briefer)}</span>
                  <span>created {formatDateOnly(brief.createdDate)}</span>
                  {brief.reason && (
                    <span className="text-foreground">{brief.reason}</span>
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
