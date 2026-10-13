import mongoose, { Schema } from "mongoose";

/** External DAM / media link pushed from Pearity (not a GridFS file). */
export interface IPearityTaskAsset extends mongoose.Document {
  task: mongoose.Types.ObjectId;
  url: string;
  title?: string | null;
  mimeType?: string | null;
  damAssetId?: string | null;
  damFolderPath?: string | null;
  tagNo?: number | null;
  jobId?: string | null;
  pearityUrl?: string | null;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const pearityTaskAssetSchema = new Schema<IPearityTaskAsset>(
  {
    task: { type: Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    url: { type: String, required: true, trim: true, maxlength: 2000 },
    title: { type: String, default: null, trim: true, maxlength: 300 },
    mimeType: { type: String, default: null, trim: true, maxlength: 120 },
    damAssetId: { type: String, default: null, trim: true, maxlength: 120 },
    damFolderPath: { type: String, default: null, trim: true, maxlength: 500 },
    tagNo: { type: Number, default: null },
    jobId: { type: String, default: null, trim: true, maxlength: 120 },
    pearityUrl: { type: String, default: null, trim: true, maxlength: 2000 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

pearityTaskAssetSchema.index({ task: 1, createdAt: -1 });
pearityTaskAssetSchema.index({ damAssetId: 1 }, { sparse: true });

pearityTaskAssetSchema.set("toJSON", {
  transform: (_doc, ret) => {
    const json = ret as unknown as Record<string, unknown>;
    delete json.__v;
    return json;
  },
});

export const PearityTaskAsset = mongoose.model<IPearityTaskAsset>("PearityTaskAsset", pearityTaskAssetSchema);
