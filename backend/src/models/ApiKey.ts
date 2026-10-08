import mongoose, { Schema } from "mongoose";
import type { IntegrationKey } from "./IntegrationSettings.js";
import { INTEGRATION_KEYS } from "./IntegrationSettings.js";

// ---------------------------------------------------------------------------
// Server-to-server API keys. The plaintext key is shown once on create; only
// its SHA-256 hash is stored. `prefix` (the first 12 characters, e.g.
// "pty_AbCd1234") is kept for display and for the lookup before the
// constant-time hash comparison (lib/apiKeys.ts).
// ---------------------------------------------------------------------------

export const API_KEY_SCOPES = ["pearity:read", "pearity:tags"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface IApiKey extends mongoose.Document {
  integration: IntegrationKey;
  name: string;
  prefix: string;
  /** Hex SHA-256 of the full key. */
  hash: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  lastUsedIp?: string | null;
  createdBy: mongoose.Types.ObjectId | null;
  revokedAt: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKey>(
  {
    integration: { type: String, enum: INTEGRATION_KEYS, required: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    prefix: { type: String, required: true },
    hash: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    scopes: {
      type: [{ type: String, enum: API_KEY_SCOPES }],
      validate: { validator: (v: unknown[]) => v.length >= 1, message: "Pick at least one scope" },
    },
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

apiKeySchema.index({ hash: 1 }, { unique: true, name: "hash_unique" });
apiKeySchema.index({ prefix: 1 });
apiKeySchema.index({ integration: 1, createdAt: -1 });

// The hash never leaves the server.
apiKeySchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    delete json.hash;
    return json;
  },
});

export const ApiKey = mongoose.model<IApiKey>("ApiKey", apiKeySchema);

// ---------------------------------------------------------------------------
// One row per server-to-server API call (kept 90 days). Never stores the key,
// only its id/prefix.
// ---------------------------------------------------------------------------

export interface IApiAuditLog extends mongoose.Document {
  integration: IntegrationKey;
  apiKey: mongoose.Types.ObjectId | null;
  keyPrefix: string;
  method: string;
  path: string;
  email: string;
  status: number;
  /** Machine-readable error code for rejected calls. */
  code: string;
  ip: string;
  ms: number;
  at: Date;
}

const apiAuditLogSchema = new Schema<IApiAuditLog>({
  integration: { type: String, enum: INTEGRATION_KEYS, required: true },
  apiKey: { type: Schema.Types.ObjectId, ref: "ApiKey", default: null },
  keyPrefix: { type: String, default: "" },
  method: { type: String, default: "" },
  path: { type: String, default: "", maxlength: 300 },
  email: { type: String, default: "", maxlength: 254 },
  status: { type: Number, default: 0 },
  code: { type: String, default: "" },
  ip: { type: String, default: "" },
  ms: { type: Number, default: 0 },
  at: { type: Date, default: () => new Date() },
});

apiAuditLogSchema.index({ at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60, name: "at_ttl" });
apiAuditLogSchema.index({ apiKey: 1, at: -1 });

export const ApiAuditLog = mongoose.model<IApiAuditLog>("ApiAuditLog", apiAuditLogSchema);
