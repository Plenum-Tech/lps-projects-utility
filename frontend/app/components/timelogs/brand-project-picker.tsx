import { useState } from "react";
import { LuX } from "react-icons/lu";

import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import type { TimesheetBrandProject } from "@/types";

type Option = { value: string; label: string };

/** Key of a brand row: `<brandId>:<projectId>` (project empty = the brand as a whole). */
export const brandRowKey = (
  brand: string,
  project: string | null | undefined,
) => `${brand}:${project ?? ""}`;

export function splitBrandRowKey(key: string): {
  brand: string;
  project: string | null;
} {
  const [brand, project] = key.split(":");
  return { brand: brand ?? "", project: project || null };
}

/** "CODE · name" of a brand row's project. */
export function brandProjectLabel(
  project: TimesheetBrandProject | undefined,
): string {
  if (!project) return "Project";
  return project.code ? `${project.code} · ${project.name}` : project.name;
}

const WHOLE_BRAND = "";

/**
 * Add brand time in two steps: pick the brand, then one of its projects of the month (or the
 * brand as a whole). A brand with no projects that month is added as a whole at once.
 */
export function BrandProjectPicker({
  brands,
  projects,
  used,
  loading,
  onAdd,
}: {
  brands: Option[];
  projects: TimesheetBrandProject[];
  /** Brand row keys already on the sheet. */
  used: Set<string>;
  loading?: boolean;
  onAdd: (brand: string, project: string | null) => void;
}) {
  const [brand, setBrand] = useState<Option | null>(null);

  function pickBrand(option: Option | null) {
    if (!option) return;
    if (!projects.some((p) => p.brand === option.value)) {
      onAdd(option.value, null);
      return;
    }
    setBrand(option);
  }

  if (brand) {
    const options: Option[] = [
      { value: WHOLE_BRAND, label: "Brand as a whole (no project)" },
      ...projects
        .filter((p) => p.brand === brand.value)
        .map((p) => ({ value: p._id, label: brandProjectLabel(p) })),
    ].filter((o) => !used.has(brandRowKey(brand.value, o.value || null)));
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="max-w-56 truncate text-sm font-medium"
          title={brand.label}
        >
          {brand.label}
        </span>
        <Combobox
          items={options}
          value={null}
          onValueChange={(option: Option | null) => {
            if (!option) return;
            onAdd(brand.value, option.value || null);
            setBrand(null);
          }}
          isItemEqualToValue={(x: Option, y: Option) => x.value === y.value}
        >
          <ComboboxInput
            className="w-80"
            placeholder="Pick the project — search…"
            aria-label={`Project of ${brand.label}`}
            autoFocus
          />
          <ComboboxContent>
            <ComboboxEmpty>No projects left for this brand.</ComboboxEmpty>
            <ComboboxList>
              {(option: Option) => (
                <ComboboxItem key={option.value || "whole"} value={option}>
                  {option.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Pick another brand"
          onClick={() => setBrand(null)}
        >
          <LuX aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <Combobox
      items={brands}
      value={null}
      onValueChange={pickBrand}
      isItemEqualToValue={(x: Option, y: Option) => x.value === y.value}
    >
      <ComboboxInput
        className="w-72"
        placeholder={
          loading ? "Loading brands…" : "Add brand time — search brands…"
        }
        aria-label="Add a brand row"
      />
      <ComboboxContent>
        <ComboboxEmpty>No brands found.</ComboboxEmpty>
        <ComboboxList>
          {(option: Option) => (
            <ComboboxItem key={option.value} value={option}>
              {option.label}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
