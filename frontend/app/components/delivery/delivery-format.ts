import type { DeliveryDelta, DeliveryPeriod, DeliveryUserRef } from "@/types";

export const PERIODS: { value: DeliveryPeriod; label: string; title: string }[] = [
  { value: "7d", label: "7d", title: "Last 7 days" },
  { value: "30d", label: "30d", title: "Last 30 days" },
  { value: "90d", label: "90d", title: "Last 90 days" },
  { value: "12m", label: "12m", title: "Last 12 months (365 days)" },
  { value: "all", label: "All", title: "All time (weekly charts show the latest 104 weeks)" },
  { value: "custom", label: "Custom", title: "Custom date range" },
];

export const DEFAULT_PERIOD: DeliveryPeriod = "30d";

export function isPeriod(value: string | null): value is DeliveryPeriod {
  return PERIODS.some((period) => period.value === value);
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-05" → "5 Oct" (axis ticks; tables use the settings-aware formatter). */
export function shortDay(ymd: string): string {
  const [, month, day] = ymd.split("-").map(Number);
  if (!month || !day) return ymd;
  return `${day} ${MONTHS[month - 1]}`;
}

export const DASH = "—";

export function fmtPct(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

export function fmtDays(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : `${value.toFixed(1).replace(/\.0$/, "")} d`;
}

export function fmtNum(value: number | null | undefined): string {
  return value === null || value === undefined ? DASH : value.toLocaleString();
}

export type DeltaUnit = "count" | "pct" | "days";

/** "+3", "−1.5 pp", "+0.4 d" — the sign uses a real minus. */
export function fmtChange(change: number, unit: DeltaUnit): string {
  const abs = Math.abs(change);
  const sign = change > 0 ? "+" : change < 0 ? "−" : "±";
  const body =
    unit === "count" ? abs.toLocaleString() : `${abs.toFixed(1).replace(/\.0$/, "")}${unit === "pct" ? " pp" : " d"}`;
  return `${sign}${body}`;
}

export type Tone = "good" | "warn" | "critical" | "neutral";

/** Delta → pill tone from the API's `good` flag. */
export function deltaTone(delta: DeltaLike): Tone {
  if (delta.good === true) return "good";
  if (delta.good === false) return "critical";
  return "neutral";
}

type DeltaLike = Pick<DeliveryDelta, "good">;

/** Text tone classes (theme tokens). */
export const TONE_TEXT: Record<Tone, string> = {
  good: "text-good",
  warn: "text-warn",
  critical: "text-critical",
  neutral: "text-foreground",
};

export const TONE_PILL: Record<Tone, string> = {
  good: "bg-good/10 text-good ring-good/30",
  warn: "bg-warn/10 text-warn ring-warn/30",
  critical: "bg-critical/10 text-critical ring-critical/30",
  neutral: "bg-muted text-muted-foreground ring-border",
};

export const TONE_BAR: Record<Tone, string> = {
  good: "bg-good",
  warn: "bg-warn",
  critical: "bg-critical",
  neutral: "bg-muted-foreground/60",
};

/** Higher-is-better rate (on time, brief rule pass rate). */
export function rateTone(pct: number | null, good = 85, warn = 65): Tone {
  if (pct === null) return "neutral";
  return pct >= good ? "good" : pct >= warn ? "warn" : "critical";
}

/** Lower-is-better rate (rework %, overdue %). */
export function lowRateTone(pct: number | null, good = 10, warn = 20): Tone {
  if (pct === null) return "neutral";
  return pct <= good ? "good" : pct <= warn ? "warn" : "critical";
}

export function overdueTone(overdue: number, open: number): Tone {
  if (overdue === 0) return "good";
  return open > 0 && overdue / open <= 0.15 ? "warn" : "critical";
}

export function userName(user: DeliveryUserRef): string {
  return user.former ? "Former user" : user.name;
}

export function userNames(users: DeliveryUserRef[], empty = "—"): string {
  return users.length ? users.map(userName).join(", ") : empty;
}
