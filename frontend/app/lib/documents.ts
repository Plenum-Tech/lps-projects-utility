import type { DocumentType } from "@/types";

export const DOCUMENT_TYPES: DocumentType[] = [
  "passport",
  "visa",
  "work_permit",
  "national_id",
  "driving_license",
  "contract",
  "certificate",
  "insurance",
  "other",
];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  passport: "Passport",
  visa: "Visa",
  work_permit: "Work permit",
  national_id: "National ID",
  driving_license: "Driving licence",
  contract: "Contract",
  certificate: "Certificate",
  insurance: "Insurance",
  other: "Other",
};

/** Accepted upload types (mirrors the backend whitelist). */
export const DOCUMENT_ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,application/pdf,image/png,image/jpeg,image/gif,image/webp";

export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

export type ExpiryUrgency = "expired" | "soon" | "later" | "none";

/** Past → expired, ≤ 7 days → soon, otherwise later. */
export function expiryUrgency(inDays: number | null | undefined): ExpiryUrgency {
  if (inDays === null || inDays === undefined) return "none";
  if (inDays < 0) return "expired";
  if (inDays <= 7) return "soon";
  return "later";
}

/** Theme-token text classes per urgency ("soon" uses the amber chart token). */
export const EXPIRY_TEXT: Record<ExpiryUrgency, string> = {
  expired: "text-destructive",
  soon: "text-chart-4",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
};

export const EXPIRY_DOT: Record<ExpiryUrgency, string> = {
  expired: "bg-destructive",
  soon: "bg-chart-4",
  later: "bg-muted-foreground/60",
  none: "bg-muted-foreground/40",
};

/** "expired 3 days ago" / "expires today" / "in 5 days". */
export function expiryPhrase(inDays: number | null | undefined): string {
  if (inDays === null || inDays === undefined) return "No expiry";
  if (inDays < 0) {
    const ago = -inDays;
    return `Expired ${ago} day${ago === 1 ? "" : "s"} ago`;
  }
  if (inDays === 0) return "Expires today";
  if (inDays === 1) return "Tomorrow";
  return `In ${inDays} days`;
}
