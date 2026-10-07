import { createReadStream } from "node:fs";

// ---------------------------------------------------------------------------
// Streaming reader for a MariaDB/MySQL dump (mysqldump / phpMyAdmin format):
//   CREATE TABLE `t` ( `col` type, ... );
//   INSERT INTO `t` (`a`, `b`) VALUES        <- column list optional
//   (1, 'x'),
//   (2, NULL);
// Only the requested tables are parsed, and only the requested columns are
// kept, so password hashes / tokens in other columns never reach memory as
// row values. INSERTs for every other table are skipped without parsing.
// ---------------------------------------------------------------------------

export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

/** Tables that must never be parsed (credentials, sessions, tokens). */
export const SENSITIVE_TABLES = new Set([
  "smtp_settings",
  "payment_gateway_credentials",
  "stripe_setting",
  "sessions",
  "password_resets",
  "user_auths",
  "social_auth_settings",
  "slack_settings",
  "pusher_settings",
  "quick_books_settings",
]);

/** Columns that are never kept, whatever the caller asks for. */
const FORBIDDEN_COLUMNS = new Set(["password", "remember_token", "two_factor_secret", "two_factor_recovery_codes"]);

/**
 * Parses the tuples in `text` (`(…),(…);`). Handles quoted strings with
 * backslash escapes and doubled quotes, NULL and numbers. Unquoted non-numeric
 * tokens (e.g. hex literals) are kept as raw strings.
 */
export function parseTuples(text: string): SqlValue[][] {
  const out: SqlValue[][] = [];
  const s = text;
  let i = 0;
  const n = s.length;
  while (i < n) {
    while (i < n && s[i] !== "(") i++;
    if (i >= n) break;
    i++;
    const row: SqlValue[] = [];
    for (;;) {
      while (i < n && (s[i] === " " || s[i] === "\n" || s[i] === "\r" || s[i] === "\t")) i++;
      if (s[i] === "'") {
        i++;
        let v = "";
        let start = i;
        while (i < n) {
          const c = s.charCodeAt(i);
          if (c === 92 /* \ */) {
            v += s.slice(start, i);
            const e = s[i + 1];
            v +=
              e === "n" ? "\n" : e === "r" ? "\r" : e === "t" ? "\t" : e === "0" ? "\0" : e === "Z" ? "\x1a" : e === "b" ? "\b" : (e ?? "");
            i += 2;
            start = i;
            continue;
          }
          if (c === 39 /* ' */) {
            if (s[i + 1] === "'") {
              v += s.slice(start, i) + "'";
              i += 2;
              start = i;
              continue;
            }
            v += s.slice(start, i);
            i++;
            break;
          }
          i++;
        }
        row.push(v);
      } else {
        let j = i;
        while (j < n && s[j] !== "," && s[j] !== ")") j++;
        const raw = s.slice(i, j).trim();
        if (raw === "NULL") row.push(null);
        else if (raw !== "" && !Number.isNaN(Number(raw))) row.push(Number(raw));
        else row.push(raw);
        i = j;
      }
      while (i < n && s[i] === " ") i++;
      if (s[i] === ",") {
        i++;
        continue;
      }
      if (s[i] === ")") {
        i++;
        break;
      }
      break;
    }
    out.push(row);
  }
  return out;
}

export interface TableSpec {
  /** Columns to keep (others are dropped right after parsing). */
  columns: readonly string[];
  /** Optional row filter applied while streaming (e.g. company_id = 18). */
  where?: (row: SqlRow) => boolean;
}

export interface DumpData {
  tables: Map<string, SqlRow[]>;
  /** Column names per parsed table (from CREATE TABLE). */
  schemas: Map<string, string[]>;
  /** Raw tuple counts per requested table (before `where`). */
  rawCounts: Map<string, number>;
}

/** Streams `file` once and returns the requested tables (missing tables come back empty). */
export async function readDump(file: string, specs: Record<string, TableSpec>): Promise<DumpData> {
  for (const name of Object.keys(specs)) {
    if (SENSITIVE_TABLES.has(name)) throw new Error(`Refusing to read sensitive table ${name}`);
    for (const col of specs[name]!.columns) {
      if (FORBIDDEN_COLUMNS.has(col)) throw new Error(`Refusing to read column ${name}.${col}`);
    }
  }

  const schemas = new Map<string, string[]>();
  const tables = new Map<string, SqlRow[]>();
  const rawCounts = new Map<string, number>();
  for (const name of Object.keys(specs)) {
    tables.set(name, []);
    rawCounts.set(name, 0);
  }

  let createName: string | null = null;
  let createCols: string[] = [];
  /** Table of the INSERT being read; null = none, "" = skipping. */
  let active: string | null = null;
  let activeIdx: number[] = [];
  let activeCols: readonly string[] = [];

  const consume = (text: string) => {
    if (!active) return;
    const spec = specs[active]!;
    const out = tables.get(active)!;
    for (const tuple of parseTuples(text)) {
      rawCounts.set(active, rawCounts.get(active)! + 1);
      const row: SqlRow = {};
      for (let k = 0; k < activeCols.length; k++) {
        const idx = activeIdx[k]!;
        row[activeCols[k]!] = idx >= 0 ? (tuple[idx] ?? null) : null;
      }
      if (!spec.where || spec.where(row)) out.push(row);
    }
  };

  const handleLine = (line: string) => {
    if (createName !== null) {
      const col = /^\s+`([^`]+)`\s/.exec(line);
      if (col) createCols.push(col[1]!);
      else if (line.startsWith(")")) {
        schemas.set(createName, createCols);
        createName = null;
      }
      return;
    }
    if (active !== null) {
      if (active) consume(line);
      if (line.trimEnd().endsWith(";")) active = null;
      return;
    }
    if (line.startsWith("CREATE TABLE")) {
      const ct = /^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)`/.exec(line);
      if (ct) {
        createName = ct[1]!;
        createCols = [];
      }
      return;
    }
    if (line.startsWith("INSERT INTO")) {
      const ins = /^INSERT INTO `([^`]+)`\s*(\(([^)]*)\))?\s*VALUES/.exec(line);
      if (!ins) return;
      const name = ins[1]!;
      if (!(name in specs)) {
        active = "";
      } else {
        const cols = ins[3] ? ins[3].split(",").map((c) => c.trim().replace(/`/g, "")) : schemas.get(name);
        if (!cols) throw new Error(`No column list for table ${name}`);
        active = name;
        activeCols = specs[name]!.columns;
        activeIdx = activeCols.map((c) => cols.indexOf(c));
        const rest = line.slice(ins[0].length);
        if (rest.trim()) consume(rest);
      }
      if (line.trimEnd().endsWith(";")) active = null;
    }
  };

  const decoder = new TextDecoder();
  let buf = "";
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buf += decoder.decode(chunk, { stream: true });
    let start = 0;
    let nl: number;
    while ((nl = buf.indexOf("\n", start)) >= 0) {
      handleLine(buf.slice(start, nl).replace(/\r$/, ""));
      start = nl + 1;
    }
    buf = buf.slice(start);
  }
  buf += decoder.decode();
  if (buf) handleLine(buf);

  return { tables, schemas, rawCounts };
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

export function str(v: SqlValue | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

export function num(v: SqlValue | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** DATETIME / TIMESTAMP "YYYY-MM-DD HH:MM:SS" interpreted as UTC. Zero dates → null. */
export function utcDateTime(v: SqlValue | undefined): Date | null {
  const s = str(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/.exec(s);
  if (!m || m[1] === "0000") return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** DATE (or the date part of a DATETIME) as UTC midnight — the app's date-only convention. */
export function dateOnly(v: SqlValue | undefined): Date | null {
  const s = str(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m || m[1] === "0000" || m[2] === "00" || m[3] === "00") return null;
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  return Number.isNaN(d.getTime()) ? null : d;
}
