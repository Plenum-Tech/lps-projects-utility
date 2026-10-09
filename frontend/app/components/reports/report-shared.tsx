import type { ReactNode } from "react";
import {
  LuChartColumn,
  LuDownload,
  LuFileSpreadsheet,
  LuLoaderCircle,
} from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useCsvExport, useTimeExcelExport } from "@/hooks/use-work-reports";
import { todayKey } from "@/lib/tasks";
import { cn } from "@/lib/utils";

type ExportPath =
  | "/reports/time/export"
  | "/reports/tasks/export"
  | "/reports/timesheets/export";

/** Downloads the server CSV for the current filters. */
/** Downloads the formatted .xlsx time report for the current filters. */
export function ExcelExportButton({
  params,
  filenamePrefix,
  disabled,
}: {
  params: object;
  filenamePrefix: string;
  disabled?: boolean;
}) {
  const exporter = useTimeExcelExport();
  return (
    <Button
      onClick={() =>
        exporter.mutate({
          params,
          filename: `${filenamePrefix}-${todayKey()}.xlsx`,
        })
      }
      disabled={disabled || exporter.isPending}
    >
      {exporter.isPending ? (
        <LuLoaderCircle aria-hidden className="animate-spin" />
      ) : (
        <LuFileSpreadsheet aria-hidden />
      )}
      Export Excel
    </Button>
  );
}

export function CsvExportButton({
  path,
  params,
  filenamePrefix,
  disabled,
}: {
  path: ExportPath;
  params: object;
  filenamePrefix: string;
  disabled?: boolean;
}) {
  const exporter = useCsvExport();
  return (
    <Button
      variant="outline"
      onClick={() =>
        exporter.mutate({
          path,
          params,
          filename: `${filenamePrefix}-${todayKey()}.csv`,
        })
      }
      disabled={disabled || exporter.isPending}
    >
      {exporter.isPending ? (
        <LuLoaderCircle aria-hidden className="animate-spin" />
      ) : (
        <LuDownload aria-hidden />
      )}
      Export CSV
    </Button>
  );
}

/** Card wrapper for a chart with its own empty state. */
export function ChartCard({
  title,
  description,
  isEmpty,
  emptyText = "Nothing to chart for these filters.",
  action,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  isEmpty?: boolean;
  emptyText?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={cn("min-w-0", className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center">
            <LuChartColumn
              aria-hidden
              className="size-5 text-muted-foreground"
            />
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

/** Skeleton block shaped like KPI cards + two charts. */
export function ReportSkeleton({
  kpis = 4,
  charts = 2,
}: {
  kpis?: number;
  charts?: number;
}) {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading report">
      {kpis > 0 && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: kpis }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: charts }).map((_, index) => (
          <Skeleton key={index} className="h-72 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

/** Truncates long axis labels. */
export function shortLabel(value: unknown, max = 14): string {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
