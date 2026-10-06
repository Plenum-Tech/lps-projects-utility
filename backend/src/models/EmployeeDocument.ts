import mongoose, { Schema } from "mongoose";

export const EMPLOYEE_DOCUMENT_TYPES = [
  "passport",
  "visa",
  "work_permit",
  "national_id",
  "driving_license",
  "contract",
  "certificate",
  "insurance",
  "other",
] as const;

export type EmployeeDocumentType = (typeof EMPLOYEE_DOCUMENT_TYPES)[number];

/** Human labels (emails / notifications). */
export const EMPLOYEE_DOCUMENT_TYPE_LABELS: Record<EmployeeDocumentType, string> = {
  passport: "Passport",
  visa: "Visa",
  work_permit: "Work permit",
  national_id: "National ID",
  driving_license: "Driving license",
  contract: "Contract",
  certificate: "Certificate",
  insurance: "Insurance",
  other: "Other",
};

export const EMPLOYEE_DOCUMENT_LIMITS = {
  nameMax: 120,
  notesMax: 1000,
  maxBytes: 10 * 1024 * 1024,
} as const;

/** PDF, images and Office documents. */
export const EMPLOYEE_DOCUMENT_MIME_TYPES: readonly string[] = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];

export const EMPLOYEE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "webp", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
]);

export interface IEmployeeDocumentFile {
  filename: string;
  mimeType: string;
  size: number;
  /** Id in the `employeeDocuments` GridFS bucket (never sent to clients). */
  gridFsId: mongoose.Types.ObjectId;
}

/**
 * An employee's document (passport, visa, contract...). No document numbers are
 * stored on purpose — only name, type, dates, notes and the file.
 */
export interface IEmployeeDocument extends mongoose.Document {
  user: mongoose.Types.ObjectId;
  type: EmployeeDocumentType;
  name: string;
  /** Date-only (UTC midnight). */
  issueDate?: Date | null;
  /** Date-only; null = never expires (never reminded, never in the expiry card). */
  expiryDate?: Date | null;
  notes?: string;
  file?: IEmployeeDocumentFile | null;
  uploadedBy: mongoose.Types.ObjectId;
  /** Reminder thresholds already sent for the current expiry date: "30d" | "7d" | "0d" | "expired". */
  reminderKeys: string[];
  createdAt: Date;
  updatedAt: Date;
}

const fileSchema = new Schema<IEmployeeDocumentFile>(
  {
    filename: { type: String, required: true, trim: true, maxlength: 255 },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    gridFsId: { type: Schema.Types.ObjectId, required: true },
  },
  { _id: false }
);

const employeeDocumentSchema = new Schema<IEmployeeDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, required: true, enum: EMPLOYEE_DOCUMENT_TYPES },
    name: { type: String, required: true, trim: true, maxlength: EMPLOYEE_DOCUMENT_LIMITS.nameMax },
    issueDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: EMPLOYEE_DOCUMENT_LIMITS.notesMax, default: "" },
    file: { type: fileSchema, default: null },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    reminderKeys: { type: [String], default: [] },
  },
  { timestamps: true }
);

// A user's documents, newest first.
employeeDocumentSchema.index({ user: 1, createdAt: -1 });
// Expiry card + reminder job.
employeeDocumentSchema.index({ expiryDate: 1, user: 1 });

// Never leak the internal version key, the storage id or the job's keys.
employeeDocumentSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.reminderKeys;
    const file = json.file as Record<string, unknown> | null | undefined;
    if (file) delete file.gridFsId;
    return json;
  },
});

export const EmployeeDocument = mongoose.model<IEmployeeDocument>(
  "EmployeeDocument",
  employeeDocumentSchema
);
