import type { Request, Response } from "express";
import mongoose from "mongoose";
import { deleteFromGridFs, openGridFsDownload, uploadToGridFs } from "../lib/gridfs.js";
import { notifyUsers } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import {
  canContribute,
  canManageProject,
  ensureNotArchived,
  getProjectOr404,
  getViewableProjectOr404,
  isInvalidObjectId,
  param,
  projectLink,
  pushProjectUpdate,
  recordProjectActivity,
} from "../lib/projectAccess.js";
import type { IProject } from "../models/Project.js";
import { PROJECT_FILE_LIMITS, ProjectFile } from "../models/ProjectFile.js";
import type { IProjectFile } from "../models/ProjectFile.js";

// Uploads reuse the task-file multer middleware (same 10 MB / type rules):
// see `uploadTaskFilesMiddleware` in controllers/taskFiles.ts, mounted in routes/projects.ts.

const FILE_POPULATE = { path: "uploadedBy", select: "name email" };

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function getFileOr404(req: Request, res: Response, project: IProject): Promise<IProjectFile | undefined> {
  const fid = param(req, "fid");
  const file = fid && !isInvalidObjectId(fid) ? await ProjectFile.findOne({ _id: fid, project: project._id }) : null;
  if (!file) {
    res.status(404).json({ error: "File not found" });
    return undefined;
  }
  return file;
}

/** GET /api/projects/:id/files — newest first. */
export async function listProjectFiles(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const { limit, offset } = parsePagination(req);
  const filter = { project: project._id };
  let query = ProjectFile.find(filter).populate(FILE_POPULATE).sort({ createdAt: -1 });
  if (limit !== null) query = query.skip(offset).limit(limit);
  const [files, total] = await Promise.all([query, ProjectFile.countDocuments(filter)]);
  const user = req.user!;
  const manage = canManageProject(user, project);
  res.json({
    files: files.map((f) => ({
      ...(f.toJSON() as unknown as Record<string, unknown>),
      canDelete: !project.archivedAt && (manage || f.uploadedBy._id.equals(user._id)),
    })),
    total,
    limit,
    offset,
  });
}

/** POST /api/projects/:id/files — multipart field `files` (max 50 per project, 10 MB each). */
export async function uploadProjectFiles(req: Request, res: Response): Promise<void> {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const user = req.user!;
  if (!canContribute(user, project)) {
    res.status(403).json({ error: "Only project members can upload files" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;

  const incoming = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (incoming.length === 0) {
    res.status(400).json({ error: 'No files uploaded — send multipart/form-data with a "files" field' });
    return;
  }
  const existing = await ProjectFile.countDocuments({ project: project._id });
  if (existing + incoming.length > PROJECT_FILE_LIMITS.maxFilesPerProject) {
    res.status(413).json({
      error: `A project can have at most ${PROJECT_FILE_LIMITS.maxFilesPerProject} files (${existing} already uploaded)`,
    });
    return;
  }

  const projectId = project._id as mongoose.Types.ObjectId;
  const created: IProjectFile[] = [];
  for (const file of incoming) {
    const filename = file.originalname.slice(0, 255) || "file";
    const gridFsId = await uploadToGridFs(file.buffer, filename, {
      project: projectId,
      contentType: file.mimetype,
      uploadedBy: user._id,
    });
    created.push(
      await ProjectFile.create({
        project: projectId,
        uploadedBy: user._id,
        filename,
        mimeType: file.mimetype,
        size: file.size,
        gridFsId,
      })
    );
  }

  recordProjectActivity(projectId, user, "file_added", { files: created.map((f) => f.filename) });
  const names = created.map((f) => f.filename);
  notifyUsers({
    recipients: [...(project.manager ? [project.manager] : []), ...project.members.map((m) => m.user)],
    actor: user,
    type: "project_file",
    title: "New project file",
    message: `${user.name} uploaded ${names.length === 1 ? `"${names[0]}"` : `${names.length} files`} to ${project.code} · ${project.name}.`,
    link: projectLink(projectId, "files"),
    project: projectId,
    email: {
      subject: `📎 ${project.name}: ${names.length === 1 ? names[0] : `${names.length} new files`}`,
      heading: "New Project File",
      intro: `${user.name} uploaded ${names.length === 1 ? "a file" : `${names.length} files`} to ${project.code} · ${project.name}.`,
      cardTitle: names.slice(0, 10).join(", "),
      buttonLabel: "Open Files",
    },
  });
  pushProjectUpdate(project, "file-added", { fileIds: created.map((f) => f._id.toString()) });

  const populated = await ProjectFile.find({ _id: { $in: created.map((f) => f._id) } })
    .populate(FILE_POPULATE)
    .sort({ createdAt: -1 });
  res.status(201).json({ files: populated.map((f) => ({ ...(f.toJSON() as unknown as Record<string, unknown>), canDelete: true })) });
}

/** GET /api/projects/:id/files/:fid — streams the file as an attachment. */
export async function downloadProjectFile(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const file = await getFileOr404(req, res, project);
  if (!file) return;

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader("Content-Disposition", contentDisposition(file.filename));
  res.setHeader("X-Content-Type-Options", "nosniff");

  await new Promise<void>((resolve) => {
    const stream = openGridFsDownload(file.gridFsId);
    stream.once("error", (err) => {
      console.error("[project-files] Download failed", file._id.toString(), err.message);
      if (!res.headersSent) {
        res.removeHeader("Content-Disposition");
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

/** DELETE /api/projects/:id/files/:fid — uploader or project manager/admin. */
export async function deleteProjectFile(req: Request, res: Response): Promise<void> {
  const project = await getViewableProjectOr404(req, res);
  if (!project) return;
  const file = await getFileOr404(req, res, project);
  if (!file) return;
  const user = req.user!;
  if (!file.uploadedBy.equals(user._id) && !canManageProject(user, project)) {
    res.status(403).json({ error: "You can only delete files you uploaded" });
    return;
  }
  if (!ensureNotArchived(project, res)) return;
  await file.deleteOne();
  await deleteFromGridFs(file.gridFsId);
  recordProjectActivity(project._id as mongoose.Types.ObjectId, user, "file_removed", { filename: file.filename });
  pushProjectUpdate(project, "file-removed", { fileId: file._id.toString() });
  res.json({ success: true });
}
