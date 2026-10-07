import mongoose from "mongoose";
import { companySettings } from "../companySettings.js";
import type { DateFormat } from "../../models/CompanySettings.js";
import type { ImportType } from "../../models/ImportJob.js";
import { User } from "../../models/User.js";
import type { IUser } from "../../models/User.js";
import { cellText, type CellValue, type ParsedRow } from "./parse.js";

// ---------------------------------------------------------------------------
// Shared import context: options, the column mapping, and name/email → user
// resolution (emails exact & case-insensitive; names exact; an ambiguous name
// is an error, never a guess).
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /** Projects: what to do when the code already exists. */
  onExisting: "skip" | "update";
  /** Tasks: project id for rows without a project column/value. */
  defaultProject: string | null;
  /** Emails for assignment/member notifications (in-app ones are always created). */
  sendEmails: boolean;
  /** Import a row when at least one person resolves (unknown ones become warnings). */
  skipUnknownPeople: boolean;
}

export function parseOptions(raw: unknown): ImportOptions | string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (o.onExisting !== undefined && o.onExisting !== "skip" && o.onExisting !== "update") {
    return 'options.onExisting must be "skip" or "update"';
  }
  let defaultProject: string | null = null;
  if (o.defaultProject !== undefined && o.defaultProject !== null && o.defaultProject !== "") {
    if (typeof o.defaultProject !== "string" || !mongoose.isValidObjectId(o.defaultProject)) {
      return "options.defaultProject must be a project ID";
    }
    defaultProject = o.defaultProject;
  }
  for (const k of ["sendEmails", "skipUnknownPeople"]) {
    if (o[k] !== undefined && typeof o[k] !== "boolean") return `options.${k} must be a boolean`;
  }
  return {
    onExisting: o.onExisting === "update" ? "update" : "skip",
    defaultProject,
    sendEmails: o.sendEmails === true,
    skipUnknownPeople: o.skipUnknownPeople === true,
  };
}

export type LeanPerson = Pick<IUser, "name" | "email" | "role" | "department"> & { _id: mongoose.Types.ObjectId };

function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export class PeopleIndex {
  private byEmail = new Map<string, LeanPerson>();
  private byName = new Map<string, LeanPerson[]>();

  constructor(users: LeanPerson[]) {
    for (const u of users) {
      this.byEmail.set(u.email.toLowerCase(), u);
      const k = nameKey(u.name);
      this.byName.set(k, [...(this.byName.get(k) ?? []), u]);
    }
  }

  static async load(): Promise<PeopleIndex> {
    const users = await User.find().select("name email role department").lean<LeanPerson[]>();
    return new PeopleIndex(users);
  }

  /** Resolves each token; `problems` holds a reason per unresolved token. */
  resolve(tokens: string[]): { users: LeanPerson[]; problems: string[] } {
    const users: LeanPerson[] = [];
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      let user: LeanPerson | undefined;
      if (token.includes("@")) {
        user = this.byEmail.get(token.trim().toLowerCase());
        if (!user) problems.push(`No user with email "${token}"`);
      } else {
        const matches = this.byName.get(nameKey(token)) ?? [];
        if (matches.length === 1) user = matches[0];
        else if (matches.length > 1) problems.push(`${matches.length} users are named "${token}" — use their email`);
        else problems.push(`No user named "${token}"`);
      }
      if (user && !seen.has(user._id.toString())) {
        seen.add(user._id.toString());
        users.push(user);
      }
    }
    return { users, problems };
  }
}

/** Reads mapped cells of one row. */
export class RowReader {
  constructor(
    private readonly row: ParsedRow,
    private readonly columnOf: Map<string, number>
  ) {}

  mapped(field: string): boolean {
    return this.columnOf.has(field);
  }

  get(field: string): CellValue | undefined {
    const col = this.columnOf.get(field);
    return col === undefined ? undefined : (this.row.cells[col] ?? null);
  }

  text(field: string): string {
    return cellText(this.get(field) ?? null).trim();
  }

  /** Fields whose cell exceeded the character cap. */
  oversizeFields(): string[] {
    const out: string[] = [];
    for (const [field, col] of this.columnOf) if (this.row.oversize.includes(col)) out.push(field);
    return out;
  }
}

/** `{ "3": "title" }` → Map(field → column). Validates fields and duplicates. */
export function mappingColumns(
  mapping: unknown,
  fieldKeys: string[],
  columnCount: number
): Map<string, number> | string {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return 'mapping must be an object like { "0": "title" }';
  }
  const out = new Map<string, number>();
  for (const [col, field] of Object.entries(mapping as Record<string, unknown>)) {
    if (field === null || field === "" || field === undefined) continue;
    const index = Number(col);
    if (!Number.isInteger(index) || index < 0 || index >= columnCount) return `mapping has an unknown column "${col}"`;
    if (typeof field !== "string" || !fieldKeys.includes(field)) return `mapping has an unknown field "${String(field)}"`;
    if (out.has(field)) return `"${field}" is mapped to more than one column`;
    out.set(field, index);
  }
  return out;
}

export interface BaseContext {
  type: ImportType;
  actor: IUser;
  options: ImportOptions;
  dateFormat: DateFormat;
  people: PeopleIndex;
}

export async function baseContext(type: ImportType, actor: IUser, options: ImportOptions): Promise<BaseContext> {
  return { type, actor, options, dateFormat: companySettings().dateFormat, people: await PeopleIndex.load() };
}

/** Case-insensitive name → doc map. */
export function byLowerName<T extends { name: string }>(docs: T[]): Map<string, T> {
  return new Map(docs.map((d) => [d.name.trim().toLowerCase(), d]));
}

/** Validation outcome of one row; `plan` is what the run will do (absent on errors). */
export interface RowPlan<P> {
  row: number;
  status: "ready" | "warning" | "error";
  action: "create" | "update" | "skip" | null;
  messages: string[];
  plan?: P;
}

/** Collects messages for a row and derives its status. */
export class RowIssues {
  errors: string[] = [];
  warnings: string[] = [];
  notes: string[] = [];

  error(message: string): void {
    this.errors.push(message);
  }
  warn(message: string): void {
    this.warnings.push(message);
  }
  note(message: string): void {
    this.notes.push(message);
  }
  get failed(): boolean {
    return this.errors.length > 0;
  }
  result<P>(row: number, action: RowPlan<P>["action"], plan: P | undefined): RowPlan<P> {
    if (this.failed) return { row, status: "error", action: null, messages: [...this.errors, ...this.warnings] };
    return {
      row,
      status: this.warnings.length > 0 ? "warning" : "ready",
      action,
      messages: [...this.warnings, ...this.notes],
      plan,
    };
  }
}

/** Shared people check: errors unless "skip unknown people" (then warnings when ≥ minimum resolved). */
export function reportPeople(
  issues: RowIssues,
  label: string,
  resolved: { users: LeanPerson[]; problems: string[] },
  options: ImportOptions,
  minimum: number
): void {
  if (resolved.problems.length === 0) return;
  const ambiguous = resolved.problems.filter((p) => p.includes("users are named"));
  const unknown = resolved.problems.filter((p) => !p.includes("users are named"));
  for (const p of ambiguous) issues.error(`${label}: ${p}`);
  if (unknown.length === 0) return;
  if (options.skipUnknownPeople && resolved.users.length >= minimum) {
    for (const p of unknown) issues.warn(`${label}: ${p} (skipped)`);
  } else {
    for (const p of unknown) issues.error(`${label}: ${p}`);
  }
}
