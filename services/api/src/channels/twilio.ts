/**
 * Twilio webhook security and TwiML (CHN-03/04/05, BRD:FR-17.05, docs/06).
 * Every request from Twilio carries X-Twilio-Signature: base64 of HMAC-SHA1
 * over the exact URL Twilio called plus the POST parameters sorted by name,
 * keyed with the account's auth token. Nothing is accepted without it.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function element(
  tag: string,
  attrs: Record<string, string | number | undefined> = {},
  children = '',
): string {
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeXml(String(v))}"`)
    .join('');
  return children ? `<${tag}${a}>${children}</${tag}>` : `<${tag}${a}/>`;
}

/** A text reply; several texts become several <Message> elements. */
export function twimlMessages(texts: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${texts
    .map((t) => element('Message', {}, escapeXml(t)))
    .join('')}</Response>`;
}

export function twimlVoice(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** Twilio speech and text-to-speech language tags for the launch languages. */
export function voiceLanguage(locale: string): string {
  return locale.toLowerCase().startsWith('es') ? 'es-US' : 'en-US';
}

export function say(text: string, locale: string): string {
  return element('Say', { language: voiceLanguage(locale) }, escapeXml(text));
}

/** A reference code read out letter by letter and digit by digit, twice (people write it down). */
export function sayCode(code: string, locale: string): string {
  const spelled = element(
    'say-as',
    { 'interpret-as': 'characters' },
    escapeXml(code.replace('-', ' ')),
  );
  return (
    element('Say', { language: voiceLanguage(locale) }, spelled) +
    element('Pause', { length: 1 }) +
    element('Say', { language: voiceLanguage(locale) }, spelled)
  );
}

export interface GatherOptions {
  action: string;
  locale: string;
  /** Digits only, speech only, or both. */
  input: 'dtmf' | 'speech' | 'dtmf speech';
  numDigits?: number;
  timeout?: number;
}

export function gather(opts: GatherOptions, inner: string): string {
  return element(
    'Gather',
    {
      input: opts.input,
      language: voiceLanguage(opts.locale),
      action: opts.action,
      method: 'POST',
      timeout: opts.timeout ?? 6,
      ...(opts.input !== 'dtmf' ? { speechTimeout: 'auto' } : {}),
      ...(opts.numDigits ? { numDigits: opts.numDigits } : { finishOnKey: '#' }),
      actionOnEmptyResult: 'true',
    },
    inner,
  );
}

/** The <Say> texts of a TwiML document, for tests and the simulator. */
export function spokenLines(twiml: string): string[] {
  const out: string[] = [];
  for (const m of twiml.matchAll(/<Say[^>]*>([\s\S]*?)<\/Say>/g)) {
    out.push(
      (m[1] ?? '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'"),
    );
  }
  return out;
}
