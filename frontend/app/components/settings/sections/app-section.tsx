import { useMemo, type ReactNode } from "react";
import { LuTriangleAlert } from "react-icons/lu";

import { QueryError } from "@/components/globals/query-states";
import { TextField } from "@/components/settings/sections/company-section";
import { SettingsFormCard, SettingsFormSkeleton } from "@/components/settings/settings-form-card";
import { errorField, errorMessage, useSettingsForm } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useCompanySettings, useUpdateCompanySettings } from "@/hooks/use-settings";
import type { CompanySettingsInput, DateFormat, TimeFormat, WeekStart } from "@/types";

type AppForm = {
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  currencyCode: string;
  currencySymbol: string;
  appUrl: string;
};

const URL_RE = /^https?:\/\/[^\s/$.?#][^\s?#]*$/i;

function sampleDate(format: DateFormat) {
  const now = new Date();
  const d = String(now.getDate()).padStart(2, "0");
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const y = now.getFullYear();
  return format === "MM-DD-YYYY" ? `${m}-${d}-${y}` : format === "YYYY-MM-DD" ? `${y}-${m}-${d}` : `${d}-${m}-${y}`;
}

const DATE_FORMATS: DateFormat[] = ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"];

function timezoneOptions(current: string): { value: string; label: string }[] {
  let zones: string[] = [];
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  } catch {
    zones = [];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  if (current && !zones.includes(current)) zones = [current, ...zones];
  return zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") }));
}

/** Narrow currency symbol for an ISO code ("INR" → "₹"), or null if Intl doesn't know it. */
function symbolFor(code: string): string | null {
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try {
    const part = new Intl.NumberFormat("en", { style: "currency", currency: code, currencyDisplay: "narrowSymbol" })
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part && part.value.length <= 4 ? part.value : null;
  } catch {
    return null;
  }
}

/** Settings → App: timezone, date/time formats, week start, currency, app URL. */
export function AppSection() {
  const company = useCompanySettings();
  const update = useUpdateCompanySettings();
  const source = useMemo<AppForm | undefined>(
    () =>
      company.data && {
        timezone: company.data.timezone,
        dateFormat: company.data.dateFormat,
        timeFormat: company.data.timeFormat,
        weekStart: company.data.weekStart,
        currencyCode: company.data.currency.code,
        currencySymbol: company.data.currency.symbol,
        appUrl: company.data.appUrl,
      },
    [company.data]
  );
  const form = useSettingsForm(source);
  const zones = useMemo(() => timezoneOptions(source?.timezone ?? ""), [source?.timezone]);

  if (company.isPending) return <SettingsFormSkeleton rows={6} />;
  if (company.isError || !form.values || !company.data) {
    return (
      <QueryError
        title="Couldn't load app settings"
        error={company.error}
        onRetry={() => void company.refetch()}
        retrying={company.isRefetching}
      />
    );
  }
  const values = form.values;
  const data = company.data;

  const errors: Partial<Record<keyof AppForm, string>> = {};
  if (!/^[A-Za-z]{3}$/.test(values.currencyCode.trim())) errors.currencyCode = "Use a 3-letter ISO code, e.g. INR, USD, EUR.";
  const symbolLength = Array.from(values.currencySymbol.trim()).length;
  if (symbolLength < 1 || symbolLength > 4) errors.currencySymbol = "1–4 characters.";
  if (values.appUrl.trim() && !URL_RE.test(values.appUrl.trim()))
    errors.appUrl = "Enter a full http(s) URL without ? or #.";
  if (!values.timezone) errors.timezone = "Choose a timezone.";

  const serverField = update.isError ? errorField(update.error) : null;
  const serverError = (...fields: string[]) =>
    serverField && fields.includes(serverField) ? errorMessage(update.error) : null;
  const fieldError = (key: keyof AppForm, ...server: string[]) => errors[key] ?? serverError(...server);

  function save() {
    if (Object.keys(errors).length > 0) return;
    const input: CompanySettingsInput = {};
    for (const key of form.changed) {
      if (key === "currencyCode" || key === "currencySymbol") {
        input.currency = {
          code: values.currencyCode.trim().toUpperCase(),
          symbol: values.currencySymbol.trim(),
        };
      } else if (key === "appUrl") {
        input.appUrl = values.appUrl.trim() || null;
      } else if (key === "timezone") {
        input.timezone = values.timezone;
      } else if (key === "dateFormat") {
        input.dateFormat = values.dateFormat;
      } else if (key === "timeFormat") {
        input.timeFormat = values.timeFormat;
      } else if (key === "weekStart") {
        input.weekStart = values.weekStart;
      }
    }
    update.mutate(input);
  }

  const timezoneChanged = values.timezone !== data.timezone;
  const selectedZone = zones.find((zone) => zone.value === values.timezone) ?? null;

  return (
    <SettingsFormCard
      title="App settings"
      description="Regional formats and links used across the app and in emails."
      dirty={form.dirty}
      pending={update.isPending}
      onSubmit={save}
      onReset={() => {
        form.reset();
        update.reset();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="app-timezone">Timezone</Label>
        <Combobox
          items={zones}
          value={selectedZone}
          onValueChange={(item) => item && form.set("timezone", item.value)}
          autoHighlight
        >
          <ComboboxInput id="app-timezone" placeholder="Search timezones…" className="w-full" aria-describedby="app-timezone-hint" />
          <ComboboxContent sideOffset={4}>
            <ComboboxEmpty>No timezone found.</ComboboxEmpty>
            <ComboboxList>
              {(item: { value: string; label: string }) => (
                <ComboboxItem key={item.value} value={item}>
                  {item.label}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <p id="app-timezone-hint" className="text-xs text-muted-foreground">
          Decides what &quot;today&quot; means for due dates, reminders and attendance. Server fallback (
          <code className="font-mono">APP_TIMEZONE</code>): {data.envFallback.timezone || "Asia/Kolkata"}. Scheduled
          reminder emails keep their fixed server schedule.
        </p>
        {fieldError("timezone", "timezone") && (
          <p className="text-xs text-destructive">{fieldError("timezone", "timezone")}</p>
        )}
        {timezoneChanged && (
          <Alert>
            <LuTriangleAlert aria-hidden className="size-4" />
            <AlertTitle>Changing the timezone affects date-only logic from now on</AlertTitle>
            <AlertDescription>
              Due today, overdue, reminders and week boundaries switch to the new zone as soon as you save. Stored
              timestamps are UTC and don&apos;t change.
            </AlertDescription>
          </Alert>
        )}
      </div>

      <ChoiceGroup
        legend="Date format"
        value={values.dateFormat}
        onChange={(value) => form.set("dateFormat", value as DateFormat)}
        options={DATE_FORMATS.map((format) => ({ value: format, label: format, hint: sampleDate(format) }))}
        columns={3}
      />

      <ChoiceGroup
        legend="Time format"
        value={values.timeFormat}
        onChange={(value) => form.set("timeFormat", value as TimeFormat)}
        options={[
          { value: "12h", label: "12-hour", hint: "2:30 PM" },
          { value: "24h", label: "24-hour", hint: "14:30" },
        ]}
        columns={2}
      />

      <ChoiceGroup
        legend="Week starts on"
        value={values.weekStart}
        onChange={(value) => form.set("weekStart", value as WeekStart)}
        options={[
          { value: "monday", label: "Monday", hint: "Mon – Sun" },
          { value: "sunday", label: "Sunday", hint: "Sun – Sat" },
        ]}
        columns={2}
        footer="Used by calendars, the dashboard's week time logs and the “This week” filter. Timesheets always run Monday–Sunday."
      />

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Currency</legend>
        <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
          <TextField
            id="app-currency-code"
            label="Code"
            value={values.currencyCode}
            onChange={(value) => {
              const code = value.toUpperCase().slice(0, 3);
              form.set("currencyCode", code);
              const symbol = symbolFor(code);
              if (symbol) form.set("currencySymbol", symbol);
            }}
            maxLength={3}
            error={fieldError("currencyCode", "currency", "currency.code")}
            hint="ISO 4217 code, used for project budgets."
          />
          <TextField
            id="app-currency-symbol"
            label="Symbol"
            value={values.currencySymbol}
            onChange={(value) => form.set("currencySymbol", value)}
            maxLength={4}
            error={fieldError("currencySymbol", "currency.symbol")}
          />
        </div>
      </fieldset>

      <TextField
        id="app-url"
        label="App URL"
        type="url"
        value={values.appUrl}
        onChange={(value) => form.set("appUrl", value)}
        placeholder={data.envFallback.appUrl || "https://lps.example.com"}
        error={fieldError("appUrl", "appUrl")}
        hint={`Used for links in emails. Leave empty to use the server's APP_URL${
          data.envFallback.appUrl ? ` (${data.envFallback.appUrl})` : ""
        }. Currently: ${data.effective.appUrl || "not set"}.`}
      />

      {update.isError && !serverField && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(update.error)}</AlertDescription>
        </Alert>
      )}
    </SettingsFormCard>
  );
}

function ChoiceGroup({
  legend,
  value,
  onChange,
  options,
  columns,
  footer,
}: {
  legend: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; hint: string }[];
  columns: 2 | 3;
  footer?: ReactNode;
}) {
  const id = legend.toLowerCase().replace(/\W+/g, "-");
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <RadioGroup
        value={value}
        onValueChange={(next) => onChange(String(next))}
        className={columns === 3 ? "grid gap-2 sm:grid-cols-3" : "grid gap-2 sm:grid-cols-2"}
      >
        {options.map((option) => (
          <Label
            key={option.value}
            htmlFor={`${id}-${option.value}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal transition-colors duration-150 has-data-checked:border-ring/60 has-data-checked:bg-primary/5"
          >
            <RadioGroupItem id={`${id}-${option.value}`} value={option.value} className="mt-0.5" />
            <span>
              <span className="block text-sm font-medium text-foreground">{option.label}</span>
              <span className="block text-xs text-muted-foreground tabular-nums">{option.hint}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {footer && <p className="text-xs text-muted-foreground">{footer}</p>}
    </fieldset>
  );
}
