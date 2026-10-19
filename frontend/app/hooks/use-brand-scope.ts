import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import type { BrandScopeVersion, DiffRow, ScopeExtraction, ScopeMatchResult } from "@/types";

// ---------------------------------------------------------------------------
// Brand scope vs its agreement (similarity, advice only) and the scope's
// version history.
// ---------------------------------------------------------------------------

export const brandScopeKeys = {
  versions: (id: string) => ["brands", "scope-versions", id] as const,
  match: (key: string) => ["brands", "scope-match", key] as const,
};

/**
 * How close `rows` are to the agreement: the flow's read result (`extraction`) or the brand's
 * stored agreement (`brandId`). Re-runs, debounced, as the rows are edited.
 */
export function useScopeMatch({
  rows,
  extraction,
  brandId,
  enabled = true,
}: {
  rows: DiffRow[];
  extraction?: Pick<ScopeExtraction, "scope" | "texts"> | null;
  brandId?: string | null;
  enabled?: boolean;
}) {
  const body = {
    rows: rows.map((r) => ({ unit: r.unit, what: r.what ?? "", quantity: r.quantity, languageList: r.languageList ?? [], languages: r.languages, sizes: r.sizes ?? 1 })),
    ...(extraction ? { extraction: { scope: extraction.scope, texts: extraction.texts.map((t) => ({ source: t.source, text: t.text })) } } : {}),
    ...(!extraction && brandId ? { brandId } : {}),
  };
  const key = useDebouncedValue(JSON.stringify(body), 700);
  return useQuery({
    queryKey: brandScopeKeys.match(key),
    queryFn: async () =>
      (await api.post<{ match: ScopeMatchResult | null; reason?: string }>("/brands/scope-match", JSON.parse(key), { timeout: 30_000 })).data,
    enabled: enabled && Boolean(extraction || brandId),
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The brand's scope versions, newest first, each with its diff against the one before. */
export function useBrandScopeVersions(id: string, enabled = true) {
  return useQuery({
    queryKey: brandScopeKeys.versions(id),
    queryFn: async () => (await api.get<{ versions: BrandScopeVersion[] }>(`/brands/${id}/scope-versions`)).data.versions,
    enabled: enabled && Boolean(id),
    staleTime: 30_000,
  });
}
