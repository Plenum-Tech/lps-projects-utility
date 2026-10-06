import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useToast } from "@/hooks/use-toast";
import { API_BASE_URL, api, getErrorMessage } from "@/lib/api";
import type { CompanySettings, CompanySettingsInput, PublicSettings } from "@/types";

export const settingsKeys = {
  public: ["settings", "public"] as const,
  company: ["settings", "company"] as const,
};

/** Defaults the server uses until someone edits settings (keeps today's behaviour). */
export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  name: "EMS",
  logoUrl: null,
  logoPath: null,
  dateFormat: "DD-MM-YYYY",
  timeFormat: "12h",
  weekStart: "monday",
  timezone: "Asia/Kolkata",
  currency: { code: "INR", symbol: "₹" },
};

/** Absolute logo URL built from the API base (same host as every other API call). */
export function logoSrc(settings: Pick<PublicSettings, "logoPath" | "logoUrl"> | undefined | null) {
  if (!settings) return null;
  if (settings.logoPath) return `${API_BASE_URL.replace(/\/$/, "")}${settings.logoPath}`;
  return settings.logoUrl;
}

/** Public subset of the company settings — unauthenticated (login page, sidebar, formatting). */
export function usePublicSettings() {
  return useQuery({
    queryKey: settingsKeys.public,
    queryFn: async () => {
      const { data } = await api.get<{ settings: PublicSettings }>("/settings/public");
      return data.settings;
    },
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/** Full company settings document (admin). */
export function useCompanySettings(enabled = true) {
  return useQuery({
    queryKey: settingsKeys.company,
    queryFn: async () => {
      const { data } = await api.get<{ settings: CompanySettings }>("/settings/company");
      return data.settings;
    },
    enabled,
  });
}

/** Mirrors a fresh company document into the public cache so the sidebar/formatters update at once. */
function useSyncSettings() {
  const queryClient = useQueryClient();
  return (settings: CompanySettings) => {
    queryClient.setQueryData(settingsKeys.company, settings);
    queryClient.setQueryData<PublicSettings>(settingsKeys.public, (previous) => ({
      ...(previous ?? DEFAULT_PUBLIC_SETTINGS),
      name: settings.name,
      logoUrl: settings.logo?.url ?? null,
      logoPath: settings.logo?.path ?? null,
      dateFormat: settings.dateFormat,
      timeFormat: settings.timeFormat,
      weekStart: settings.weekStart,
      timezone: settings.effective.timezone,
      currency: settings.currency,
    }));
    // /settings/public is browser-cached for 5 minutes: refresh that HTTP cache
    // entry too, so a reload right after saving doesn't show the old brand.
    if (typeof window !== "undefined") {
      void fetch(`${API_BASE_URL}/settings/public`, { cache: "reload", credentials: "include" }).catch(
        () => undefined
      );
    }
  };
}

/** Error carrying the server's `field` so forms can mark the right input. */
export class SettingsFieldError extends Error {
  field: string | null;
  constructor(message: string, field: string | null) {
    super(message);
    this.field = field;
  }
}

function toFieldError(error: unknown): SettingsFieldError {
  const field =
    (error as { response?: { data?: { field?: unknown } } })?.response?.data?.field ?? null;
  return new SettingsFieldError(getErrorMessage(error), typeof field === "string" ? field : null);
}

export function useUpdateCompanySettings() {
  const sync = useSyncSettings();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: CompanySettingsInput) => {
      try {
        const { data } = await api.patch<{ settings: CompanySettings; changed: string[] }>(
          "/settings/company",
          input
        );
        return data;
      } catch (error) {
        throw toFieldError(error);
      }
    },
    onSuccess: ({ settings }) => {
      sync(settings);
      toast.success("Settings saved");
    },
  });
}

export function useUploadCompanyLogo() {
  const sync = useSyncSettings();
  const toast = useToast();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const { data } = await api.put<{ settings: CompanySettings }>("/settings/company/logo", form, {
        headers: { "Content-Type": "multipart/form-data" },
        timeout: 60_000,
      });
      return data.settings;
    },
    onSuccess: (settings) => {
      sync(settings);
      toast.success("Logo updated");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

export function useDeleteCompanyLogo() {
  const sync = useSyncSettings();
  const toast = useToast();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.delete<{ settings: CompanySettings }>("/settings/company/logo");
      return data.settings;
    },
    onSuccess: (settings) => {
      sync(settings);
      toast.success("Logo removed");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
