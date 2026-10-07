// ---------------------------------------------------------------------------
// Import report: counts per entity plus skipped rows (legacy ids + reason only).
// Never holds names, emails, passwords or other personal data.
// ---------------------------------------------------------------------------

export interface EntityCounts {
  /** Rows in scope in the dump (company, not soft-deleted unless counted as skipped). */
  source: number;
  created: number;
  updated: number;
  /** Matched to an existing document that wasn't created by this import (e.g. by name/email). */
  matched: number;
  skipped: number;
}

export class ImportReport {
  readonly entities: Record<string, EntityCounts> = {};
  /** entity → reason → legacy ids. */
  readonly skipped: Record<string, Record<string, number[]>> = {};
  /** Informational lists (legacy ids) and counters. */
  readonly notes: Record<string, number[] | number> = {};
  readonly suggestions: string[] = [];
  readonly errors: string[] = [];

  entity(name: string): EntityCounts {
    return (this.entities[name] ??= { source: 0, created: 0, updated: 0, matched: 0, skipped: 0 });
  }

  source(name: string, n: number): void {
    this.entity(name).source += n;
  }

  skip(name: string, reason: string, legacyId: number): void {
    this.entity(name).skipped++;
    const byReason = (this.skipped[name] ??= {});
    (byReason[reason] ??= []).push(legacyId);
  }

  /** Adds `id` to an informational list. */
  note(key: string, id: number): void {
    const list = this.notes[key];
    if (Array.isArray(list)) list.push(id);
    else this.notes[key] = [id];
  }

  /** Increments an informational counter. */
  count(key: string, by = 1): void {
    const value = this.notes[key];
    this.notes[key] = (typeof value === "number" ? value : 0) + by;
  }

  /** Compact one-line-per-entity summary for the console (counts only). */
  summaryLines(): string[] {
    return Object.entries(this.entities).map(([name, c]) => {
      const reasons = Object.entries(this.skipped[name] ?? {})
        .map(([reason, ids]) => `${reason}=${ids.length}`)
        .join(", ");
      return `${name.padEnd(18)} source=${c.source} created=${c.created} updated=${c.updated} matched=${c.matched} skipped=${c.skipped}${reasons ? ` (${reasons})` : ""}`;
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      entities: this.entities,
      skipped: this.skipped,
      notes: this.notes,
      suggestions: this.suggestions,
      errors: this.errors,
    };
  }
}
