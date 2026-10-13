/**
 * Outbound text messages (CHN-03, docs/06, SCL-11): the worker sends through
 * this interface. The simulator is the local stand-in; the Twilio
 * implementation arrives with the channel work and differs only by
 * configuration. Bodies name the county, never the product (ADM-03), and
 * never read like an emergency alert (carrier rules in docs/06).
 */
import { randomUUID } from 'node:crypto';

export interface OutboundSms {
  /** E.164 number. */
  to: string;
  body: string;
  /** The county's own number (cg.channel_number); required by real providers. */
  from?: string;
}

export interface SmsReceipt {
  provider: string;
  providerMessageId: string;
  status: 'queued' | 'sent' | 'delivered';
  segments: number;
}

export interface SmsSender {
  readonly name: string;
  send(msg: OutboundSms): Promise<SmsReceipt>;
}

// GSM 03.38 basic character set; anything outside it switches the text to UCS-2 (docs/06).
const GSM_BASIC =
  /^[A-Za-z0-9 @£$¥èéùìòÇ\n\rØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[~\]|€]*$/u;

/** Segment estimate: 160/153 characters for GSM-7 texts, 70/67 for UCS-2 ones. */
export function smsSegments(body: string): number {
  const gsm = GSM_BASIC.test(body);
  const extended = gsm ? (body.match(/[\^{}\\[~\]|€]/gu) ?? []).length : 0; // two septets each
  const length = body.length + extended;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  if (length <= single) return length === 0 ? 0 : 1;
  return Math.ceil(length / multi);
}

/** Keeps the last messages in memory so tests and the local stack can read what went out. */
export class SimulatorSms implements SmsSender {
  readonly name = 'simulator';
  readonly sent: (OutboundSms & SmsReceipt & { at: Date })[] = [];
  private readonly keep: number;

  constructor(keep = 200) {
    this.keep = keep;
  }

  async send(msg: OutboundSms): Promise<SmsReceipt> {
    const receipt: SmsReceipt = {
      provider: this.name,
      providerMessageId: `sim-${randomUUID()}`,
      status: 'sent',
      segments: smsSegments(msg.body),
    };
    this.sent.push({ ...msg, ...receipt, at: new Date() });
    while (this.sent.length > this.keep) this.sent.shift();
    return receipt;
  }
}

export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  /** Where Twilio reports delivery (the API's status webhook); optional. */
  statusCallback?: string;
  /** For tests; defaults to the Twilio REST API. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Twilio Programmable Messaging over its REST API; the account is platform configuration, the number is the tenant's. */
export class TwilioSms implements SmsSender {
  readonly name = 'twilio';
  private readonly s: TwilioSettings;

  constructor(settings: TwilioSettings) {
    this.s = settings;
  }

  async send(msg: OutboundSms): Promise<SmsReceipt> {
    if (!msg.from) throw new Error('twilio: the tenant has no sending number (cg.channel_number)');
    const base = this.s.baseUrl ?? 'https://api.twilio.com';
    const form = new URLSearchParams({ To: msg.to, From: msg.from, Body: msg.body });
    if (this.s.statusCallback) form.set('StatusCallback', this.s.statusCallback);
    const auth = Buffer.from(`${this.s.accountSid}:${this.s.authToken}`).toString('base64');
    const res = await (this.s.fetch ?? fetch)(
      `${base}/2010-04-01/Accounts/${encodeURIComponent(this.s.accountSid)}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form,
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      sid?: string;
      status?: string;
      num_segments?: string;
      code?: number;
      message?: string;
    };
    if (!res.ok || !body.sid)
      throw new Error(
        `twilio ${res.status}: ${body.code ?? ''} ${body.message ?? 'send failed'}`.trim(),
      );
    return {
      provider: this.name,
      providerMessageId: body.sid,
      status:
        body.status === 'delivered' ? 'delivered' : body.status === 'sent' ? 'sent' : 'queued',
      segments: Number(body.num_segments ?? smsSegments(msg.body)),
    };
  }
}
