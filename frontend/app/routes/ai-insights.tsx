import { redirect } from "react-router";
import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Clock,
  Eye,
  LoaderCircle,
  Plus,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";

import { formatDate } from "@/lib/format";
import { DataTablePagination } from "@/components/globals/data-table-pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useGenerateInsight, useInsights } from "@/hooks/use-ai-insights";
import { usePagination } from "@/hooks/use-pagination";
import { getErrorMessage } from "@/lib/api";
import type { AiInsight } from "@/types";

import { FEATURES } from "@/lib/features";

import type { Route } from "./+types/ai-insights";

/** Hidden while the feature switch is off (see lib/features.ts). */
export function loader() {
  if (!FEATURES.aiInsights) throw redirect("/dashboard");
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: "AI Insights | LPS" }];
}

const PAGE_SIZE = 10;

const PERIOD_OPTIONS = [
  "Last 30 days",
  "Last 90 days",
  "Last 6 months",
  "Last year",
];

/**
 * Head AI insights: generate department-scoped insights and view past results.
 */
export default function HeadAiInsights() {
  const [search, setSearch] = useState("");
  const { page, setPage, offset, total, setTotal } = usePagination({
    limit: PAGE_SIZE,
    resetKey: search,
  });
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    isRefetching,
  } = useInsights({ limit: PAGE_SIZE, offset });
  const insights = data?.insights;

  const [generateOpen, setGenerateOpen] = useState(false);
  const [viewing, setViewing] = useState<AiInsight | null>(null);

  useEffect(() => {
    setTotal(data?.total ?? 0);
  }, [data?.total, setTotal]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-foreground">
            AI Insights
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI-generated insights and recommendations for your department based
            on employee data, performance metrics, and feedback.
          </p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <Sparkles />
          Generate insight
        </Button>
      </header>

      <div className="mt-8 space-y-4">
        {isPending ? (
          <InsightListSkeleton />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Couldn&apos;t load insights</AlertTitle>
            <AlertDescription className="flex flex-wrap items-center gap-2">
              {getErrorMessage(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
                disabled={isRefetching}
              >
                {isRefetching ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RefreshCw />
                )}
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        ) : total > 0 ? (
          <>
            <div className="grid gap-4">
              {insights?.map((insight) => (
                <InsightCard
                  key={insight._id}
                  insight={insight}
                  onView={() => setViewing(insight)}
                />
              ))}
            </div>
            <DataTablePagination
              page={page}
              limit={PAGE_SIZE}
              total={total}
              onPageChange={setPage}
            />
          </>
        ) : (
          <Empty className="py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Brain />
              </EmptyMedia>
              <EmptyTitle>No insights yet</EmptyTitle>
              <EmptyDescription>
                Generate your first AI insight to get data-driven
                recommendations for your department.
              </EmptyDescription>
            </EmptyHeader>
            <Button onClick={() => setGenerateOpen(true)}>
              <Sparkles />
              Generate insight
            </Button>
          </Empty>
        )}
      </div>

      <GenerateInsightDialog
        open={generateOpen}
        onOpenChange={(open) => {
          if (!open) setGenerateOpen(false);
        }}
      />
      <InsightDetailDialog
        insight={viewing}
        onOpenChange={(open) => {
          if (!open) setViewing(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const STATUS_META: Record<
  AiInsight["status"],
  { label: string; icon: typeof Clock; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  pending: { label: "Pending", icon: Clock, variant: "outline" },
  generating: { label: "Generating", icon: LoaderCircle, variant: "secondary" },
  completed: { label: "Completed", icon: CheckCircle2, variant: "default" },
  failed: { label: "Failed", icon: XCircle, variant: "destructive" },
};

function InsightCard({
  insight,
  onView,
}: {
  insight: AiInsight;
  onView: () => void;
}) {
  const meta = STATUS_META[insight.status];
  const Icon = meta.icon;

  return (
    <Card className="transition-colors hover:bg-muted/30">
      <CardContent className="flex flex-wrap items-center gap-4 p-4 sm:p-6">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Sparkles className="size-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-heading text-lg font-semibold text-foreground">
              {insight.title ?? "Generating insight…"}
            </h3>
            <Badge variant={meta.variant} className="gap-1">
              <Icon
                className={`size-3 ${insight.status === "generating" ? "animate-spin" : ""}`}
              />
              {meta.label}
            </Badge>
          </div>
          {insight.summary && (
            <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
              {insight.summary}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {insight.period} ·{" "}
            {formatDate(insight.createdAt)}
          </p>
          {insight.error && (
            <p className="mt-1 text-xs text-destructive">{insight.error}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onView}
            disabled={insight.status !== "completed"}
          >
            <Eye />
            View
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function InsightListSkeleton() {
  return (
    <div className="grid gap-4">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i} aria-busy="true" aria-label="Loading insight">
          <CardContent className="space-y-3 p-4 sm:p-6">
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-72" />
                <Skeleton className="h-3 w-36" />
              </div>
              <Skeleton className="h-8 w-16" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generate Insight Dialog
// ---------------------------------------------------------------------------

function GenerateInsightDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const generate = useGenerateInsight();
  const [period, setPeriod] = useState(PERIOD_OPTIONS[0]);
  const [customPeriod, setCustomPeriod] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (open) {
      setPeriod(PERIOD_OPTIONS[0]);
      setCustomPeriod("");
      setUseCustom(false);
      setSubmitted(false);
    }
  }, [open]);

  const effectivePeriod = useCustom ? customPeriod.trim() : period;
  const periodInvalid = submitted && !effectivePeriod;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (!effectivePeriod) return;

    generate.mutate(
      { period: effectivePeriod },
      { onSuccess: () => onOpenChange(false) }
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate AI insight</DialogTitle>
          <DialogDescription>
            AI will analyze your department&apos;s data including attendance,
            leaves, tasks, performance reviews, and feedback to generate
            actionable insights.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label>Time period</Label>
            <div className="flex flex-wrap gap-2">
              {PERIOD_OPTIONS.map((opt) => (
                <Button
                  key={opt}
                  type="button"
                  variant={!useCustom && period === opt ? "default" : "outline"}
                  size="sm"
                  onClick={() => {
                    setPeriod(opt);
                    setUseCustom(false);
                  }}
                >
                  {opt}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="custom-period">Or enter a custom period</Label>
            <Input
              id="custom-period"
              value={customPeriod}
              onChange={(e) => {
                setCustomPeriod(e.target.value);
                setUseCustom(true);
              }}
              placeholder="e.g. Q1 2026, January 2026"
              aria-invalid={periodInvalid}
            />
            {periodInvalid && (
              <p className="text-xs text-destructive">
                Please select or enter a time period.
              </p>
            )}
          </div>

          {generate.isError && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Generation failed</AlertTitle>
              <AlertDescription>{getErrorMessage(generate.error)}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={generate.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={generate.isPending}>
              {generate.isPending ? (
                <LoaderCircle className="animate-spin" />
              ) : (
                <Sparkles />
              )}
              {generate.isPending ? "Starting…" : "Generate insight"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Insight Detail Dialog
// ---------------------------------------------------------------------------

function InsightDetailDialog({
  insight,
  onOpenChange,
}: {
  insight: AiInsight | null;
  onOpenChange: (open: boolean) => void;
}) {
  const open = insight !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        {insight && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={STATUS_META[insight.status].variant}>
                  {STATUS_META[insight.status].label}
                </Badge>
              </div>
              <DialogTitle>{insight.title}</DialogTitle>
              <DialogDescription>
                {insight.period} · Generated on{" "}
                {formatDate(insight.createdAt)}
              </DialogDescription>
            </DialogHeader>

            {insight.summary && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
                <p className="text-sm font-medium text-foreground">
                  {insight.summary}
                </p>
              </div>
            )}

            {insight.content && (
              <div className="prose prose-sm max-w-none dark:prose-invert">
                {insight.content.split("\n").map((line, i) => {
                  if (line.startsWith("## ")) {
                    return (
                      <h2
                        key={i}
                        className="mt-6 mb-2 font-heading text-lg font-semibold text-foreground"
                      >
                        {line.replace("## ", "")}
                      </h2>
                    );
                  }
                  if (line.startsWith("### ")) {
                    return (
                      <h3
                        key={i}
                        className="mt-4 mb-1 font-heading text-base font-semibold text-foreground"
                      >
                        {line.replace("### ", "")}
                      </h3>
                    );
                  }
                  if (line.startsWith("- ") || line.startsWith("* ")) {
                    return (
                      <li key={i} className="ml-4 text-sm text-muted-foreground">
                        {renderInlineFormatting(line.slice(2))}
                      </li>
                    );
                  }
                  if (line.startsWith("**") && line.endsWith("**")) {
                    return (
                      <p key={i} className="mt-3 text-sm font-semibold text-foreground">
                        {line.replace(/\*\*/g, "")}
                      </p>
                    );
                  }
                  if (line.trim() === "") {
                    return <div key={i} className="h-2" />;
                  }
                  return (
                    <p key={i} className="text-sm leading-relaxed text-muted-foreground">
                      {renderInlineFormatting(line)}
                    </p>
                  );
                })}
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Renders **bold** and `code` inline formatting. */
function renderInlineFormatting(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push(
        <strong key={match.index} className="font-semibold text-foreground">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`")) {
      parts.push(
        <code
          key={match.index}
          className="rounded bg-muted px-1 py-0.5 text-xs"
        >
          {token.slice(1, -1)}
        </code>
      );
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
