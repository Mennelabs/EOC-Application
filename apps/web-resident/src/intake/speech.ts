/**
 * Dictation through the browser's speech recognition where it exists
 * (INT-12); nothing is sent anywhere by this module, and the flow works the
 * same without it (AC-A06).
 */
interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function ctor(): RecognitionCtor | null {
  const w = globalThis as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function dictationAvailable(): boolean {
  return ctor() !== null;
}

export interface Dictation {
  stop(): void;
}

export function startDictation(
  locale: string,
  onText: (text: string, final: boolean) => void,
  onEnd: () => void,
): Dictation | null {
  const C = ctor();
  if (!C) return null;
  const r = new C();
  r.lang = locale.startsWith('es') ? 'es-US' : 'en-US';
  r.interimResults = true;
  r.continuous = true;
  r.onresult = (e) => {
    let text = '';
    for (let i = 0; i < e.results.length; i++) text += e.results[i]?.[0]?.transcript ?? '';
    onText(text.trim(), false);
  };
  r.onerror = () => onEnd();
  r.onend = () => onEnd();
  try {
    r.start();
  } catch {
    return null;
  }
  return { stop: () => r.stop() };
}
