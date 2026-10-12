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
