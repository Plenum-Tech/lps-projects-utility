import { Badge } from "@/components/ui/badge";
import { statusColor } from "@/lib/projects";
import { TIMELOG_STATUS_META, TIMESHEET_STATUS_META } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { ProjectStatusRef, TimeLogStatus, TimesheetStatus } from "@/types";

/** Coloured pill for a (custom) project status. */
export function ProjectStatusPill({
  status,
  className,
}: {
  status: Pick<ProjectStatusRef, "name" | "color">;
  className?: string;
}) {
  const meta = statusColor(status.color);
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-44 items-center gap-1.5 rounded-full border px-2 text-[0.7rem] font-medium text-foreground",
        meta.chip,
        className
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", meta.dot)} />
      <span className="truncate">{status.name}</span>
    </span>
  );
}

/** Small marker for projects that still have a legacy free-text name (no Brand_Type_MonYYYY_Name parts). */
export function LegacyNameBadge({ className }: { className?: string }) {
  return (
    <span
      title="Legacy name — edit the project to convert it to Brand_Type_MonYYYY_Name"
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center rounded-full border border-dashed px-1.5 text-[0.65rem] font-medium whitespace-nowrap text-muted-foreground",
        className
      )}
    >
      Legacy name
    </span>
  );
}

/** Circular progress ring (SVG, uses currentColor from theme tokens). */
export function ProgressRing({
  value,
  size = 44,
  stroke = 4,
  className,
  label = true,
}: {
  value: number;
  size?: number;
  stroke?: number;
  className?: string;
  label?: boolean;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return (
    <span
      role="img"
      aria-label={`${clamped}% complete`}
      className={cn("relative inline-flex shrink-0 items-center justify-center", className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={cn(
            "transition-[stroke-dashoffset] duration-200 ease-out",
            clamped >= 100 ? "stroke-primary" : "stroke-chart-2"
          )}
        />
      </svg>
      {label && (
        <span className="absolute text-[0.65rem] font-semibold text-foreground tabular-nums">
          {clamped}%
        </span>
      )}
    </span>
  );
}

/** Thin horizontal bar (theme tokens). */
export function ProgressBar({
  value,
  className,
  tone = "default",
}: {
  value: number;
  className?: string;
  tone?: "default" | "warning" | "destructive";
}) {
  const clamped = Math.max(0, Math.min(100, value));
  const fill =
    tone === "destructive" ? "bg-destructive" : tone === "warning" ? "bg-chart-4" : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-200 ease-out", fill)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function TimeLogStatusBadge({ status }: { status: TimeLogStatus }) {
  const meta = TIMELOG_STATUS_META[status];
  return (
    <Badge variant={meta.badge} className="gap-1.5">
      <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

export function TimesheetStatusBadge({ status }: { status: TimesheetStatus }) {
  const meta = TIMESHEET_STATUS_META[status];
  return (
    <Badge variant={meta.badge} className="gap-1.5">
      <span aria-hidden className={cn("size-1.5 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  );
}

/** Monospace short code chip, e.g. "WEB-12". */
export function ShortCode({ code, className }: { code: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md border bg-muted/60 px-1.5 font-mono text-[0.68rem] font-medium text-muted-foreground",
        className
      )}
    >
      {code}
    </span>
  );
}
