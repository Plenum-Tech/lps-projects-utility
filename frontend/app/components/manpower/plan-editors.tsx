import { useEffect, useState, type FormEvent } from "react";
import { LuTrash2 } from "react-icons/lu";

import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ManpowerSection } from "@/types";
import type { TableRow } from "./plan-table";

type Cell = TableRow["cells"][number];

/** Edit one role on one line: people, open slots, "not needed", note. */
export function CellDialog({
  open,
  onOpenChange,
  rowName,
  roleLabel,
  cell,
  people,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rowName: string;
  roleLabel: string;
  cell: Cell | undefined;
  people: MultiSelectOption[];
  onSave: (cell: { users: string[]; placeholders: string[]; notNeeded: boolean; note: string }) => void;
}) {
  const [users, setUsers] = useState<string[]>([]);
  const [slots, setSlots] = useState("");
  const [notNeeded, setNotNeeded] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) return;
    setUsers(cell?.users.map((u) => u._id) ?? []);
    setSlots(cell?.placeholders.join(", ") ?? "");
    setNotNeeded(cell?.notNeeded ?? false);
    setNote(cell?.note ?? "");
  }, [open, cell]);

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave({
      users: notNeeded ? [] : users,
      placeholders: notNeeded
        ? []
        : slots
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
            .slice(0, 6),
      notNeeded,
      note: note.trim().slice(0, 300),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{roleLabel}</DialogTitle>
          <DialogDescription>{rowName}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox checked={notNeeded} onCheckedChange={(checked) => setNotNeeded(checked === true)} />
            Not needed on this line
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="mp-cell-people">People</Label>
            <MultiSelect
              id="mp-cell-people"
              options={people}
              value={users}
              onValueChange={setUsers}
              disabled={notNeeded}
              placeholder="Search people…"
              max={20}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mp-cell-slots">Open slots</Label>
            <Input
              id="mp-cell-slots"
              value={slots}
              onChange={(e) => setSlots(e.target.value)}
              disabled={notNeeded}
              placeholder="e.g. New PM, Freelancer"
              aria-describedby="mp-cell-slots-hint"
            />
            <p id="mp-cell-slots-hint" className="text-xs text-muted-foreground">
              Comma-separated. Use this for roles still to be hired or filled by someone outside the app.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mp-cell-note">Note</Label>
            <Input id="mp-cell-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Optional" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

  const nameError = !name.trim() ? "A name is required." : name.trim().length > 120 ? "Max 120 characters." : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (nameError) return;
    onSave({ name: name.trim(), brand: brand === NONE ? null : brand, type: type === NONE ? null : type, section: sec });
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
            <Input
              id="mp-row-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. ENOC - Zoom TikTok"
              aria-invalid={submitted && Boolean(nameError)}
            />
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
