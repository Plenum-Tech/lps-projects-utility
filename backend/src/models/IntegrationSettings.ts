import mongoose, { Schema } from "mongoose";

// ---------------------------------------------------------------------------
// Integration settings — one document per integration (`key`), created lazily
// the first time an admin saves. Only "pearity" exists today.
// ---------------------------------------------------------------------------

export const INTEGRATION_KEYS = ["pearity"] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export const INTEGRATION_LIMITS = {
  templateMax: 2000,
  allowedIpsMax: 50,
  allowedIpMax: 64,
} as const;

export interface IIntegrationSettings extends mongoose.Document {
  key: IntegrationKey;
  enabled: boolean;
  /** https:// URL with {tagNo},{tagId},{tagName},{taskId},{taskCode},{taskNo},{brand},{category},{project}. */
  engineUrlTemplate: string;
  /** Optional https:// URL a tag opens in Pearity (same placeholders). Empty = use engineUrlTemplate. */
  tagUrlTemplate: string;
  /** Optional allowlist for the server-to-server API (IPs or IPv4/IPv6 CIDR). Empty = any. */
  allowedIps: string[];
  updatedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const integrationSettingsSchema = new Schema<IIntegrationSettings>(
  {
    key: { type: String, enum: INTEGRATION_KEYS, required: true },
    enabled: { type: Boolean, default: false },
    engineUrlTemplate: { type: String, trim: true, maxlength: INTEGRATION_LIMITS.templateMax, default: "" },
    tagUrlTemplate: { type: String, trim: true, maxlength: INTEGRATION_LIMITS.templateMax, default: "" },
    allowedIps: {
      type: [{ type: String, trim: true, maxlength: INTEGRATION_LIMITS.allowedIpMax }],
      default: [],
      validate: {
        validator: (v: unknown[]) => v.length <= INTEGRATION_LIMITS.allowedIpsMax,
        message: `At most ${INTEGRATION_LIMITS.allowedIpsMax} allowed IPs`,
      },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

integrationSettingsSchema.index({ key: 1 }, { unique: true, name: "key_unique" });

integrationSettingsSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const IntegrationSettings = mongoose.model<IIntegrationSettings>(
  "IntegrationSettings",
  integrationSettingsSchema
);
