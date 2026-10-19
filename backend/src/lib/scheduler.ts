import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import mongoose from "mongoose";
import { appDateKey, zonedParts } from "./appTime.js";
import { runHrReminders } from "./hrJobs.js";
import { purgeExpiredImportFiles } from "./imports/jobs.js";
import { runPitchMissedReminders } from "./pitches.js";
import { runProjectDeadlineReminders, runProjectProgressDeadlineMode } from "./projectJobs.js";
import { isDbReady, runRecurringTasks, runTaskReminders } from "./taskJobs.js";
import { runAutoStopTimers, runDailyTimeLogReport, runTimeTrackerReminder } from "./timeJobs.js";

// ---------------------------------------------------------------------------
// In-process job scheduler (JOBS_MODE=in-process).
//
// Runs the same job functions and times as the Inngest crons, in the app
// timezone (Settings → App Settings, else APP_TIMEZONE). Every replica ticks
// once a minute; a Mongo lease lock (one `joblocks` document per job) makes
// sure each schedule slot runs on exactly one replica:
//
//   { _id: "task-reminders", slot: "2026-10-06", owner, leaseUntil, ... }
//
// A replica claims a job only when the stored slot differs from the current
// one AND no unexpired lease is held — an atomic findOneAndUpdate (upsert; the
// unique _id turns a lost race into a duplicate-key error = "not mine").
// Daily jobs catch up later the same day if the process was down at their
// time (the jobs are idempotent per day). Failures retry up to 3 times, one
// minute apart.
// ---------------------------------------------------------------------------

type Schedule = { kind: "every"; minutes: number } | { kind: "daily"; at: string };

interface JobDefinition {
  name: string;
  schedule: Schedule;
  run: (now: Date) => Promise<unknown>;
}

/** Same schedule as backend/src/inngest/functions/* (times are app-timezone wall-clock). */
export const SCHEDULED_JOBS: JobDefinition[] = [
  { name: "auto-stop-timers", schedule: { kind: "every", minutes: 15 }, run: runAutoStopTimers },
  { name: "time-tracker-reminder", schedule: { kind: "every", minutes: 15 }, run: runTimeTrackerReminder },
  // Raw import uploads are kept for at most an hour (also swept on import requests).
  { name: "import-file-cleanup", schedule: { kind: "every", minutes: 15 }, run: purgeExpiredImportFiles },
  // Pitch steps past their due date and not done: one email per step per due date.
  { name: "pitch-missed-dates", schedule: { kind: "every", minutes: 60 }, run: runPitchMissedReminders },
  { name: "project-progress-deadline-mode", schedule: { kind: "daily", at: "00:15" }, run: runProjectProgressDeadlineMode },
  { name: "recurring-tasks", schedule: { kind: "daily", at: "00:30" }, run: runRecurringTasks },
  { name: "task-reminders", schedule: { kind: "daily", at: "08:00" }, run: runTaskReminders },
  { name: "project-deadline-reminders", schedule: { kind: "daily", at: "08:00" }, run: runProjectDeadlineReminders },
  { name: "hr-reminders", schedule: { kind: "daily", at: "08:00" }, run: runHrReminders },
  { name: "daily-time-log-report", schedule: { kind: "daily", at: "19:30" }, run: runDailyTimeLogReport },
];

const COLLECTION = "joblocks";
const TICK_MS = 60_000;
/** Longest a job may hold its lease; a crashed replica's lock frees up after this. */
const LEASE_MS = 15 * 60_000;
const RETRY_DELAY_MS = 60_000;
const MAX_ATTEMPTS = 3;

interface JobLockDoc {
  _id: string;
  slot: string | null;
  owner: string;
  leaseUntil: Date;
  attempts?: number;
  startedAt?: Date;
  finishedAt?: Date;
  lastError?: string | null;
}

const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString("hex")}`;
let timer: ReturnType<typeof setInterval> | undefined;
let firstTick: ReturnType<typeof setTimeout> | undefined;
const running = new Map<string, Promise<void>>();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Current slot key for a job, or null when a daily job isn't due yet today. */
export function slotFor(schedule: Schedule, now: Date): string | null {
  const p = zonedParts(now);
  const day = appDateKey(now);
  if (schedule.kind === "every") {
    const bucket = Math.floor(p.minute / schedule.minutes) * schedule.minutes;
    return `${day}T${pad(p.hour)}:${pad(bucket)}`;
  }
  const [h, m] = schedule.at.split(":").map(Number);
  return p.hour * 60 + p.minute >= h! * 60 + m! ? day : null;
}

function locks() {
  return mongoose.connection.collection<JobLockDoc>(COLLECTION);
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/** Atomically claims `slot` for `job`; returns the previous lock doc (or {} when newly created), null when not ours. */
async function claim(job: string, slot: string, now: Date): Promise<Partial<JobLockDoc> | null> {
  try {
    const previous = await locks().findOneAndUpdate(
      { _id: job, slot: { $ne: slot }, leaseUntil: { $lte: now } },
      { $set: { slot, owner, leaseUntil: new Date(now.getTime() + LEASE_MS), startedAt: now } },
      { upsert: true, returnDocument: "before" }
    );
    return previous ?? {};
  } catch (err) {
    if (isDuplicateKey(err)) return null; // another replica holds it / already ran this slot
    throw err;
  }
}

async function runJob(job: JobDefinition, now: Date): Promise<void> {
  const slot = slotFor(job.schedule, now);
  if (!slot) return;
  const previous = await claim(job.name, slot, now);
  if (!previous) return;

  const attempt = previous.slot === `retry:${slot}` ? (previous.attempts ?? 1) + 1 : 1;
  const started = Date.now();
  try {
    const result = await job.run(now);
    await locks().updateOne(
      { _id: job.name, owner },
      { $set: { leaseUntil: new Date(), finishedAt: new Date(), attempts: attempt, lastError: null } }
    );
    console.log(
      `[scheduler] ${job.name} slot=${slot} ok in ${Date.now() - started}ms on ${owner}: ${JSON.stringify(result)}`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retry = attempt < MAX_ATTEMPTS;
    console.error(`[scheduler] ${job.name} slot=${slot} failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${message}`);
    // Re-open the slot for a retry (a distinct marker so it counts attempts), or give up on it.
    await locks()
      .updateOne(
        { _id: job.name, owner },
        {
          $set: {
            slot: retry ? `retry:${slot}` : slot,
            attempts: attempt,
            leaseUntil: new Date(Date.now() + (retry ? RETRY_DELAY_MS : 0)),
            finishedAt: new Date(),
            lastError: message.slice(0, 500),
          },
        }
      )
      .catch(() => undefined);
  }
}

function tick(): void {
  if (!isDbReady()) return;
  const now = new Date();
  for (const job of SCHEDULED_JOBS) {
    if (running.has(job.name)) continue;
    const p = runJob(job, now)
      .catch((err) => console.error(`[scheduler] ${job.name} lock error:`, err instanceof Error ? err.message : err))
      .finally(() => running.delete(job.name));
    running.set(job.name, p);
  }
}

/** Starts the once-a-minute scheduler (first tick after a short random delay). */
export function startScheduler(): void {
  if (timer) return;
  console.log(`[scheduler] in-process jobs enabled (${SCHEDULED_JOBS.length} jobs, owner ${owner})`);
  firstTick = setTimeout(tick, 5_000 + Math.floor(Math.random() * 5_000));
  timer = setInterval(tick, TICK_MS);
}

/** Stops ticking and waits (bounded) for running jobs; their leases expire if cut short. */
export async function stopScheduler(timeoutMs = 10_000): Promise<void> {
  if (firstTick) clearTimeout(firstTick);
  if (timer) clearInterval(timer);
  timer = undefined;
  if (running.size === 0) return;
  await Promise.race([
    Promise.allSettled([...running.values()]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
