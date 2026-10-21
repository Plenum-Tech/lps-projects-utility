import mongoose, { Schema } from "mongoose";
import bcrypt from "bcryptjs";
import { nextEmployeeId } from "../lib/employeeIds.js";
import { invalidateOnWrite } from "../lib/refCache.js";
import { deliveryInvalidateOnWrite } from "../lib/delivery/cache.js";
import { endStreamsBefore } from "../lib/sse.js";
import { addLegacyRef } from "./legacy.js";

/** Per-employee annual leave balance for the tracked leave types. */
export interface LeaveBalance {
  /** The calendar year this balance applies to (stale years are lazily reset). */
  year: number;
  annual: number;
  sick: number;
  personal: number;
}

/** Per-user email opt-outs. In-app notifications are always created. */
export interface EmailPreferences {
  /** New task or subtask assigned. */
  taskAssigned: boolean;
  /** Status changes, edits, approvals. */
  taskUpdates: boolean;
  /** Comments and @mentions. */
  taskComments: boolean;
  /** Due, overdue and recurring reminders. */
  taskReminders: boolean;
  /** Project membership, status, deadline, notes and files. */
  projectUpdates: boolean;
  /** Time log / timesheet approvals and tracker reminders. */
  timeLogs: boolean;
  /** Admins: someone accepted an invitation and joined. */
  teamUpdates: boolean;
  /** Document expiry and probation / notice / internship end reminders. */
  hrReminders: boolean;
  /** Admins / heads: a team member applied for leave. */
  leaveRequests: boolean;
}

export const EMAIL_PREFERENCE_KEYS = [
  "taskAssigned",
  "taskUpdates",
  "taskComments",
  "taskReminders",
  "projectUpdates",
  "timeLogs",
  "teamUpdates",
  "hrReminders",
  "leaveRequests",
] as const satisfies readonly (keyof EmailPreferences)[];

/**
 * Spread into every people query (lists, pickers, counts, reports, jobs):
 * outside guests are never part of the company's people.
 */
export const STAFF_FILTER = { isGuest: { $ne: true } } as const;

export interface IUser extends mongoose.Document {
  name: string;
  email: string;
  password: string;
  role: "admin" | "employee" | "head";
  /**
   * True for accounts created without a usable password (e.g. imported from
   * Worksuite): sign-in is refused until the user sets one through a
   * set-password link (POST /api/users/:id/password-link).
   */
  passwordSetupRequired: boolean;
  /** Set by an admin default password: the app asks for a new password at the next sign-in. */
  mustChangePassword: boolean;
  /**
   * Session generation: JWTs carry it as `tv` and requireAuth rejects older
   * ones. Bumped by every password change (own, admin-set, reset, set-password
   * link, default password) to sign out every other session.
   */
  tokenVersion: number;
  /** Single department per employee (null until assigned). */
  department?: mongoose.Types.ObjectId | null;
  leaveBalance?: LeaveBalance;
  emailPreferences: EmailPreferences;
  /** Default hourly rate (admin-editable); project membership rates take precedence. */
  hourlyRate: number;
  pinnedProjects: mongoose.Types.ObjectId[];
  pinnedTasks: mongoose.Types.ObjectId[];
  /** "YYYY-MM-DD" idempotency key for the time-tracker reminder job. */
  lastTrackerReminderOn?: string | null;
  // --- HR profile (admin-editable; date-only values stored as UTC midnight) ---
  designation?: string;
  /** Unique when set; auto "EMP-0001" sequence on create when left blank. */
  employeeId?: string;
  dateOfBirth?: Date | null;
  joiningDate?: Date | null;
  probationEndDate?: Date | null;
  internshipEndDate?: Date | null;
  noticePeriodStart?: Date | null;
  noticePeriodEnd?: Date | null;
  /** Idempotency keys of the daily HR reminder job (last 20 kept). */
  lastHrReminderKeys: string[];
  /**
   * Outside person invited to specific tasks (lib/guests.ts): signs in like
   * anyone else but can only reach the tasks they are on (middlewares/guestAccess.ts),
   * and is left out of every people list (STAFF_FILTER). Their role stays "employee".
   */
  isGuest: boolean;
  /** Guests: who first invited them. */
  guestInvitedBy?: mongoose.Types.ObjectId | null;
  /** Guests: set when an admin removed their access — sign-in and sessions are refused. */
  guestRevokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
    },
    password: { type: String, required: true, minlength: 8, select: false },
    role: { type: String, enum: ["admin", "employee", "head"], default: "employee" },
    passwordSetupRequired: { type: Boolean, default: false },
    mustChangePassword: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    leaveBalance: {
      type: {
        year: { type: Number, required: true },
        annual: { type: Number, required: true, min: 0 },
        sick: { type: Number, required: true, min: 0 },
        personal: { type: Number, required: true, min: 0 },
      },
      default: undefined,
    },
    emailPreferences: {
      taskAssigned: { type: Boolean, default: true },
      taskUpdates: { type: Boolean, default: true },
      taskComments: { type: Boolean, default: true },
      taskReminders: { type: Boolean, default: true },
      projectUpdates: { type: Boolean, default: true },
      timeLogs: { type: Boolean, default: true },
      teamUpdates: { type: Boolean, default: true },
      hrReminders: { type: Boolean, default: true },
      leaveRequests: { type: Boolean, default: true },
    },
    hourlyRate: { type: Number, default: 0, min: 0, max: 100000 },
    pinnedProjects: { type: [{ type: Schema.Types.ObjectId, ref: "Project" }], default: [] },
    pinnedTasks: { type: [{ type: Schema.Types.ObjectId, ref: "Task" }], default: [] },
    lastTrackerReminderOn: { type: String, default: null },
    designation: { type: String, trim: true, maxlength: 100, default: "" },
    // No default: users without an ID simply lack the field (partial unique index below).
    employeeId: { type: String, trim: true, maxlength: 30 },
    dateOfBirth: { type: Date, default: null },
    joiningDate: { type: Date, default: null },
    probationEndDate: { type: Date, default: null },
    internshipEndDate: { type: Date, default: null },
    noticePeriodStart: { type: Date, default: null },
    noticePeriodEnd: { type: Date, default: null },
    lastHrReminderKeys: { type: [String], default: [] },
    isGuest: { type: Boolean, default: false },
    guestInvitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    guestRevokedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Employee ID — unique once assigned (partial, so users without one don't collide).
userSchema.index(
  { employeeId: 1 },
  { unique: true, partialFilterExpression: { employeeId: { $type: "string" } }, name: "employeeId_unique" }
);
// HR reminder job: upcoming end dates.
userSchema.index({ probationEndDate: 1 });
userSchema.index({ noticePeriodEnd: 1 });
userSchema.index({ internshipEndDate: 1 });

// Every new user gets the next "EMP-xxxx" unless an ID was given (guests are not employees).
userSchema.pre("save", async function () {
  if (!this.isNew || this.employeeId || this.isGuest) return;
  this.employeeId = await nextEmployeeId();
});

// Hash the password with bcrypt (cost 10) whenever it changes — plain text is never stored
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// A tokenVersion bump (password change or reset) signs out older sessions:
// end their open real-time streams in this process now (other replicas end
// theirs on the next heartbeat check, lib/sse.ts).
userSchema.pre("save", function () {
  this.$locals.tokenVersionBumped = this.isModified("tokenVersion");
});
userSchema.post("save", function (doc) {
  if (doc.$locals.tokenVersionBumped) endStreamsBefore(String(doc._id), doc.tokenVersion ?? 0);
});

userSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

// Never leak the password hash or the internal version key in JSON responses
userSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.password;
    delete json.__v;
    delete json.lastTrackerReminderOn;
    delete json.lastHrReminderKeys;
    delete json.tokenVersion;
    return json;
  },
});

// requireAuth caches users briefly; any user write drops that cache.
invalidateOnWrite(userSchema, "user:");
// Departments decide Delivery Pulse teams; names show in its tables.
deliveryInvalidateOnWrite(userSchema);

// Imported documents (bun run import:worksuite) carry `legacy` for idempotent re-runs.
addLegacyRef(userSchema);

export const User = mongoose.model<IUser>("User", userSchema);
