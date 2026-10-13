/**
 * The live stream for the console (DSP-01, NFR-07, ADR-0022): Server-Sent
 * Events from GET /api/v1/stream, read with fetch so the bearer token goes in
 * a header (EventSource cannot send one). It resumes from the last event id
 * after a drop and backs off; the caller only learns "something changed" and
 * reloads what it shows, so a missed event can never leave a stale picture.
 */
import { accessToken } from '../auth/oidc.ts';

export interface StreamChange {
  seq: number;
  recordType: string;
  recordId: string;
}

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'stopped';

export function openStream(opts: {
  from: number;
  types: string[];
  onChange: (c: StreamChange) => void;
  onState: (s: StreamState) => void;
}): () => void {
  let last = opts.from;
  let stopped = false;
  let controller: AbortController | null = null;
  let delay = 1000;
  const run = async () => {
    while (!stopped) {
      opts.onState(last === opts.from ? 'connecting' : 'reconnecting');
      controller = new AbortController();
      try {
        const token = await accessToken();
        const q = new URLSearchParams({ lastEventId: String(last), types: opts.types.join(',') });
        const res = await fetch(`/api/v1/stream?${q.toString()}`, {
          headers: { authorization: `Bearer ${token ?? ''}`, accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        opts.onState('live');
        delay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            let id: number | null = null;
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) id = Number(line.slice(3).trim());
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (id !== null && Number.isFinite(id)) last = Math.max(last, id);
            if (!data) continue;
            try {
              const parsed = JSON.parse(data) as Partial<StreamChange>;
              if (parsed.recordType && parsed.recordId)
                opts.onChange({
                  seq: id ?? last,
                  recordType: parsed.recordType,
                  recordId: parsed.recordId,
                });
            } catch {
              /* a keep-alive or a message the console does not use */
            }
          }
        }
      } catch {
        if (stopped) break;
      }
      if (stopped) break;
      opts.onState('reconnecting');
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
    opts.onState('stopped');
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
