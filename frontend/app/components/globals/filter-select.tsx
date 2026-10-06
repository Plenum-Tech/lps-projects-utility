import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const ANY = "all";

/**
 * Compact "Label: Value" filter select. `""` means "any". Used by the task
 * toolbar, projects, time logs and the work reports.
 */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  /** Text for the "any" option (defaults to "Any <label>"). */
  anyLabel?: string;
  className?: string;
}) {
  const items: Record<string, string> = { [ANY]: `${label}: Any` };
  for (const option of options) items[option.value] = `${label}: ${option.label}`;
  const current = value === "" || value === "all" ? ANY : value;

  return (
    <Select
      value={current}
      onValueChange={(next) => onChange(!next || next === ANY ? "" : String(next))}
      items={items}
    >
      <SelectTrigger
        size="sm"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className={[current !== ANY ? "border-ring/60 bg-primary/5" : "", className ?? ""]
          .join(" ")
          .trim()}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{anyLabel ?? `Any ${label.toLowerCase()}`}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
