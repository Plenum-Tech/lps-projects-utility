import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { LuImage, LuLoaderCircle, LuTrash2, LuUpload } from "react-icons/lu";

import { ConfirmDialog } from "@/components/globals/confirm-dialog";
import { QueryError } from "@/components/globals/query-states";
import {
  FieldMessage,
  SettingsFormCard,
  SettingsFormSkeleton,
} from "@/components/settings/settings-form-card";
import { errorField, errorMessage, useSettingsForm } from "@/components/settings/use-settings-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  logoSrc,
  useCompanySettings,
  useDeleteCompanyLogo,
  useUpdateCompanySettings,
  useUploadCompanyLogo,
} from "@/hooks/use-settings";
import { formatFileSize } from "@/lib/tasks";
import type { CompanySettingsInput } from "@/types";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/[^\s/$.?#].[^\s]*$/i;
const PHONE_RE = /^[0-9+()\-.\s]*$/;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/svg+xml"];
const LOGO_MAX_BYTES = 1024 * 1024;

type CompanyForm = { name: string; email: string; phone: string; website: string };

/** Settings → Company: name, email, phone, website, plus the logo (uploaded immediately). */
export function CompanySection() {
  const company = useCompanySettings();
  const update = useUpdateCompanySettings();
  const source = useMemo<CompanyForm | undefined>(
    () =>
      company.data && {
        name: company.data.name,
        email: company.data.email,
        phone: company.data.phone,
        website: company.data.website,
      },
    [company.data]
  );
  const form = useSettingsForm(source);
  const [submitted, setSubmitted] = useState(false);

  if (company.isPending) return <SettingsFormSkeleton rows={4} />;
  if (company.isError || !form.values) {
    return (
      <QueryError
        title="Couldn't load company settings"
        error={company.error}
        onRetry={() => void company.refetch()}
        retrying={company.isRefetching}
      />
    );
  }

  const values = form.values;
  const errors: Partial<Record<keyof CompanyForm, string>> = {};
  if (!values.name.trim()) errors.name = "Company name is required.";
  else if (values.name.trim().length > 120) errors.name = "Keep it under 120 characters.";
  if (!values.email.trim()) errors.email = "Company email is required.";
  else if (!EMAIL_RE.test(values.email.trim())) errors.email = "Enter a valid email address.";
  if (values.phone.length > 30 || !PHONE_RE.test(values.phone))
    errors.phone = "Use digits, spaces and + ( ) - . only (max 30).";
  if (values.website.trim() && !URL_RE.test(values.website.trim()))
    errors.website = "Enter a full URL starting with http:// or https://";

  const serverField = update.isError ? errorField(update.error) : null;
  const fieldError = (key: keyof CompanyForm) =>
    (submitted ? errors[key] : undefined) ??
    (serverField === key ? errorMessage(update.error) : null);

  function save() {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    const input: CompanySettingsInput = {};
    for (const key of form.changed) {
      const value = values[key].trim();
      if (key === "phone" || key === "website") input[key] = value || null;
      else input[key] = value;
    }
    update.mutate(input, { onSuccess: () => setSubmitted(false) });
  }

  return (
    <div className="space-y-6">
      <SettingsFormCard
        title="Company details"
        description="Shown in the sidebar, on the login page and in email headers and footers."
        dirty={form.dirty}
        pending={update.isPending}
        onSubmit={save}
        onReset={() => {
          form.reset();
          setSubmitted(false);
          update.reset();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="company-name"
            label="Company name"
            required
            value={values.name}
            onChange={(value) => form.set("name", value)}
            error={fieldError("name")}
            maxLength={120}
            autoComplete="organization"
          />
          <TextField
            id="company-email"
            label="Company email"
            required
            type="email"
            value={values.email}
            onChange={(value) => form.set("email", value)}
            error={fieldError("email")}
            autoComplete="email"
          />
          <TextField
            id="company-phone"
            label="Company phone"
            type="tel"
            value={values.phone}
            onChange={(value) => form.set("phone", value)}
            error={fieldError("phone")}
            maxLength={30}
            autoComplete="tel"
          />
          <TextField
            id="company-website"
            label="Website"
            type="url"
            placeholder="https://example.com"
            value={values.website}
            onChange={(value) => form.set("website", value)}
            error={fieldError("website")}
            maxLength={200}
          />
        </div>
        {update.isError && !serverField && (
          <Alert variant="destructive">
            <AlertDescription>{errorMessage(update.error)}</AlertDescription>
          </Alert>
        )}
      </SettingsFormCard>

      <LogoCard />
    </div>
  );
}

export function TextField({
  id,
  label,
  value,
  onChange,
  error,
  hint,
  required,
  type = "text",
  placeholder,
  maxLength,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  autoComplete?: string;
}) {
  const messageId = `${id}-message`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            *
          </span>
        )}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        autoComplete={autoComplete}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error)}
        aria-describedby={error || hint ? messageId : undefined}
      />
      <FieldMessage id={messageId} error={error} hint={hint} />
    </div>
  );
}

/** Logo: upload / replace / remove; applied straight away (no Save needed). */
function LogoCard() {
  const company = useCompanySettings();
  const upload = useUploadCompanyLogo();
  const remove = useDeleteCompanyLogo();
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const logo = company.data?.logo ?? null;
  const src = logo ? logoSrc({ logoPath: logo.path, logoUrl: logo.url }) : null;

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setLocalError("Logo must be a PNG, JPG or SVG image.");
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setLocalError("Logo must be 1 MB or smaller.");
      return;
    }
    setLocalError(null);
    upload.mutate(file);
  }

  const busy = upload.isPending || remove.isPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Logo</CardTitle>
        <CardDescription>
          PNG, JPG or SVG, up to 1 MB. Shown in the sidebar, on the login page and in emails. Changes
          apply immediately.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-muted/40">
            {src ? (
              <img src={src} alt="Company logo" className="max-h-full max-w-full object-contain p-2" />
            ) : (
              <LuImage aria-hidden className="size-7 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap gap-2">
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/svg+xml"
                className="sr-only"
                id="company-logo"
                onChange={handleFile}
                tabIndex={-1}
              />
              <Button type="button" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
                {upload.isPending ? <LuLoaderCircle aria-hidden className="animate-spin" /> : <LuUpload aria-hidden />}
                {logo ? "Replace logo" : "Upload logo"}
              </Button>
              {logo && (
                <Button type="button" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={busy}>
                  <LuTrash2 aria-hidden />
                  Remove
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {logo
                ? `${logo.mimeType.replace("image/", "").replace("svg+xml", "svg").toUpperCase()} · ${formatFileSize(logo.size)}`
                : "No logo yet — the default LPS logo is used."}
            </p>
          </div>
        </div>
        {localError && (
          <p className="text-xs text-destructive" role="alert">
            {localError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          SVGs are cleaned on upload (scripts and external references are removed). Emails only show
          PNG/JPG logos, and in production they need <code className="font-mono">API_PUBLIC_URL</code> set
          on the server so mail clients can load the image.
        </p>
      </CardContent>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the logo?"
        description="The sidebar, login page and emails go back to the default LPS logo."
        confirmLabel="Remove logo"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate(undefined, { onSettled: () => setConfirmRemove(false) })}
      />
    </Card>
  );
}
