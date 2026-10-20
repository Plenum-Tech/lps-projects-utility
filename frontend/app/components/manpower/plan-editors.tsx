import { useEffect, useState, type FormEvent } from "react";
import { LuTrash2 } from "react-icons/lu";

import { PersonPicker } from "@/components/brands/alloc-cell";
import type { MultiSelectOption } from "@/components/globals/multi-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { brandLineName, brandLineSuffix } from "@/lib/manpower";
import type { ManpowerSection } from "@/types";
import type { TableRow } from "./plan-table";

type Cell = TableRow["cells"][number];

export type CellValue = { users: string[]; placeholders: string[]; notNeeded: boolean; note: string };

/**
 * Edit one role on one line right in the cell (no pop-up): search and add people,
 * then optional "not needed", open slots and a note under the list. Every change
 * applies to the draft at once; Escape or clicking elsewhere closes it.
 */
export function InlineCellEditor({
  label,
  cell,
  people,
  onChange,
  onClose,
}: {
  label: string;
  cell: Cell | undefined;
  people: MultiSelectOption[];
  onChange: (cell: CellValue) => void;
  onClose: () => void;
}) {
  const users = cell?.users.map((u) => u._id) ?? [];
  const value: CellValue = { users, placeholders: cell?.placeholders ?? [], notNeeded: cell?.notNeeded ?? false, note: cell?.note ?? "" };
  const [slots, setSlots] = useState(value.placeholders.join(", "));
  const nameOf = (id: string) => people.find((p) => p.value === id)?.label ?? cell?.users.find((u) => u._id === id)?.name ?? "…";
  const parseSlots = (text: string) =>
    text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6);
  return (
    <PersonPicker
      label={label}
      people={users}
      nameOf={nameOf}
      options={[]}
      showBrands={false}
      className="block w-60 rounded-md border bg-card shadow-sm"
      onChange={(ids) => onChange({ ...value, users: ids, notNeeded: ids.length ? false : value.notNeeded })}
      onClose={onClose}
    >
      <div className="space-y-1 px-0.5 pt-0.5 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3.5 accent-primary"
            checked={value.notNeeded}
            onChange={(e) => onChange(e.target.checked ? { ...value, notNeeded: true, users: [], placeholders: [] } : { ...value, notNeeded: false })}
          />
          Not needed on this line
        </label>
        <input
          aria-label={`${label}: open slots`}
          value={slots}
          disabled={value.notNeeded}
          placeholder="Open slots: e.g. New PM, Freelancer"
          className="w-full rounded border bg-background px-1.5 py-0.5"
          onChange={(e) => {
            setSlots(e.target.value);
            onChange({ ...value, placeholders: parseSlots(e.target.value) });
          }}
        />
        <input
          aria-label={`${label}: note`}
          defaultValue={value.note}
          maxLength={300}
          placeholder="Note (optional)"
          className="w-full rounded border bg-background px-1.5 py-0.5"
          onChange={(e) => onChange({ ...value, note: e.target.value.slice(0, 300) })}
        />
      </div>
    </PersonPicker>
  );
}

/** Add or edit a line: name, brand, type, section; remove it. */
export function RowDialog({
  open,
  onOpenChange,
  row,
  section,
  brands,
  types,
  onSave,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present → edit; absent → add a line to `section`. */
  row?: TableRow;
  section: ManpowerSection;
  brands: Array<{ _id: string; name: string; color?: string; active?: boolean }>;
  types: string[];
  onSave: (row: { name: string; brand: string | null; type: string | null; section: ManpowerSection }) => void;
  onDelete?: () => void;
}) {
  const NONE = "__none";
  const [name, setName] = useState("");
  const [brand, setBrand] = useState(NONE);
  const [type, setType] = useState(NONE);
  const [sec, setSec] = useState<ManpowerSection>(section);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(row?.name ?? "");
    setBrand(row?.brand?._id ?? NONE);
    setType(row?.type ?? NONE);
    setSec(row?.section ?? section);
    setSubmitted(false);
  }, [open, row, section]);

  // A brand's line starts with the brand's name (fixed here); the rest tells its lines apart and is editable.
  const brandName = brand === NONE ? null : (brands.find((b) => b._id === brand)?.name ?? row?.brand?.name ?? null);
  const suffix = brandName ? brandLineSuffix(name, brandName) : "";
  const shownName = brandName ? (suffix.trim() ? brandLineName(`${brandName} ${suffix.trim()}`, brandName) : brandName) : name;
  const nameError = !shownName.trim() ? "A name is required." : shownName.trim().length > 120 ? "Max 120 characters." : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nameError) return;
    onSave({ name: shownName.trim(), brand: brand === NONE ? null : brand, type: type === NONE ? null : type, section: sec });
    onOpenChange(false);
  }

  const brandItems: Record<string, string> = { [NONE]: "No brand" };
  for (const b of brands) if (b.active !== false || b._id === row?.brand?._id) brandItems[b._id] = b.name;
  const typeItems: Record<string, string> = { [NONE]: "Any type" };
  for (const t of types) typeItems[t] = t;
  if (row?.type && !typeItems[row.type]) typeItems[row.type] = row.type;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{row ? "Edit line" : "Add line"}</DialogTitle>
          <DialogDescription>
            Brand, type, month and name link this line to the month&apos;s projects.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} noValidate className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="mp-row-name">Name</Label>
            {brandName ? (
              <div className="flex items-center gap-2">
                <span className="shrink-0 rounded-md border bg-muted/50 px-2.5 py-1.5 text-sm font-medium" title="The brand's name — rename the brand to change it">
                  {brandName}
                </span>
                <Input
                  id="mp-row-name"
                  value={suffix}
                  onChange={(e) => setName(e.target.value.trim() ? `${brandName} ${e.target.value}` : brandName)}
                  aria-describedby="mp-row-name-hint"
                  placeholder="optional, e.g. AA videos / GCC + Qatar"
                  aria-invalid={submitted && Boolean(nameError)}
                />
              </div>
            ) : (
              <Input
                id="mp-row-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. ENOC - Zoom TikTok"
                aria-invalid={submitted && Boolean(nameError)}
              />
            )}
            {brandName && (
              <p id="mp-row-name-hint" className="text-xs text-muted-foreground">
                Starts with the brand&apos;s name (rename the brand to change it). Add what tells this line apart, if the brand has several.
              </p>
            )}
            {submitted && nameError && <p className="text-sm text-destructive">{nameError}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="mp-row-brand">Brand</Label>
              <Select value={brand} onValueChange={(v) => setBrand(String(v ?? NONE))} items={brandItems}>
                <SelectTrigger id="mp-row-brand" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(brandItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mp-row-type">Type</Label>
              <Select value={type} onValueChange={(v) => setType(String(v ?? NONE))} items={typeItems}>
                <SelectTrigger id="mp-row-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(typeItems).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mp-row-section">Section</Label>
            <Select
              value={sec}
              onValueChange={(v) => setSec((v as ManpowerSection) ?? "active")}
              items={{ active: "Brands / projects", pitch: "Pitches / proactive projects" }}
            >
              <SelectTrigger id="mp-row-section" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Brands / projects</SelectItem>
                <SelectItem value="pitch">Pitches / proactive projects</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter className="sm:justify-between">
            {row && onDelete ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  onDelete();
                  onOpenChange(false);
                }}
              >
                <LuTrash2 aria-hidden />
                Remove line
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">{row ? "Apply" : "Add"}</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
