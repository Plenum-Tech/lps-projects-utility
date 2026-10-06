import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { myDashboardKeys } from "@/hooks/use-my-dashboard";
import { useToast } from "@/hooks/use-toast";
import { api, getErrorMessage } from "@/lib/api";
import { downloadFromApi } from "@/lib/download";
import type {
  DocumentInput,
  DocumentListResponse,
  DocumentResponse,
  DocumentType,
  EmployeeDocument,
} from "@/types";

export interface DocumentFilters {
  /** "me" (default), "all" (admin / head scope) or a user id. */
  user?: string;
  type?: DocumentType | "";
  search?: string;
  /** Only documents expiring within N days (incl. expired). */
  expiring?: number | null;
  limit?: number;
  offset?: number;
}

export const documentKeys = {
  all: ["documents"] as const,
  list: (filters: DocumentFilters) => ["documents", "list", filters] as const,
};

export function useDocuments(filters: DocumentFilters) {
  return useQuery({
    queryKey: documentKeys.list(filters),
    queryFn: async () => {
      const { data } = await api.get<DocumentListResponse>("/documents", {
        params: {
          ...(filters.user && filters.user !== "me" ? { user: filters.user } : {}),
          ...(filters.type ? { type: filters.type } : {}),
          ...(filters.search ? { search: filters.search } : {}),
          ...(filters.expiring !== null && filters.expiring !== undefined
            ? { expiring: filters.expiring }
            : {}),
          ...(filters.limit !== undefined ? { limit: filters.limit, offset: filters.offset ?? 0 } : {}),
        },
      });
      return data;
    },
    placeholderData: keepPreviousData,
  });
}

/** JSON when there's no file, multipart otherwise (backend accepts both). */
function toBody(input: DocumentInput): { body: FormData | Record<string, unknown>; multipart: boolean } {
  const { file, ...rest } = input;
  if (!file) {
    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) body[key] = value;
    return { body, multipart: false };
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined && value !== null) form.append(key, String(value));
  }
  form.append("file", file);
  return { body: form, multipart: true };
}

function requestConfig(multipart: boolean) {
  return multipart
    ? { headers: { "Content-Type": "multipart/form-data" }, timeout: 120_000 }
    : undefined;
}

function useInvalidateDocuments() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: documentKeys.all });
    void queryClient.invalidateQueries({ queryKey: myDashboardKeys.summary() });
  };
}

export function useCreateDocument() {
  const invalidate = useInvalidateDocuments();
  const toast = useToast();
  return useMutation({
    mutationFn: async (input: DocumentInput) => {
      const { body, multipart } = toBody(input);
      const { data } = await api.post<DocumentResponse>("/documents", body, requestConfig(multipart));
      return data.document;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Document added");
    },
  });
}

export function useUpdateDocument() {
  const invalidate = useInvalidateDocuments();
  const toast = useToast();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: DocumentInput }) => {
      const { body, multipart } = toBody(input);
      const { data } = await api.patch<DocumentResponse>(
        `/documents/${id}`,
        body,
        requestConfig(multipart)
      );
      return data.document;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Document updated");
    },
  });
}

export function useDeleteDocument() {
  const invalidate = useInvalidateDocuments();
  const toast = useToast();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/documents/${id}`);
    },
    onSuccess: () => {
      invalidate();
      toast.success("Document deleted");
    },
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}

/** Downloads the stored file through the authenticated API (blob). */
export function useDownloadDocument() {
  const toast = useToast();
  return useMutation({
    mutationFn: async (document: EmployeeDocument) =>
      downloadFromApi(
        `/documents/${document._id}/file`,
        {},
        document.file?.filename ?? `${document.name}`
      ),
    onError: (error: unknown) => toast.error(getErrorMessage(error)),
  });
}
