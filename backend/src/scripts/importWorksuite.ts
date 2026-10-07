import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { connectDB, disconnectDB } from "../db/index.js";
import { runWorksuiteImport } from "../lib/worksuite/importer.js";

/**
 * Worksuite → Projects Utility import (see prompts/worksuite-migration.md).
 *
 *   bun run import:worksuite -- --sql <dump.sql> --backup <backup.tar.gz> --company 18 [--dry-run] [--skip-files] [--report-dir <dir>] --confirm
 *
 * - Refuses to run without --confirm; prints the target database first.
 * - --dry-run parses and validates everything and only writes the report.
 * - Idempotent: documents carry legacy {source:"worksuite", table, id}; re-runs update them.
 * - Sends no emails/notifications; records a single `import_completed` activity.
 * - The report (counts + skipped legacy ids, no personal data) is written to
 *   <report-dir>/import-report-<timestamp>.json.
 */

interface Args {
  sql?: string;
  backup?: string;
  company: number;
  dryRun: boolean;
  skipFiles: boolean;
  confirm: boolean;
  reportDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { company: 18, dryRun: false, skipFiles: false, confirm: false, reportDir: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--sql":
        args.sql = value();
        break;
      case "--backup":
        args.backup = value();
        break;
      case "--company":
        args.company = Number(value());
        break;
      case "--report-dir":
        args.reportDir = value();
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--skip-files":
        args.skipFiles = true;
        break;
      case "--confirm":
        args.confirm = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  return args;
}

const USAGE =
  "Usage: bun run import:worksuite -- --sql <dump.sql> [--backup <backup.tar.gz>] [--company 18] [--dry-run] [--skip-files] [--report-dir <dir>] --confirm";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sql || !Number.isInteger(args.company) || args.company <= 0) {
    console.error(USAGE);
    return 2;
  }
  if (!existsSync(args.sql)) {
    console.error(`SQL dump not found: ${args.sql}`);
    return 2;
  }
  if (args.backup && !existsSync(args.backup)) {
    console.error(`Backup not found: ${args.backup}`);
    return 2;
  }
  if (!args.backup && !args.skipFiles) {
    console.error("Pass --backup <file> or --skip-files");
    return 2;
  }

  await connectDB();
  const conn = mongoose.connection;
  console.log(`Target database: "${conn.name}" on ${conn.host}:${conn.port}${args.dryRun ? " (DRY RUN — nothing is written)" : ""}`);
  if (!args.confirm) {
    console.error("Refusing to run without --confirm. Check the target above, then re-run with --confirm.");
    return 2;
  }
  // Make sure the indexes (incl. the new legacy_ref ones) exist before writing.
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));

  const startedAt = new Date();
  const report = await runWorksuiteImport({
    sqlPath: args.sql,
    backupPath: args.backup ?? null,
    company: args.company,
    dryRun: args.dryRun,
    skipFiles: args.skipFiles,
    log: (line) => console.log(`[import] ${line}`),
  });
  const finishedAt = new Date();

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  await mkdir(args.reportDir, { recursive: true });
  const reportPath = path.join(args.reportDir, `import-report-${stamp}${args.dryRun ? "-dry-run" : ""}.json`);
  const json = {
    startedAt,
    finishedAt,
    durationSec: Math.round((finishedAt.getTime() - startedAt.getTime()) / 100) / 10,
    dryRun: args.dryRun,
    target: { db: conn.name, host: `${conn.host}:${conn.port}` },
    company: args.company,
    sources: { sql: path.basename(args.sql), backup: args.backup ? path.basename(args.backup) : null, skipFiles: args.skipFiles },
    dump: (report as unknown as { dump?: Record<string, number> }).dump ?? {},
    ...report.toJSON(),
  };
  await writeFile(reportPath, JSON.stringify(json, null, 2));

  console.log("");
  for (const line of report.summaryLines()) console.log(line);
  for (const suggestion of report.suggestions) console.log(`Suggestion: ${suggestion}`);
  console.log(`\nReport: ${reportPath}`);
  console.log(`Done in ${json.durationSec}s${args.dryRun ? " (dry run)" : ""}`);
  return 0;
}

main()
  .then(async (code) => {
    await disconnectDB().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (error) => {
    // Redact values a driver error may echo back (duplicate keys, emails) — the log stays PII-free.
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/dup key: \{.*?\}/g, "dup key: {…}")
      .replace(/\S+@\S+\.\S+/g, "<redacted>");
    console.error("❌ Import failed:", message);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
  });
