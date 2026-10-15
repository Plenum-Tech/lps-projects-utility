import { LuChevronDown, LuPlus, LuX } from "react-icons/lu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/projects/project-fields";
import { SCOPE_LANGUAGES, SCOPE_UNITS, scopeTotal, scopeTotals } from "@/lib/scope";
import type { ScopeItem } from "@/types";

const UNIT_OPTIONS = SCOPE_UNITS.map((u) => ({ value: u, label: u }));

/** Scope as structured rows: unit × quantity × languages × sizes, with totals. */
export function ScopeItemsEditor({
  value,
  onChange,
  invalid,
  disabled,
}: {
  value: ScopeItem[];
  onChange: (rows: ScopeItem[]) => void;
  invalid?: boolean;
  disabled?: boolean;
}) {
  const set = (index: number, patch: Partial<ScopeItem>) => onChange(value.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const num = (raw: string, max: number) => Math.min(max, Math.max(1, Math.round(Number(raw) || 1)));
  const totals = scopeTotals(value);
  const grand = totals.reduce((n, t) => n + t.total, 0);

  return (
    <div className="space-y-3">
      {value.length > 0 && (
        <div className="hidden grid-cols-[minmax(0,1.4fr)_4.5rem_1rem_4.5rem_1rem_4.5rem_1rem_3.5rem_2rem] gap-2 text-xs text-muted-foreground sm:grid">
          <span>Unit</span>
          <span>Qty</span>
          <span />
          <span>Languages</span>
          <span />
          <span>Sizes</span>
          <span />
          <span className="text-right">Total</span>
          <span />
        </div>
      )}
      {value.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-[minmax(0,1fr)_4rem_1rem_4rem_1rem_4rem_1rem_3rem_2rem] items-center gap-2 text-sm sm:grid-cols-[minmax(0,1.4fr)_4.5rem_1rem_4.5rem_1rem_4.5rem_1rem_3.5rem_2rem]"
        >
          <OptionSelect
            value={row.unit}
            onChange={(unit) => set(index, { unit })}
            options={UNIT_OPTIONS}
            disabled={disabled}
            aria-label={`Row ${index + 1} unit`}
          />
          <Input
            type="number"
            min={1}
            max={999}
            value={row.quantity}
            onChange={(e) => set(index, { quantity: num(e.target.value, 999) })}
            aria-label={`Row ${index + 1} quantity`}
            disabled={disabled}
          />
          <span className="text-center text-muted-foreground">×</span>
          <LanguagePicker
            value={row.languageList ?? []}
            count={row.languages}
            disabled={disabled}
            label={`Row ${index + 1} languages`}
            onChange={(list) =>
              set(index, list.length ? { languageList: list, languages: list.length } : { languageList: undefined, languages: 1 })
            }
          />
          <span className="text-center text-muted-foreground">×</span>
          <Input
            type="number"
            min={1}
            max={20}
            value={row.sizes}
            onChange={(e) => set(index, { sizes: num(e.target.value, 20) })}
            aria-label={`Row ${index + 1} sizes`}
            disabled={disabled}
          />
          <span className="text-center text-muted-foreground">=</span>
          <span className="text-right font-semibold tabular-nums">{scopeTotal(row)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            aria-label={`Remove row ${index + 1}`}
            disabled={disabled}
          >
            <LuX aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...value, { unit: "Video", quantity: 1, languages: 1, sizes: 1 }])}
        disabled={disabled}
      >
        <LuPlus aria-hidden />
        Add row
      </Button>
      <div className={invalid ? "rounded-lg border border-destructive/50 bg-destructive/5 p-3" : "rounded-lg bg-muted/40 p-3"}>
        {value.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add at least one scope row (e.g. 3 videos × 2 languages × 2 sizes).</p>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span>
              <span className="text-xs text-muted-foreground">Total deliverables </span>
              <span className="text-lg font-semibold tabular-nums">{grand}</span>
            </span>
            <span className="text-muted-foreground">{totals.map((t) => `${t.total} ${t.unit}`).join(" · ")}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick the row's languages; the multiplier is how many are picked. */
function LanguagePicker({
  value,
  count,
  onChange,
  disabled,
  label,
}: {
  value: string[];
  count: number;
  onChange: (list: string[]) => void;
  disabled?: boolean;
  label: string;
}) {
  const toggle = (lang: string) => onChange(value.includes(lang) ? value.filter((l) => l !== lang) : [...value, lang]);
  const text = value.length === 0 ? `${count}` : value.length <= 2 ? value.map((l) => l.slice(0, 2).toUpperCase()).join(" + ") : `${value.length}`;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" className="w-full justify-between px-2 font-normal" disabled={disabled} aria-label={label} />
        }
      >
        <span className="truncate tabular-nums">{text}</span>
        <LuChevronDown aria-hidden className="size-3.5 opacity-60" />
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <p className="px-1 pb-1 text-xs text-muted-foreground">Languages for this row</p>
        <ul className="space-y-0.5">
          {SCOPE_LANGUAGES.map((lang) => (
            <li key={lang}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                <input type="checkbox" checked={value.includes(lang)} onChange={() => toggle(lang)} className="size-4 accent-primary" />
                {lang}
              </label>
            </li>
          ))}
        </ul>
        <p className="px-1 pt-1 text-xs text-muted-foreground">
          {value.length ? `× ${value.length}: ${value.join(", ")}` : "None picked: counts as 1 language."}
        </p>
      </PopoverContent>
    </Popover>
  );
}
