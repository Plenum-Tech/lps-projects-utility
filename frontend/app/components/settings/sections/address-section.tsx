import { useMemo } from "react";

import { QueryError } from "@/components/globals/query-states";
import { TextField } from "@/components/settings/sections/company-section";
import { SettingsFormCard, SettingsFormSkeleton } from "@/components/settings/settings-form-card";
import { errorField, errorMessage, useSettingsForm } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useCompanySettings, useUpdateCompanySettings } from "@/hooks/use-settings";
import type { CompanyAddress } from "@/types";

const FIELDS: { key: keyof CompanyAddress; label: string; max: number; autoComplete: string; wide?: boolean }[] = [
  { key: "line1", label: "Address line 1", max: 200, autoComplete: "address-line1", wide: true },
  { key: "line2", label: "Address line 2", max: 200, autoComplete: "address-line2", wide: true },
  { key: "city", label: "City", max: 100, autoComplete: "address-level2" },
  { key: "state", label: "State / region", max: 100, autoComplete: "address-level1" },
  { key: "postalCode", label: "Postal code", max: 20, autoComplete: "postal-code" },
  { key: "country", label: "Country", max: 100, autoComplete: "country-name" },
];

/** Settings → Business Address: shown in email footers. */
export function AddressSection() {
  const company = useCompanySettings();
  const update = useUpdateCompanySettings();
  const source = useMemo<CompanyAddress | undefined>(
    () => (company.data ? { ...company.data.address } : undefined),
    [company.data]
  );
  const form = useSettingsForm(source);

  if (company.isPending) return <SettingsFormSkeleton rows={6} />;
  if (company.isError || !form.values) {
    return (
      <QueryError
        title="Couldn't load the business address"
        error={company.error}
        onRetry={() => void company.refetch()}
        retrying={company.isRefetching}
      />
    );
  }
  const values = form.values;
  const serverField = update.isError ? errorField(update.error) : null;

  function save() {
    const address: Partial<CompanyAddress> = {};
    for (const key of form.changed) address[key] = values[key].trim();
    update.mutate({ address });
  }

  return (
    <SettingsFormCard
      title="Business address"
      description="Printed in the footer of every email the app sends. Leave fields empty to hide them."
      dirty={form.dirty}
      pending={update.isPending}
      onSubmit={save}
      onReset={() => {
        form.reset();
        update.reset();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {FIELDS.map((field) => (
          <div key={field.key} className={field.wide ? "sm:col-span-2" : undefined}>
            <TextField
              id={`address-${field.key}`}
              label={field.label}
              value={values[field.key]}
              onChange={(value) => form.set(field.key, value)}
              maxLength={field.max}
              autoComplete={field.autoComplete}
              error={serverField === `address.${field.key}` ? errorMessage(update.error) : null}
            />
          </div>
        ))}
      </div>
      {update.isError && !(serverField ?? "").startsWith("address.") && (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(update.error)}</AlertDescription>
        </Alert>
      )}
    </SettingsFormCard>
  );
}
