/**
 * Dictation (INT-12, AIG-06, AIG-10, AC-A06): the resident records a short
 * clip on this device; it goes to the county's own AI service, which writes
 * the words down, and they come back into the text box to read and change.
 * The browser's built-in speech recognition is not used: in Chrome it streams
 * the audio to Google and in Safari to Apple, outside the county's provider
 * terms. Nothing is kept on the device, and the step works the same without it.
 */

/** The longest clip, in seconds; recording stops by itself after it. */
export const MAX_SECONDS = 120;

const TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

export function recordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

export interface Recording {
  /** Ends the clip; null when nothing was recorded or it was cancelled. */
  stop(): Promise<{ blob: Blob; type: string } | null>;
  /** Ends it and throws the sound away. */
  cancel(): void;
}

/** Starts recording; throws when the microphone is refused or missing. */
export async function startRecording(onLimit: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = TYPES.find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  const release = () => stream.getTracks().forEach((t) => t.stop());
  const limit = setTimeout(onLimit, MAX_SECONDS * 1000);
  let cancelled = false;
  recorder.start();
  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      release();
      if (cancelled || chunks.length === 0) return null;
      const blobType = recorder.mimeType || type || 'audio/webm';
      return { blob: new Blob(chunks, { type: blobType }), type: blobType };
    },
    cancel() {
      cancelled = true;
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      release();
      chunks.length = 0;
    },
  };
}
