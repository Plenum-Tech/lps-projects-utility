import mongoose from "mongoose";

// ---------------------------------------------------------------------------
// GridFS buckets. Task/project attachments live in "taskFiles" (the default);
// employee documents use their own "employeeDocuments" bucket.
// ---------------------------------------------------------------------------

const DEFAULT_BUCKET = "taskFiles";

/** Bucket for EmployeeDocument files ("employeeDocuments.files" + ".chunks"). */
export const EMPLOYEE_DOCUMENTS_BUCKET = "employeeDocuments";

function getBucket(bucketName: string = DEFAULT_BUCKET): mongoose.mongo.GridFSBucket {
  const db = mongoose.connection.db;
  if (!db) throw new Error("MongoDB is not connected");
  return new mongoose.mongo.GridFSBucket(db, { bucketName });
}

/** Streams a buffer into GridFS and resolves with the new file id. */
export function uploadToGridFs(
  buffer: Buffer,
  filename: string,
  metadata: Record<string, unknown>,
  bucketName: string = DEFAULT_BUCKET
): Promise<mongoose.Types.ObjectId> {
  return new Promise((resolve, reject) => {
    const stream = getBucket(bucketName).openUploadStream(filename, { metadata });
    stream.once("error", reject);
    stream.once("finish", () => resolve(stream.id as mongoose.Types.ObjectId));
    stream.end(buffer);
  });
}

/** Opens a download stream for a stored file. */
export function openGridFsDownload(
  id: mongoose.Types.ObjectId,
  bucketName: string = DEFAULT_BUCKET
): mongoose.mongo.GridFSBucketReadStream {
  return getBucket(bucketName).openDownloadStream(id);
}

/** Deletes a file and its chunks. Missing files are ignored; never throws. */
export async function deleteFromGridFs(
  id: mongoose.Types.ObjectId,
  bucketName: string = DEFAULT_BUCKET
): Promise<void> {
  try {
    await getBucket(bucketName).delete(id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not found/i.test(message)) {
      console.error("[gridfs] Failed to delete file", id.toString(), message);
    }
  }
}
