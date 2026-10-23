import { useCallback, useEffect, useRef, useState } from "react";

/** Why recording couldn't start. */
export type RecorderError = "unsupported" | "denied" | "failed";

/** Opus in WebM (Chrome, Firefox, Edge); MP4 / AAC on Safari; else the browser's default. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

/**
 * Short voice notes with MediaRecorder: start() asks for the microphone (the
 * browser prompts the first time), stop() hands the recording to `onDone`.
 * Stops on its own after `maxSeconds`. Exposes the elapsed seconds and a 0–1
 * input level for the wave animation. Nothing is kept after `onDone`.
 */
export function useRecorder({ maxSeconds, onDone }: { maxSeconds: number; onDone: (audio: Blob) => void }) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const frameRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const discardRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    void audioRef.current?.close().catch(() => undefined);
    audioRef.current = null;
    setRecording(false);
    setLevel(0);
  }, []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  /** Throws a RecorderError when the browser can't record or the microphone is blocked. */
  const start = useCallback(async () => {
    if (recorderRef.current?.state === "recording") return;
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      throw "unsupported" satisfies RecorderError;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      throw (name === "NotAllowedError" || name === "SecurityError" ? "denied" : "failed") satisfies RecorderError;
    }
    streamRef.current = stream;
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      cleanup();
      throw "unsupported" satisfies RecorderError;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || "audio/webm";
      cleanup();
      recorderRef.current = null;
      if (discardRef.current) {
        discardRef.current = false;
        return;
      }
      const audio = new Blob(chunks, { type });
      if (audio.size > 0) onDoneRef.current(audio);
    };
    recorderRef.current = recorder;
    recorder.start(250);
    setRecording(true);
    setSeconds(0);

    // Input level for the wave (no audio leaves the analyser).
    try {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        const audio = new AudioCtx();
        audioRef.current = audio;
        const analyser = audio.createAnalyser();
        analyser.fftSize = 256;
        audio.createMediaStreamSource(stream).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += ((v - 128) / 128) ** 2;
          setLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
          frameRef.current = requestAnimationFrame(tick);
        };
        tick();
      }
    } catch {
      // The level is decoration only.
    }

    const startedAt = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(elapsed);
      if (elapsed >= maxSeconds) stop();
    }, 250);
  }, [cleanup, maxSeconds, stop]);

  /** Stops without handing anything over (sheet closed, page left). */
  const cancel = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      discardRef.current = true;
      recorderRef.current.stop();
    } else cleanup();
  }, [cleanup]);

  useEffect(() => cancel, [cancel]);

  return { recording, seconds, level, start, stop, cancel };
}
