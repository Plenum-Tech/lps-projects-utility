import { useEffect, useMemo, useState, type ReactNode } from "react";
import { LuRotateCcw } from "react-icons/lu";

import { BrandDot } from "@/components/delivery/brand-dot";
import { WEEKDAYS } from "@/components/delivery/delivery-format";
import { TagsInput } from "@/components/delivery/settings/tags-input";
import { ManageLink } from "@/components/globals/manage-link";
import { MultiSelect, type MultiSelectOption } from "@/components/globals/multi-select";
import { QueryError } from "@/components/globals/query-states";
import { FieldMessage, SettingsFormCard, SettingsFormSkeleton } from "@/components/settings/settings-form-card";
import { errorField, errorMessage } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { useBrands } from "@/hooks/use-brands";
import { useDeliverySettings, useUpdateDeliverySettings } from "@/hooks/use-delivery";
import { useDepartments } from "@/hooks/use-departments";
import { useTaskCategories } from "@/hooks/use-task-meta";
import { useUsers } from "@/hooks/use-users";
import type { DeliverySettings, DeliverySettingsInput } from "@/types";

type Draft = Omit<DeliverySettings, "updatedAt" | "dashboardTeams" | "minLeadDays" | "briefMinLength" | "minCompletedToRank" | "staleDays" | "brandTeamMap"> & {
  dashboardTeams: string[];
  minLeadDays: string;
  briefMinLength: string;
  minCompletedToRank: string;
  staleDays: string;
  /** brand id → user ids (only brands with people are sent). */
  brandTeamMap: Record<string, string[]>;
};

const NUMBER_FIELDS = {
  minLeadDays: { min: 0, max: 60 },
  briefMinLength: { min: 0, max: 2000 },
  minCompletedToRank: { min: 0, max: 1000 },
  staleDays: { min: 1, max: 3650 },
} as const;
type NumberField = keyof typeof NUMBER_FIELDS;

function toDraft(settings: DeliverySettings): Draft {
  const map: Record<string, string[]> = {};
  for (const entry of settings.brandTeamMap) if (entry.users.length) map[entry.brand] = [...entry.users];
  return {
    trafficManagers: settings.trafficManagers,
    dashboardTeams: settings.dashboardTeams ?? [],
    reworkKeywords: settings.reworkKeywords,
    reworkCategories: settings.reworkCategories,
    briefingWeekday: settings.briefingWeekday,
    minLeadDays: String(settings.minLeadDays),
    sameDayBrands: settings.sameDayBrands,
    finalAssetDomains: settings.finalAssetDomains,
    briefMinLength: String(settings.briefMinLength),
    minCompletedToRank: String(settings.minCompletedToRank),
    staleDays: String(settings.staleDays),
    brandTeamMap: map,
    teamMapStartDate: settings.teamMapStartDate,
  };
}

/** Order-insensitive comparison key: string arrays sorted, object keys sorted, empty map entries dropped. */
const norm = (value: unknown) =>
  JSON.stringify(value, (_key, inner) => {
    if (Array.isArray(inner)) return inner.every((item) => typeof item === "string") ? [...inner].sort() : inner;
    if (inner && typeof inner === "object") {
      return Object.fromEntries(
        Object.entries(inner as Record<string, unknown>)
          .filter(([, item]) => !(Array.isArray(item) && item.length === 0))
          .sort(([a], [b]) => a.localeCompare(b))
      );
    }
    return inner;
  });

function numberError(field: NumberField, text: string): string | null {
  const { min, max } = NUMBER_FIELDS[field];
  const value = Number(text);
  if (text.trim() === "" || !Number.isInteger(value)) return "Enter a whole number.";
  if (value < min || value > max) return `Between ${min} and ${max}.`;
  return null;
}

/** Settings → Delivery (admin): roles, rule thresholds and brand team maps for Delivery Pulse. */
export function DeliverySettingsSection() {
  const query = useDeliverySettings();
  const update = useUpdateDeliverySettings();
  const users = useUsers();
  const departments = useDepartments();
  const categories = useTaskCategories();
  const brands = useBrands();

  const source = useMemo(() => (query.data ? toDraft(query.data.settings) : undefined), [query.data]);
  const [draft, setDraft] = useState<Draft | undefined>(source);
  useEffect(() => setDraft(source), [source]);

  const userOptions = useMemo<MultiSelectOption[]>(
    () => (users.data?.users ?? []).map((user) => ({ value: user._id, label: user.name, description: user.email })),
    [users.data]
  );
  const departmentOptions = useMemo<MultiSelectOption[]>(
    () => (departments.data?.departments ?? []).map((department) => ({ value: department._id, label: department.name })),
    [departments.data]
  );
  const categoryOptions = useMemo<MultiSelectOption[]>(
    () => (categories.data ?? []).map((category) => ({ value: category._id, label: category.name })),
    [categories.data]
  );
  const brandOptions = useMemo<MultiSelectOption[]>(
    () =>
      (brands.data ?? []).map((brand) => ({
        value: brand._id,
        label: brand.active ? brand.name : `${brand.name} (inactive)`,
        icon: <BrandDot color={brand.color} />,
      })),
    [brands.data]
  );

  if (query.isPending) return <SettingsFormSkeleton rows={8} />;
  if (query.isError || !draft || !source || !query.data) {
    return (
      <QueryError
        title="Couldn't load delivery settings"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }

  const defaults = query.data.defaults;
  const values = draft;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));

  const changed = (Object.keys(source) as (keyof Draft)[]).filter((key) => norm(values[key]) !== norm(source[key]));
  const errors: Partial<Record<keyof Draft, string>> = {};
  for (const field of Object.keys(NUMBER_FIELDS) as NumberField[]) {
    const error = numberError(field, values[field]);
    if (error) errors[field] = error;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.teamMapStartDate)) errors.teamMapStartDate = "Pick a date.";

  const serverField = update.isError ? errorField(update.error) : null;
  const fieldError = (key: keyof Draft) =>
    errors[key] ?? (serverField && serverField.split(".")[0] === key ? errorMessage(update.error) : null);

  function save() {
    if (Object.keys(errors).length > 0) return;
    const input: DeliverySettingsInput = {};
    for (const key of changed) {
      switch (key) {
        case "dashboardTeams":
          input.dashboardTeams = values.dashboardTeams.length ? values.dashboardTeams : null;
          break;
        case "minLeadDays":
        case "briefMinLength":
        case "minCompletedToRank":
        case "staleDays":
          input[key] = Number(values[key]);
          break;
        case "brandTeamMap":
          input.brandTeamMap = Object.entries(values.brandTeamMap)
            .filter(([, people]) => people.length > 0)
            .map(([brand, people]) => ({ brand, users: people }));
          break;
        default:
          (input as Record<string, unknown>)[key] = values[key];
      }
    }
    update.mutate(input);
  }

  const activeBrands = (brands.data ?? []).filter((brand) => brand.active || values.brandTeamMap[brand._id]?.length);

  return (
    <SettingsFormCard
      title="Delivery Pulse"
      description="Who counts as a doer, how rework and briefs are judged, and which people belong on each brand. Saving refreshes the dashboard at once."
      dirty={changed.length > 0}
      pending={update.isPending}
      onSubmit={save}
      onReset={() => {
        setDraft(source);
        update.reset();
      }}
    >
      <Group title="People & teams">
        <Field id="ds-tm" label="Traffic managers" hint="Co-assigned for allocation only: left out of people stats, doer checks and the team map." error={fieldError("trafficManagers")}>
          <MultiSelect
            id="ds-tm"
            options={userOptions}
            value={values.trafficManagers}
            onValueChange={(next) => set("trafficManagers", next)}
            placeholder={users.isPending ? "Loading people…" : "Nobody"}
            max={50}
            aria-describedby="ds-tm-message"
          />
        </Field>
        <Field id="ds-teams" label="Dashboard teams" hint="Departments shown as teams. Leave empty for every department; the rest are grouped as “Other”." error={fieldError("dashboardTeams")}>
          <MultiSelect
            id="ds-teams"
            options={departmentOptions}
            value={values.dashboardTeams}
            onValueChange={(next) => set("dashboardTeams", next)}
            placeholder="All departments"
            aria-describedby="ds-teams-message"
          />
        </Field>
        <NumberInput id="ds-rank" label="Minimum completed tasks to rank a person" field="minCompletedToRank" values={values} set={set} error={fieldError("minCompletedToRank")} hint={`People below this are shown as “not ranked”. Default ${defaults.minCompletedToRank}.`} />
      </Group>

      <Group title="Rework">
        <Field
          id="ds-kw"
          label="Rework keywords"
          hint="A task is rework when its title contains one of these as a whole word (case-insensitive). Press Enter to add."
          error={fieldError("reworkKeywords")}
          action={
            <ResetLink
              show={norm(values.reworkKeywords) !== norm(defaults.reworkKeywords)}
              onClick={() => set("reworkKeywords", defaults.reworkKeywords)}
            />
          }
        >
          <TagsInput id="ds-kw" value={values.reworkKeywords} onChange={(next) => set("reworkKeywords", next)} placeholder="amend, revision…" aria-describedby="ds-kw-message" />
        </Field>
        <Field id="ds-cat" label="Rework task categories" hint={`Tasks in these categories are always rework (default: ${defaults.reworkCategoryNames.join(", ") || "none"}).`} error={fieldError("reworkCategories")} action={<ManageLink to="/settings/tasks">Manage categories</ManageLink>}>
          <MultiSelect id="ds-cat" options={categoryOptions} value={values.reworkCategories} onValueChange={(next) => set("reworkCategories", next)} placeholder="None" aria-describedby="ds-cat-message" />
        </Field>
      </Group>

      <Group title="Brief rules">
        <Field id="ds-weekday" label="Briefing weekday (rule 3)" hint="Briefs created on this day pass rule 3." error={fieldError("briefingWeekday")}>
          <NativeSelect id="ds-weekday" className="w-full sm:w-56" value={String(values.briefingWeekday)} onChange={(event) => set("briefingWeekday", Number(event.target.value))}>
            {WEEKDAYS.map((day, index) => (
              <NativeSelectOption key={day} value={String(index)}>
                {day}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberInput id="ds-lead" label="Minimum lead time, days (rule 4)" field="minLeadDays" values={values} set={set} error={fieldError("minLeadDays")} hint={`Due date minus creation date. Default ${defaults.minLeadDays}.`} />
          <NumberInput id="ds-len" label="Written-brief minimum length (rule 2)" field="briefMinLength" values={values} set={set} error={fieldError("briefMinLength")} hint={`Characters, excluding links. Default ${defaults.briefMinLength}.`} />
        </div>
        <Field id="ds-same" label="Brands allowed same-day delivery (rule 5)" hint="Tasks for these brands may be due on the day they're briefed." error={fieldError("sameDayBrands")} action={<ManageLink to="/settings/brands">Manage brands</ManageLink>}>
          <MultiSelect id="ds-same" options={brandOptions} value={values.sameDayBrands} onValueChange={(next) => set("sameDayBrands", next)} placeholder="None" aria-describedby="ds-same-message" />
        </Field>
        <Field
          id="ds-domains"
          label="Final-asset link domains (rule 7)"
          hint="A completed task passes with any attached file, or a link on one of these domains (subdomains count) in its description, comments or notes."
          error={fieldError("finalAssetDomains")}
          action={
            <ResetLink
              show={norm(values.finalAssetDomains) !== norm(defaults.finalAssetDomains)}
              onClick={() => set("finalAssetDomains", defaults.finalAssetDomains)}
            />
          }
        >
          <TagsInput
            id="ds-domains"
            value={values.finalAssetDomains}
            onChange={(next) => set("finalAssetDomains", next)}
            placeholder="frame.io"
            maxLength={253}
            normalize={(text) => text.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "")}
            aria-describedby="ds-domains-message"
          />
        </Field>
      </Group>

      <Group title="Delayed work">
        <NumberInput id="ds-stale" label="Stale threshold, days past due" field="staleDays" values={values} set={set} error={fieldError("staleDays")} hint={`More than this many days late counts as stale and is hidden by default. Default ${defaults.staleDays}.`} />
      </Group>

      <Group title="Brand team maps">
        <Field id="ds-start" label="Tracking start date" hint="Team map coverage counts tasks from this date." error={fieldError("teamMapStartDate")}>
          <Input id="ds-start" type="date" className="w-full sm:w-56" value={values.teamMapStartDate} onChange={(event) => set("teamMapStartDate", event.target.value)} aria-describedby="ds-start-message" />
        </Field>
        <div className="space-y-2">
          <p className="text-sm font-medium">People allowed on each brand</p>
          <p className="text-xs text-muted-foreground">
            Rule 6 checks every doer against the brand&apos;s map; brands left empty have no map (rule 6 is n/a and they show as “unmapped”).
          </p>
          {brands.isPending ? (
            <p className="text-xs text-muted-foreground">Loading brands…</p>
          ) : activeBrands.length === 0 ? (
            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No brands yet. <ManageLink to="/settings/brands">Add brands</ManageLink>
            </p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {activeBrands.map((brand) => (
                <li key={brand._id} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:items-center">
                  <Label htmlFor={`ds-map-${brand._id}`} className="flex min-w-0 items-center gap-2 font-normal">
                    <BrandDot color={brand.color} />
                    <span className="truncate">{brand.name}</span>
                  </Label>
                  <MultiSelect
                    id={`ds-map-${brand._id}`}
                    options={userOptions}
                    value={values.brandTeamMap[brand._id] ?? []}
                    onValueChange={(next) => set("brandTeamMap", { ...values.brandTeamMap, [brand._id]: next })}
                    placeholder="No map"
                  />
                </li>
              ))}
            </ul>
          )}
          {fieldError("brandTeamMap") && <p className="text-xs text-destructive">{fieldError("brandTeamMap")}</p>}
        </div>
      </Group>

      {update.isError && !serverField && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(update.error)}</AlertDescription>
        </Alert>
      )}
    </SettingsFormCard>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-4">
      <legend className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</legend>
      {children}
      <Separator className="mt-1" />
    </fieldset>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  action,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {action}
      </div>
      {children}
      <FieldMessage id={`${id}-message`} error={error} hint={hint} />
    </div>
  );
}

function NumberInput({
  id,
  label,
  field,
  values,
  set,
  error,
  hint,
}: {
  id: string;
  label: string;
  field: NumberField;
  values: Draft;
  set: <K extends keyof Draft>(key: K, value: Draft[K]) => void;
  error: string | null;
  hint: string;
}) {
  const { min, max } = NUMBER_FIELDS[field];
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        className="w-full sm:w-40"
        value={values[field]}
        onChange={(event) => set(field, event.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={`${id}-message`}
      />
    </Field>
  );
}

function ResetLink({ show, onClick }: { show: boolean; onClick: () => void }) {
  if (!show) return null;
  return (
    <Button type="button" variant="ghost" size="xs" onClick={onClick}>
      <LuRotateCcw aria-hidden />
      Use defaults
    </Button>
  );
}
