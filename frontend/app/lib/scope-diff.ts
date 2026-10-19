import type { DiffRow, ScopeDiff, ScopeDiffSide } from "@/types";

// ---------------------------------------------------------------------------
// A scope against the previous one (same rules as the server's diffScope in
// backend/src/lib/scopeMatch.ts): rows added, removed, and the same deliverable
// with other counts. Used to show what a scope edit / upload will change.
// ---------------------------------------------------------------------------

const STOP = new Set("a an the and or of for to in on with x by per each all total pcs pieces piece items item".split(" "));

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))
    .map((w) => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return A.size + B.size - both === 0 ? 1 : both / (A.size + B.size - both);
}

const langs = (r: DiffRow) => (r.languageList?.length ? [...r.languageList].sort().join(", ") : String(r.languages ?? 1));
const unitKey = (r: DiffRow) => r.unit.trim().toLowerCase();
const side = (r: DiffRow): ScopeDiffSide => ({ quantity: r.quantity, languages: langs(r), sizes: r.sizes ?? 1 });
const nameKey = (r: DiffRow) => `${unitKey(r)}|${words(r.what ?? "").join(" ")}`;
const same = (a: ScopeDiffSide, b: ScopeDiffSide) => a.quantity === b.quantity && a.languages === b.languages && a.sizes === b.sizes;

export function diffScope(previous: DiffRow[], next: DiffRow[]): ScopeDiff {
  const out: ScopeDiff = { added: [], removed: [], changed: [], same: 0 };
  const prevLeft = [...previous];
  const nextLeft: DiffRow[] = [];
  for (const r of next) {
    let at = prevLeft.findIndex((p) => nameKey(p) === nameKey(r) && same(side(p), side(r)));
    if (at < 0) at = prevLeft.findIndex((p) => nameKey(p) === nameKey(r));
    if (at < 0) {
      nextLeft.push(r);
      continue;
    }
    const p = prevLeft.splice(at, 1)[0]!;
    if (same(side(p), side(r))) out.same++;
    else out.changed.push({ unit: r.unit, what: (r.what ?? "").trim(), from: side(p), to: side(r) });
  }
  for (const r of nextLeft) {
    let best = -1;
    let bestScore = 0;
    prevLeft.forEach((p, i) => {
      if (unitKey(p) !== unitKey(r)) return;
      const wa = words(p.what ?? "");
      const wb = words(r.what ?? "");
      const s = !wa.length || !wb.length ? 0.6 : jaccard(wa, wb);
      if (s >= 0.5 && s > bestScore) {
        best = i;
        bestScore = s;
      }
    });
    if (best < 0) {
      out.added.push(r);
      continue;
    }
    const p = prevLeft.splice(best, 1)[0]!;
    const renamed = (p.what ?? "").trim() !== (r.what ?? "").trim();
    if (!renamed && same(side(p), side(r))) out.same++;
    else out.changed.push({ unit: r.unit, what: (r.what ?? "").trim(), ...(renamed ? { fromWhat: (p.what ?? "").trim() } : {}), from: side(p), to: side(r) });
  }
  out.removed = prevLeft;
  return out;
}

export const diffIsEmpty = (d: ScopeDiff) => !d.added.length && !d.removed.length && !d.changed.length;
