import type { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";
import multer from "multer";
import { isGuestUser } from "../lib/guests.js";
import { audioExtension, speechPrompt, transcribe, understand, VOICE_LIMITS, voiceConfigured } from "../lib/voiceAssistant.js";

// ---------------------------------------------------------------------------
// Voice task assistant (lib/voiceAssistant.ts). Staff only — guests are
// refused by requireAuth (not in middlewares/guestAccess.ts) and again here.
// ---------------------------------------------------------------------------

const UNAVAILABLE = { error: "Voice isn't set up on this server — type instead", code: "voice_unavailable" } as const;

function refuseGuests(req: Request, res: Response): boolean {
  if (!isGuestUser(req.user)) return false;
  res.status(403).json({ error: "The voice assistant is for staff only" });
  return true;
}

// Audio is held in memory for the one OpenAI call, never written anywhere.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: VOICE_LIMITS.maxAudioBytes, files: 1 },
});

/** Multer for the `audio` field, with clean JSON errors (413 too big, 400 otherwise). */
export function uploadAudioMiddleware(req: Request, res: Response, next: NextFunction): void {
  // No key: answer before reading the upload (the app focuses the text box).
  if (!voiceConfigured()) {
    res.status(503).json(UNAVAILABLE);
    return;
  }
  upload.single("audio")(req, res, (err: unknown) => {
    if (!err) {
      next();
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Voice notes can be up to 25 MB — keep it under a minute" });
      return;
    }
    res.status(400).json({ error: "Send the recording as the multipart field \"audio\"" });
  });
}

/** POST /api/voice/transcribe — multipart `audio` → { text }. */
export async function transcribeVoice(req: Request, res: Response): Promise<void> {
  if (refuseGuests(req, res)) return;
  if (!voiceConfigured()) {
    res.status(503).json(UNAVAILABLE);
    return;
  }
  const file = req.file;
  if (!file || file.size === 0) {
    res.status(400).json({ error: "The recording was empty — try again" });
    return;
  }
  if (!audioExtension(file.mimetype)) {
    res.status(415).json({ error: "This recording format isn't supported — type instead" });
    return;
  }
  try {
    const text = await transcribe(file.buffer, file.mimetype, await speechPrompt(req.user!));
    res.json({ text });
  } catch (err) {
    // The audio and the transcript are never logged.
    console.error("[voice] transcription failed", err instanceof Error ? err.message : "error");
    res.status(502).json({ error: "Couldn't turn that into text. Try again, or type instead." });
  }
}

/**
 * POST /api/voice/understand — { messages: [{ role, text }] (≤ 20), context?: { taskId? }, draft? }
 * → { reply, chips, draft, action, missing, ready, ask, card, ai }. Nothing is saved.
 */
export async function understandVoice(req: Request, res: Response): Promise<void> {
  if (refuseGuests(req, res)) return;
  const body = (req.body ?? {}) as { messages?: unknown; context?: unknown; draft?: unknown };
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    res.status(400).json({ error: "messages must be a non-empty list of { role, text }" });
    return;
  }
  const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const m of body.messages.slice(-VOICE_LIMITS.maxMessages) as Array<{ role?: unknown; text?: unknown }>) {
    if ((m?.role !== "user" && m?.role !== "assistant") || typeof m.text !== "string") {
      res.status(400).json({ error: "Each message needs a role (user | assistant) and text" });
      return;
    }
    messages.push({ role: m.role, text: m.text.slice(0, VOICE_LIMITS.maxMessageChars) });
  }
  const context = typeof body.context === "object" && body.context !== null ? (body.context as { taskId?: unknown }) : {};
  const taskId = typeof context.taskId === "string" && mongoose.isValidObjectId(context.taskId) ? context.taskId : null;
  res.json(await understand(req.user!, messages, body.draft, taskId));
}
