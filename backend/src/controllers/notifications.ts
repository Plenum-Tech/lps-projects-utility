import type { Request, Response } from "express";
import mongoose from "mongoose";
import { parsePagination } from "../lib/pagination.js";
import { registerSSEClient } from "../lib/notifications.js";
import { Notification } from "../models/Notification.js";

const ACTOR_SELECT = "name";

function isInvalidObjectId(id: string): boolean {
  return !mongoose.isValidObjectId(id);
}

/** Express 5 types params as `string | string[] | undefined` — normalize to a single id. */
function paramId(req: Request): string | undefined {
  const id = req.params.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * GET /api/notifications
 * Current user's notifications, newest first, with pagination.
 */
export async function listNotifications(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const { limit, offset } = parsePagination(req);

  const filter = { recipient: user._id };

  let query = Notification.find(filter)
    .populate("actor", ACTOR_SELECT)
    .sort({ createdAt: -1 });
  if (limit !== null) {
    query = query.skip(offset).limit(limit);
  }

  const [notifications, total] = await Promise.all([
    query,
    Notification.countDocuments(filter),
  ]);

  res.json({
    notifications: notifications.map((n) => n.toJSON()),
    total,
    limit,
    offset,
  });
}

/**
 * GET /api/notifications/unread-count
 * Returns the count of unread notifications for the current user.
 */
export async function unreadCount(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const count = await Notification.countDocuments({
    recipient: user._id,
    read: false,
  });
  res.json({ count });
}

/**
 * PATCH /api/notifications/:id/read
 * Mark a single notification as read.
 */
export async function markAsRead(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const id = paramId(req);
  if (!id || isInvalidObjectId(id)) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  const notification = await Notification.findOneAndUpdate(
    { _id: id, recipient: user._id },
    { read: true },
    { new: true }
  );

  if (!notification) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }

  res.json({ notification: notification.toJSON() });
}

/**
 * POST /api/notifications/read-all
 * Mark all current user's notifications as read.
 */
export async function markAllAsRead(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  await Notification.updateMany(
    { recipient: user._id, read: false },
    { read: true }
  );
  res.json({ message: "All notifications marked as read" });
}

/**
 * GET /api/notifications/stream
 * SSE endpoint — keeps the connection open and pushes new notifications
 * in real-time as they are created.
 */
export function streamNotifications(req: Request, res: Response): void {
  const user = req.user!;

  // Set SSE headers.
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Initial comment establishes the stream; `retry` sets the browser's reconnect delay.
  res.write("retry: 5000\n:ok\n\n");

  // Register this client for push updates (lib/sse.ts sends the shared 25 s heartbeat).
  const unregister = registerSSEClient(user._id.toString(), res);

  // Clean up on client disconnect.
  req.on("close", unregister);
}
