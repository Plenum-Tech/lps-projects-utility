import { api } from "@/lib/api";

/** Pulls `filename="..."` out of a Content-Disposition header. */
function filenameFromDisposition(header: unknown, fallback: string): string {
  if (typeof header !== "string") return fallback;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) return decodeURIComponent(utf8[1]);
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1] ?? fallback;
}

/** Saves a Blob through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Downloads a file from an authenticated API endpoint (cookie auth is sent by
 * the shared Axios instance). Empty params are dropped.
 */
export interface DownloadResult {
  filename: string;
  /** Lower-cased response headers (e.g. `x-export-rows`). */
  headers: Record<string, string>;
}

export async function downloadFromApi(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
  fallbackName: string
): Promise<DownloadResult> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") clean[key] = String(value);
  }
  let response;
  try {
    response = await api.get<Blob>(path, {
      params: clean,
      responseType: "blob",
      timeout: 120_000,
    });
  } catch (error) {
    // Blob responses hide the JSON `{ error }` body — surface it.
    const data = (error as { response?: { data?: unknown } }).response?.data;
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text()) as { error?: string };
        if (parsed.error) throw new Error(parsed.error);
      } catch (parseError) {
        if (parseError instanceof Error && !(parseError instanceof SyntaxError)) throw parseError;
      }
    }
    throw error;
  }
  const filename = filenameFromDisposition(response.headers["content-disposition"], fallbackName);
  saveBlob(response.data, filename);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(response.headers ?? {})) {
    if (typeof value === "string") headers[key.toLowerCase()] = value;
  }
  return { filename, headers };
}

/** CSV export: `X-Export-Rows / -Total / -Truncated` headers (see the API contract). */
export interface ExportResult {
  filename: string;
  rows: number;
  total: number;
  truncated: boolean;
}

export async function downloadCsvExport(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
  fallbackName: string
): Promise<ExportResult> {
  const { filename, headers } = await downloadFromApi(path, params, fallbackName);
  const rows = Number(headers["x-export-rows"] ?? NaN);
  const total = Number(headers["x-export-total"] ?? NaN);
  return {
    filename,
    rows: Number.isFinite(rows) ? rows : 0,
    total: Number.isFinite(total) ? total : Number.isFinite(rows) ? rows : 0,
    truncated: headers["x-export-truncated"] === "true",
  };
}
