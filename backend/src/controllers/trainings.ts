import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { logActivity } from "../lib/activityLog.js";
import { genericEmailTemplate, sendBatchEmails } from "../lib/email.js";
import {
  deleteFromGridFs,
  openGridFsDownload,
  uploadToGridFs,
} from "../lib/gridfs.js";
import { notifyBatch } from "../lib/notifications.js";
import {
  SLIDE_DECK_EXTENSIONS,
  SlideConversionError,
  convertDeckToSlides,
} from "../lib/slideConvert.js";
import { parseDateOnly } from "../lib/taskAccess.js";
import { Department } from "../models/Department.js";
import type { ITraining } from "../models/Training.js";
import { Training, TrainingProgress } from "../models/Training.js";
import type { IUser } from "../models/User.js";
import { User } from "../models/User.js";

// ---------------------------------------------------------------------------
// HR trainings: admins upload a deck and assign it; assignees read every slide
// and then confirm completion (terms-style acknowledgement).
// ---------------------------------------------------------------------------

export const TRAINING_FILES_BUCKET = "trainingFiles";
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

class UnsupportedTypeError extends Error {}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (SLIDE_DECK_EXTENSIONS.has(extensionOf(file.originalname)))
      cb(null, true);
    else
      cb(
        new UnsupportedTypeError(
          "Upload a PowerPoint (.pptx, .ppt), OpenDocument (.odp) or PDF file",
        ),
      );
  },
});

function extensionOf(filename: string): string {
  return filename.split(".").pop()?.toLowerCase() ?? "";
}

/** Optional single `file` field (multipart). 413 for size, 415 for type. */
export function uploadTrainingFileMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof UnsupportedTypeError) {
      res.status(415).json({ error: err.message });
      return;
    }
    if (err instanceof multer.MulterError) {
      res
        .status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400)
        .json({
          error:
            err.code === "LIMIT_FILE_SIZE"
              ? "Files must be 50 MB or smaller"
              : err.message,
        });
      return;
    }
    next(err);
  });
}

function paramId(req: Request, name = "id"): string | undefined {
  const id = req.params[name];
  return typeof id === "string" && mongoose.isValidObjectId(id)
    ? id
    : undefined;
}

/** Mongo filter for the trainings a user is assigned to. */
function assignedFilter(user: IUser): Record<string, unknown> {
  const or: Record<string, unknown>[] = [
    { assignAll: true },
    { users: user._id },
  ];
  if (user.department) or.push({ departments: user.department });
  return { $or: or };
}

function isAssigned(training: ITraining, user: IUser): boolean {
  if (training.assignAll) return true;
  if (
    training.users.some((id) => id.equals(user._id as mongoose.Types.ObjectId))
  )
    return true;
  return Boolean(
    user.department &&
    training.departments.some((id) => id.equals(user.department!)),
  );
}

/** Users a training is assigned to (current members of its departments). */
async function assigneesOf(training: ITraining) {
  const filter = training.assignAll
    ? {}
    : {
        $or: [
          { _id: { $in: training.users } },
          { department: { $in: training.departments } },
        ],
      };
  return User.find(filter)
    .select("name email role department designation")
    .populate("department", "name")
    .sort({ name: 1 });
}

function summary(training: ITraining) {
  return {
    _id: training._id,
    title: training.title,
    description: training.description,
    slideCount: training.slides.length,
    dueDate: training.dueDate ?? null,
    version: training.version,
    archived: training.archived,
    mandatory: Boolean(training.mandatory),
    completeWithinDays: training.completeWithinDays ?? 3,
    sourceFile: {
      filename: training.sourceFile.filename,
      size: training.sourceFile.size,
    },
    assignAll: training.assignAll,
    departments: training.departments,
    users: training.users,
    createdAt: training.createdAt,
    updatedAt: training.updatedAt,
  };
}

function progressView(
  training: ITraining,
  progress: {
    viewed: number[];
    startedAt?: Date | null;
    completedAt?: Date | null;
  } | null,
) {
  const viewed = (progress?.viewed ?? []).filter(
    (n) => n >= 1 && n <= training.slides.length,
  );
  const completedAt = progress?.completedAt ?? null;
  return {
    viewed: [...new Set(viewed)].sort((a, b) => a - b),
    viewedCount: new Set(viewed).size,
    startedAt: progress?.startedAt ?? null,
    completedAt,
    status: completedAt
      ? "completed"
      : viewed.length > 0
        ? "in_progress"
        : "not_started",
  };
}

async function loadForUser(
  req: Request,
  res: Response,
): Promise<ITraining | undefined> {
  const id = paramId(req);
  const training = id ? await Training.findById(id) : null;
  const user = req.user!;
  if (
    !training ||
    (user.role !== "admin" &&
      (training.archived || !isAssigned(training, user)))
  ) {
    res.status(404).json({ error: "Training not found" });
    return undefined;
  }
  return training;
}

// --- Assignment input ------------------------------------------------------

interface AssignmentInput {
  assignAll: boolean;
  departments: mongoose.Types.ObjectId[];
  users: mongoose.Types.ObjectId[];
}

/** Multipart sends arrays as JSON strings; JSON bodies send real arrays. */
function idList(value: unknown): string[] | null {
  if (value === undefined) return [];
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = value.trim() === "" ? [] : JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every(
      (id) => typeof id === "string" && mongoose.isValidObjectId(id),
    )
  ) {
    return null;
  }
  return [...new Set(parsed as string[])];
}

function boolField(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

async function parseAssignment(
  body: Record<string, unknown>,
): Promise<AssignmentInput | string> {
  const assignAll = boolField(body.assignAll) ?? false;
  const departments = idList(body.departments);
  const users = idList(body.users);
  if (!departments || !users)
    return "departments and users must be lists of ids";
  if (!assignAll && departments.length === 0 && users.length === 0) {
    return "Assign the training to everyone, departments or people";
  }
  const [deptCount, userCount] = await Promise.all([
    Department.countDocuments({ _id: { $in: departments } }),
    User.countDocuments({ _id: { $in: users } }),
  ]);
  if (deptCount !== departments.length)
    return "A selected department no longer exists";
  if (userCount !== users.length) return "A selected person no longer exists";
  return {
    assignAll,
    departments: assignAll
      ? []
      : departments.map((id) => new mongoose.Types.ObjectId(id)),
    users: assignAll ? [] : users.map((id) => new mongoose.Types.ObjectId(id)),
  };
}

function parseText(value: unknown, max: number): string | null {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.trim().length > max) return null;
  return value.trim();
}

/** Converts the uploaded deck and stores the slides + original file. */
async function storeDeck(file: Express.Multer.File, actor: IUser) {
  const slidesPng = await convertDeckToSlides(
    file.buffer,
    extensionOf(file.originalname),
  );
  const meta = { uploadedBy: actor._id };
  const slideIds: mongoose.Types.ObjectId[] = [];
  try {
    for (const [index, png] of slidesPng.entries()) {
      slideIds.push(
        await uploadToGridFs(
          png,
          `slide-${index + 1}.png`,
          meta,
          TRAINING_FILES_BUCKET,
        ),
      );
    }
    const sourceId = await uploadToGridFs(
      file.buffer,
      file.originalname,
      meta,
      TRAINING_FILES_BUCKET,
    );
    return {
      slides: slideIds,
      sourceFile: {
        fileId: sourceId,
        filename: file.originalname,
        mimeType: file.mimetype || "application/octet-stream",
        size: file.size,
      },
    };
  } catch (err) {
    await Promise.all(
      slideIds.map((id) => deleteFromGridFs(id, TRAINING_FILES_BUCKET)),
    );
    throw err;
  }
}

async function deleteDeckFiles(
  slides: mongoose.Types.ObjectId[],
  sourceId?: mongoose.Types.ObjectId,
) {
  await Promise.all(
    [...slides, ...(sourceId ? [sourceId] : [])].map((id) =>
      deleteFromGridFs(id, TRAINING_FILES_BUCKET),
    ),
  );
}

function conversionErrorResponse(res: Response, err: unknown): boolean {
  if (err instanceof SlideConversionError) {
    res.status(err.unavailable ? 501 : 422).json({ error: err.message });
    return true;
  }
  return false;
}

async function notifyAssigned(
  training: ITraining,
  actor: IUser,
  title: string,
  message: string,
  onlyPending = false,
) {
  let recipients = (await assigneesOf(training)).map(
    (user) => user._id as mongoose.Types.ObjectId,
  );
  if (onlyPending) {
    const done = await TrainingProgress.find({
      training: training._id,
      completedAt: { $ne: null },
    }).distinct("user");
    const doneSet = new Set(done.map((id) => id.toString()));
    recipients = recipients.filter((id) => !doneSet.has(id.toString()));
  }
  recipients = recipients.filter(
    (id) => !id.equals(actor._id as mongoose.Types.ObjectId),
  );
  if (recipients.length === 0) return 0;
  notifyBatch(recipients, {
    actor,
    type: onlyPending ? "training_reminder" : "training_assigned",
    title,
    message,
    link: `/training/${training._id.toString()}`,
  });
  return recipients.length;
}

// --- Employee endpoints ----------------------------------------------------

/** GET /api/trainings/mine — trainings assigned to me, with my progress. */
/** completeWithinDays: whole number 1..60 (default 3 when absent). */
function parseDays(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return 3;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : null;
}

/** HR recipients: HR_EMAILS (comma-separated) or every admin. */
async function hrRecipients(): Promise<string[]> {
  const configured = (process.env.HR_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  const admins = await User.find({ role: "admin" }).select("email").lean();
  return admins.map((a) => a.email).filter(Boolean);
}

/** Emails HR that someone completed a training. Never throws. */
async function notifyHrOfCompletion(user: IUser, training: ITraining, completedAt: Date): Promise<void> {
  try {
    const recipients = (await hrRecipients()).filter((e) => e.toLowerCase() !== user.email.toLowerCase());
    if (recipients.length === 0) return;
    const department = user.department ? await Department.findById(user.department).select("name").lean() : null;
    const when = completedAt.toLocaleString("en-GB", { timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
    await sendBatchEmails(
      recipients.map((to) => ({
        to,
        subject: `Training completed: ${training.title} — ${user.name}`,
        html: genericEmailTemplate({
          firstName: "HR team",
          heading: "Training completed",
          intro: `${user.name} completed the training "${training.title}".`,
          cardTitle: training.title,
          rows: [
            ["Employee", user.name],
            ["Email", user.email],
            ["Department", department?.name ?? "—"],
            ["Completed on", when],
            ["Slides read", String(training.slides.length)],
          ],
          path: `/training?tab=manage`,
          buttonLabel: "Open training progress",
        }),
      }))
    );
  } catch (err) {
    console.error("[training] HR completion email failed", err instanceof Error ? err.message : err);
  }
}

/**
 * GET /api/trainings/required — mandatory trainings this person hasn't completed,
 * with their deadline (first time shown + completeWithinDays). Starts the clock
 * the first time a training is returned here.
 */
export async function listRequiredTrainings(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const trainings = await Training.find({ archived: false, mandatory: true, ...assignedFilter(user) }).sort({ createdAt: 1 });
  if (trainings.length === 0) {
    res.json({ trainings: [] });
    return;
  }
  const now = new Date();
  for (const t of trainings) {
    await TrainingProgress.updateOne(
      { training: t._id, user: user._id },
      { $setOnInsert: { version: t.version, viewed: [], firstSeenAt: now } },
      { upsert: true }
    );
  }
  await TrainingProgress.updateMany(
    { user: user._id, training: { $in: trainings.map((t) => t._id) }, firstSeenAt: null },
    { $set: { firstSeenAt: now } }
  );
  const progress = await TrainingProgress.find({ user: user._id, training: { $in: trainings.map((t) => t._id) } });
  const byTraining = new Map(progress.map((p) => [p.training.toString(), p]));
  const rows = trainings.flatMap((t) => {
    const p = byTraining.get(t._id.toString()) ?? null;
    if (p?.completedAt) return [];
    const firstSeen = p?.firstSeenAt ?? now;
    const deadline = new Date(firstSeen.getTime() + (t.completeWithinDays ?? 3) * 86_400_000);
    const view = progressView(t, p);
    return [
      {
        ...summary(t),
        firstSeenAt: firstSeen,
        deadline,
        overdue: now.getTime() > deadline.getTime(),
        viewedCount: view.viewedCount,
      },
    ];
  });
  res.json({ trainings: rows });
}

export async function listMyTrainings(
  req: Request,
  res: Response,
): Promise<void> {
  const user = req.user!;
  const trainings = await Training.find({
    archived: false,
    ...assignedFilter(user),
  }).sort({ createdAt: -1 });
  const progress = await TrainingProgress.find({
    user: user._id,
    training: { $in: trainings.map((t) => t._id) },
  });
  const byTraining = new Map(progress.map((p) => [p.training.toString(), p]));
  res.json({
    trainings: trainings.map((training) => {
      const view = progressView(
        training,
        byTraining.get(training._id.toString()) ?? null,
      );
      const { viewed: _viewed, ...rest } = view;
      return { ...summary(training), progress: rest };
    }),
  });
}

/** GET /api/trainings/:id — one training with my progress. */
export async function getTraining(req: Request, res: Response): Promise<void> {
  const training = await loadForUser(req, res);
  if (!training) return;
  const progress = await TrainingProgress.findOne({
    training: training._id,
    user: req.user!._id,
  });
  res.json({
    training: summary(training),
    assigned: isAssigned(training, req.user!),
    progress: progressView(training, progress),
  });
}

/** GET /api/trainings/:id/slides/:n — slide image (1-based). */
export async function getSlide(req: Request, res: Response): Promise<void> {
  const training = await loadForUser(req, res);
  if (!training) return;
  const n = Number(req.params.n);
  const slideId = Number.isInteger(n) ? training.slides[n - 1] : undefined;
  if (!slideId) {
    res.status(404).json({ error: "Slide not found" });
    return;
  }
  res.setHeader("Content-Type", "image/png");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Slide ids change when the deck is replaced (the URL carries ?v=version).
  res.setHeader("Cache-Control", "private, max-age=86400");
  await pipeFile(res, slideId);
}

/** GET /api/trainings/:id/source — the original deck. */
export async function downloadSource(
  req: Request,
  res: Response,
): Promise<void> {
  const training = await loadForUser(req, res);
  if (!training) return;
  const { filename, mimeType, size, fileId } = training.sourceFile;
  const fallback = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Length", String(size));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  await pipeFile(res, fileId);
}

function pipeFile(res: Response, id: mongoose.Types.ObjectId): Promise<void> {
  return new Promise<void>((resolve) => {
    const stream = openGridFsDownload(id, TRAINING_FILES_BUCKET);
    stream.once("error", () => {
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Length");
        res.removeHeader("Cache-Control");
        res.status(404).json({ error: "File content not found" });
      } else {
        res.end();
      }
      resolve();
    });
    stream.once("end", () => resolve());
    stream.pipe(res);
  });
}

/** POST /api/trainings/:id/progress { slides: number[] } — records slides seen. */
export async function recordProgress(
  req: Request,
  res: Response,
): Promise<void> {
  const training = await loadForUser(req, res);
  if (!training) return;
  if (!isAssigned(training, req.user!)) {
    res.status(403).json({ error: "This training isn't assigned to you" });
    return;
  }
  const raw = (req.body as { slides?: unknown })?.slides;
  const slides = Array.isArray(raw) ? raw : [];
  if (
    slides.length === 0 ||
    slides.length > training.slides.length ||
    !slides.every(
      (n) => Number.isInteger(n) && n >= 1 && n <= training.slides.length,
    )
  ) {
    res
      .status(400)
      .json({
        error: `slides must be slide numbers from 1 to ${training.slides.length}`,
      });
    return;
  }
  const progress = await TrainingProgress.findOneAndUpdate(
    { training: training._id, user: req.user!._id },
    {
      $addToSet: { viewed: { $each: slides as number[] } },
      $setOnInsert: { version: training.version, startedAt: new Date() },
    },
    { upsert: true, new: true },
  );
  if (progress && !progress.startedAt) {
    progress.startedAt = new Date();
    await progress.save();
  }
  res.json({ progress: progressView(training, progress) });
}

/** POST /api/trainings/:id/complete { acknowledged: true } */
export async function completeTraining(
  req: Request,
  res: Response,
): Promise<void> {
  const training = await loadForUser(req, res);
  if (!training) return;
  const user = req.user!;
  if (!isAssigned(training, user)) {
    res.status(403).json({ error: "This training isn't assigned to you" });
    return;
  }
  if ((req.body as { acknowledged?: unknown })?.acknowledged !== true) {
    res
      .status(400)
      .json({
        error: "Confirm that you have read and understood the training",
      });
    return;
  }
  const progress = await TrainingProgress.findOne({
    training: training._id,
    user: user._id,
  });
  const view = progressView(training, progress);
  if (view.completedAt) {
    res.json({ progress: view });
    return;
  }
  const left = training.slides.length - view.viewedCount;
  if (!progress || left > 0) {
    res.status(409).json({ error: `Read all slides first (${left} left)` });
    return;
  }
  progress.completedAt = new Date();
  await progress.save();
  void notifyHrOfCompletion(user, training, progress.completedAt);
  logActivity({
    action: "training_completed",
    actor: user,
    targetType: "Training",
    targetId: training._id as mongoose.Types.ObjectId,
    targetName: training.title,
    ip: req.ip,
  });
  res.json({ progress: progressView(training, progress) });
}

// --- Admin endpoints -------------------------------------------------------

/** GET /api/trainings — every training with assignment/completion counts. */
export async function listTrainings(
  req: Request,
  res: Response,
): Promise<void> {
  const includeArchived = req.query.archived === "true";
  const trainings = await Training.find(
    includeArchived ? {} : { archived: false },
  ).sort({ createdAt: -1 });
  const totalUsers = await User.countDocuments();
  const rows = await Promise.all(
    trainings.map(async (training) => {
      const assignees = training.assignAll ? null : await assigneesOf(training);
      const ids = assignees?.map((u) => u._id);
      const progressFilter = {
        training: training._id,
        ...(ids ? { user: { $in: ids } } : {}),
      };
      const [completed, started] = await Promise.all([
        TrainingProgress.countDocuments({
          ...progressFilter,
          completedAt: { $ne: null },
        }),
        TrainingProgress.countDocuments(progressFilter),
      ]);
      return {
        ...summary(training),
        stats: {
          assigned: assignees ? assignees.length : totalUsers,
          started,
          completed,
        },
      };
    }),
  );
  res.json({ trainings: rows });
}

/** POST /api/trainings (multipart: file, title, description, dueDate, assignAll, departments, users) */
export async function createTraining(
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const title = parseText(body.title, 200);
  const description = parseText(body.description, 2000);
  if (!title) {
    res.status(400).json({ error: "A title is required (max 200 characters)" });
    return;
  }
  if (description === null) {
    res
      .status(400)
      .json({ error: "Keep the description under 2000 characters" });
    return;
  }
  const dueDate = body.dueDate ? parseDateOnly(body.dueDate) : null;
  if (body.dueDate && !dueDate) {
    res.status(400).json({ error: "dueDate must be YYYY-MM-DD" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Upload the slide deck (.pptx or .pdf)" });
    return;
  }
  const assignment = await parseAssignment(body);
  if (typeof assignment === "string") {
    res.status(400).json({ error: assignment });
    return;
  }

  let deck;
  try {
    deck = await storeDeck(req.file, req.user!);
  } catch (err) {
    if (conversionErrorResponse(res, err)) return;
    throw err;
  }
  const completeWithinDays = parseDays(body.completeWithinDays);
  if (completeWithinDays === null) {
    res.status(400).json({ error: "completeWithinDays must be a whole number from 1 to 60" });
    return;
  }
  const training = await Training.create({
    title,
    description,
    dueDate,
    mandatory: boolField(body.mandatory) ?? false,
    completeWithinDays,
    ...assignment,
    ...deck,
    createdBy: req.user!._id,
  });

  logActivity({
    action: "training_created",
    actor: req.user!,
    targetType: "Training",
    targetId: training._id as mongoose.Types.ObjectId,
    targetName: training.title,
    details: { slides: training.slides.length },
    ip: req.ip,
  });
  const notified = await notifyAssigned(
    training,
    req.user!,
    "New training assigned",
    `Please read "${training.title}" (${training.slides.length} slides) and mark it as completed.`,
  );
  res.status(201).json({ training: summary(training), notified });
}

/** PATCH /api/trainings/:id (optional new file; resetProgress=true makes everyone re-read). */
export async function updateTraining(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const training = id ? await Training.findById(id) : null;
  if (!training) {
    res.status(404).json({ error: "Training not found" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;

  if (body.title !== undefined) {
    const title = parseText(body.title, 200);
    if (!title) {
      res
        .status(400)
        .json({ error: "A title is required (max 200 characters)" });
      return;
    }
    training.title = title;
  }
  if (body.description !== undefined) {
    const description = parseText(body.description, 2000);
    if (description === null) {
      res
        .status(400)
        .json({ error: "Keep the description under 2000 characters" });
      return;
    }
    training.description = description;
  }
  if (body.dueDate !== undefined) {
    const dueDate =
      body.dueDate === "" || body.dueDate === null
        ? null
        : parseDateOnly(body.dueDate);
    if (body.dueDate && !dueDate) {
      res.status(400).json({ error: "dueDate must be YYYY-MM-DD" });
      return;
    }
    training.dueDate = dueDate;
  }
  if (
    body.assignAll !== undefined ||
    body.departments !== undefined ||
    body.users !== undefined
  ) {
    const assignment = await parseAssignment(body);
    if (typeof assignment === "string") {
      res.status(400).json({ error: assignment });
      return;
    }
    training.assignAll = assignment.assignAll;
    training.departments = assignment.departments;
    training.users = assignment.users;
  }
  const archived = boolField(body.archived);
  if (archived !== undefined) training.archived = archived;
  const mandatory = boolField(body.mandatory);
  if (mandatory !== undefined) training.mandatory = mandatory;
  if (body.completeWithinDays !== undefined) {
    const days = parseDays(body.completeWithinDays);
    if (days === null) {
      res.status(400).json({ error: "completeWithinDays must be a whole number from 1 to 60" });
      return;
    }
    training.completeWithinDays = days;
  }

  let oldFiles: {
    slides: mongoose.Types.ObjectId[];
    source: mongoose.Types.ObjectId;
  } | null = null;
  const reset = boolField(body.resetProgress) ?? false;
  if (req.file) {
    let deck;
    try {
      deck = await storeDeck(req.file, req.user!);
    } catch (err) {
      if (conversionErrorResponse(res, err)) return;
      throw err;
    }
    oldFiles = {
      slides: [...training.slides],
      source: training.sourceFile.fileId,
    };
    training.slides = deck.slides;
    training.sourceFile = deck.sourceFile;
    training.version += 1;
  }

  await training.save();

  if (oldFiles) {
    if (reset) {
      await TrainingProgress.deleteMany({ training: training._id });
    } else {
      // Keep completions; anyone part-way through starts the new deck afresh.
      await Promise.all([
        TrainingProgress.updateMany(
          { training: training._id, completedAt: { $ne: null } },
          { $set: { version: training.version } },
        ),
        TrainingProgress.deleteMany({
          training: training._id,
          completedAt: null,
        }),
      ]);
    }
    await deleteDeckFiles(oldFiles.slides, oldFiles.source);
  }

  logActivity({
    action: archived === true ? "training_archived" : "training_updated",
    actor: req.user!,
    targetType: "Training",
    targetId: training._id as mongoose.Types.ObjectId,
    targetName: training.title,
    details: oldFiles ? { newDeck: true, resetProgress: reset } : undefined,
    ip: req.ip,
  });
  res.json({ training: summary(training) });
}

/** DELETE /api/trainings/:id — permanently deletes the training, its files and progress. */
export async function deleteTraining(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const training = id ? await Training.findById(id) : null;
  if (!training) {
    res.status(404).json({ error: "Training not found" });
    return;
  }
  await Promise.all([
    TrainingProgress.deleteMany({ training: training._id }),
    Training.deleteOne({ _id: training._id }),
  ]);
  await deleteDeckFiles(training.slides, training.sourceFile.fileId);
  logActivity({
    action: "training_deleted",
    actor: req.user!,
    targetType: "Training",
    targetId: training._id as mongoose.Types.ObjectId,
    targetName: training.title,
    ip: req.ip,
  });
  res.status(204).end();
}

/** GET /api/trainings/:id/progress — one row per assignee. */
export async function trainingProgress(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const training = id ? await Training.findById(id) : null;
  if (!training) {
    res.status(404).json({ error: "Training not found" });
    return;
  }
  const [assignees, progress] = await Promise.all([
    assigneesOf(training),
    TrainingProgress.find({ training: training._id }),
  ]);
  const byUser = new Map(progress.map((p) => [p.user.toString(), p]));
  const rows = assignees.map((user) => {
    const view = progressView(
      training,
      byUser.get(user._id.toString()) ?? null,
    );
    const { viewed: _viewed, ...rest } = view;
    return {
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        designation: user.designation ?? "",
        department: user.department ?? null,
      },
      ...rest,
    };
  });
  res.json({ training: summary(training), rows });
}

/** POST /api/trainings/:id/remind — in-app reminder to everyone not finished. */
export async function remindTraining(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const training = id ? await Training.findById(id) : null;
  if (!training || training.archived) {
    res.status(404).json({ error: "Training not found" });
    return;
  }
  const notified = await notifyAssigned(
    training,
    req.user!,
    "Training reminder",
    `Please finish reading "${training.title}" and mark it as completed.`,
    true,
  );
  res.json({ notified });
}
