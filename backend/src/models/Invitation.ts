import mongoose, { Schema } from "mongoose";

export const INVITATION_STATUSES = ["pending", "accepted", "revoked"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Status as shown to admins: "expired" is derived (pending + past expiresAt), never stored. */
export type InvitationState = InvitationStatus | "expired";

export const INVITATION_LIMITS = {
  maxEmails: 50,
  maxProjects: 20,
  messageMax: 500,
  /** Validity of a link from its last send. */
  ttlMs: 7 * 24 * 60 * 60 * 1000,
  /** Minimum gap between two resends of the same invite. */
  resendCooldownMs: 2 * 60 * 1000,
} as const;

export interface IInvitation extends mongoose.Document {
  email: string;
  role: "employee" | "head" | "admin";
  department?: mongoose.Types.ObjectId | null;
  projects: mongoose.Types.ObjectId[];
  message?: string;
  /** SHA-256 of the random token; the plain token is never stored or logged. */
  tokenHash: string;
  status: InvitationStatus;
  expiresAt: Date;
  invitedBy: mongoose.Types.ObjectId;
  lastSentAt: Date;
  sendCount: number;
  acceptedAt?: Date | null;
  acceptedUser?: mongoose.Types.ObjectId | null;
  revokedAt?: Date | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const invitationSchema = new Schema<IInvitation>(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email address"],
    },
    role: { type: String, enum: ["employee", "head", "admin"], default: "employee" },
    department: { type: Schema.Types.ObjectId, ref: "Department", default: null },
    projects: { type: [{ type: Schema.Types.ObjectId, ref: "Project" }], default: [] },
    message: { type: String, trim: true, maxlength: INVITATION_LIMITS.messageMax },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: INVITATION_STATUSES, default: "pending" },
    expiresAt: { type: Date, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastSentAt: { type: Date, required: true },
    sendCount: { type: Number, default: 1, min: 0 },
    acceptedAt: { type: Date, default: null },
    acceptedUser: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

invitationSchema.index({ tokenHash: 1 }, { unique: true });
// At most one open invite per email.
invitationSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { status: "pending" } }
);
invitationSchema.index({ status: 1, createdAt: -1 });

/** Derived display state ("expired" = pending past its expiry). */
export function invitationState(
  invitation: Pick<IInvitation, "status" | "expiresAt">,
  now = new Date()
): InvitationState {
  if (invitation.status === "pending" && invitation.expiresAt.getTime() < now.getTime()) {
    return "expired";
  }
  return invitation.status;
}

// Never leak the token hash or the internal version key; expose the derived state.
invitationSchema.set("toJSON", {
  transform: (doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.tokenHash;
    delete json.__v;
    const source = doc as unknown as Pick<IInvitation, "status" | "expiresAt">;
    if (source.status && source.expiresAt) json.state = invitationState(source);
    return json;
  },
});

export const Invitation = mongoose.model<IInvitation>("Invitation", invitationSchema);
