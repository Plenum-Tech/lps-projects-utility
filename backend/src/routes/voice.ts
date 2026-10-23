import { Router } from "express";
import { transcribeVoice, understandVoice, uploadAudioMiddleware } from "../controllers/voice.js";
import { voiceRateLimit } from "../middlewares/rateLimit.js";
import { requireAuth } from "../middlewares/requireAuth.js";

// /api/voice — the voice task assistant (staff only; nothing here saves anything).
const router = Router();
router.use(requireAuth);

// Recording → text (OpenAI speech-to-text; 503 voice_unavailable without OPENAI_API_KEY).
router.post("/transcribe", voiceRateLimit, uploadAudioMiddleware, transcribeVoice);
// The conversation so far → the draft, what's missing, the next question or the summary card.
router.post("/understand", voiceRateLimit, understandVoice);

export default router;
