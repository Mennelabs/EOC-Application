/**
 * MMS media (CHN-03): Twilio hosts the picture; the API fetches it with the
 * account credentials and stores it as a photo original under the submission
 * (PHO-05). The simulator hands pictures over as data URLs.
 */
export interface FetchedMedia {
  body: Buffer;
  contentType: string;
}

export interface MediaFetcher {
  fetch(url: string): Promise<FetchedMedia>;
}

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

export function isAllowedImage(contentType: string): boolean {
  return ALLOWED.has(contentType.toLowerCase().split(';')[0]!.trim());
}

export function dataUrlFetcher(): MediaFetcher {
  return {
    async fetch(url) {
      const m = url.match(/^data:([^;,]+);base64,(.*)$/s);
      if (!m) throw new Error('not a data URL');
      return { body: Buffer.from(m[2]!, 'base64'), contentType: m[1]! };
    },
  };
}

export function twilioMediaFetcher(
  accountSid: string,
  authToken: string,
  maxBytes: number,
  f: typeof fetch = fetch,
): MediaFetcher {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return {
    async fetch(url) {
      if (!/^https:\/\/api\.twilio\.com\//.test(url)) throw new Error('media URL is not Twilio');
      const res = await f(url, { headers: { authorization: `Basic ${auth}` }, redirect: 'follow' });
      if (!res.ok) throw new Error(`media fetch ${res.status}`);
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) throw new Error('media too large');
      return { body: bytes, contentType };
    },
  };
}
