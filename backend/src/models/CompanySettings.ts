import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Company settings — singleton (one document, `key: "company"`). Created lazily
// with defaults the first time an admin opens/edits settings; until then every
// reader falls back to the env defaults (see lib/companySettings.ts).
// ---------------------------------------------------------------------------

export const DATE_FORMATS = ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export const TIME_FORMATS = ["12h", "24h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const WEEK_STARTS = ["monday", "sunday"] as const;
export type WeekStart = (typeof WEEK_STARTS)[number];

export const LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/svg+xml"] as const;
export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

/** GridFS bucket for the company logo ("companyAssets.files" + ".chunks"). */
export const COMPANY_ASSETS_BUCKET = "companyAssets";

/** Product name — the company name until an admin sets one in Settings → Company. */
export const DEFAULT_COMPANY_NAME = "LPS – Projects Utility";
/** Earlier default names; a stored value equal to one of these counts as "not set". */
export const LEGACY_DEFAULT_COMPANY_NAMES: readonly string[] = ["EMS"];

export const COMPANY_SETTINGS_LIMITS = {
  nameMax: 120,
  emailMax: 254,
  phoneMax: 30,
  urlMax: 200,
  addressLineMax: 200,
  addressShortMax: 100,
  postalCodeMax: 20,
  currencySymbolMax: 4,
  logoMaxBytes: 1024 * 1024,
} as const;

export interface CompanyLogo {
  gridFsId: mongoose.Types.ObjectId;
  mimeType: LogoMimeType;
  size: number;
}

export interface CompanyAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface ICompanySettings extends mongoose.Document {
  key: "company";
  name: string;
  email: string;
  phone?: string;
  website?: string;
  logo?: CompanyLogo | null;
  address: CompanyAddress;
  timezone: string;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  weekStart: WeekStart;
  currency: { code: string; symbol: string };
  /** Frontend base URL for email links; empty → APP_URL env. */
  appUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

const logoSchema = new Schema<CompanyLogo>(
  {
    gridFsId: { type: Schema.Types.ObjectId, required: true },
    mimeType: { type: String, enum: LOGO_MIME_TYPES, required: true },
    size: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const addressSchema = new Schema<CompanyAddress>(
  {
    line1: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.addressLineMax },
    line2: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.addressLineMax },
    city: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.addressShortMax },
    state: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.addressShortMax },
    postalCode: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.postalCodeMax },
    country: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.addressShortMax },
  },
  { _id: false }
);

const companySettingsSchema = new Schema<ICompanySettings>(
  {
    key: { type: String, enum: ["company"], default: "company", required: true, unique: true },
    name: { type: String, trim: true, default: DEFAULT_COMPANY_NAME, maxlength: COMPANY_SETTINGS_LIMITS.nameMax },
    email: { type: String, trim: true, lowercase: true, default: "", maxlength: COMPANY_SETTINGS_LIMITS.emailMax },
    phone: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.phoneMax },
    website: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.urlMax },
    logo: { type: logoSchema, default: null },
    address: { type: addressSchema, default: () => ({}) },
    timezone: { type: String, required: true },
    dateFormat: { type: String, enum: DATE_FORMATS, default: "DD-MM-YYYY" },
    timeFormat: { type: String, enum: TIME_FORMATS, default: "12h" },
    weekStart: { type: String, enum: WEEK_STARTS, default: "monday" },
    currency: {
      code: { type: String, default: "INR", match: /^[A-Z]{3}$/ },
      symbol: { type: String, default: "₹", maxlength: COMPANY_SETTINGS_LIMITS.currencySymbolMax },
    },
    appUrl: { type: String, trim: true, maxlength: COMPANY_SETTINGS_LIMITS.urlMax },
  },
  { timestamps: true }
);

companySettingsSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.key;
    return json;
  },
});

export const CompanySettings = mongoose.model<ICompanySettings>("CompanySettings", companySettingsSchema);
