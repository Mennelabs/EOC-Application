/** CHN-04, BRD:FR-17.05: Twilio request signatures, TwiML building and the segment-safe helpers. */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { smsSegments, SimulatorSms, TwilioSms } from '@cg/adapters';
import { dataUrlFetcher, isAllowedImage } from '../src/channels/media.ts';
import {
  escapeXml,
  gather,
  say,
  sayCode,
  spokenLines,
  twilioSignature,
  twimlMessages,
  verifyTwilioSignature,
} from '../src/channels/twilio.ts';

describe('Twilio signatures (docs/06)', () => {
  // The worked example from Twilio's security documentation.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675310',
    Digits: '1234',
    From: '+14158675310',
    To: '+18005551212',
  };
  const token = '12345';

  it('signs the URL plus the parameters sorted by name with HMAC-SHA1 and rejects anything else', () => {
    // Built by hand the way Twilio documents it: URL, then key+value pairs in name order.
    const concatenated =
      url + 'CallSidCA1234567890ABCDECaller+14158675310Digits1234From+14158675310To+18005551212';
    const expected = createHmac('sha1', token).update(concatenated).digest('base64');
    const sig = twilioSignature(token, url, params);
    expect(sig).toBe(expected);
    expect(verifyTwilioSignature(token, url, params, sig)).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, Digits: '1235' }, sig)).toBe(false);
    expect(verifyTwilioSignature('other', url, params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, `${url}&x=1`, params, sig)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, undefined)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, 'short')).toBe(false);
  });
});

describe('TwiML', () => {
  it('escapes resident text and emits one Message per reply', () => {
    const xml = twimlMessages(['Hi <you> & "them"', 'second']);
    expect(xml).toContain('<Message>Hi &lt;you&gt; &amp; &quot;them&quot;</Message>');
    expect(xml.match(/<Message>/g)).toHaveLength(2);
    expect(escapeXml("it's")).toBe('it&apos;s');
  });

  it('gathers digits or speech in the caller language and reads codes letter by letter', () => {
    const g = gather(
      { action: '/v?step=answer', locale: 'es', input: 'dtmf speech', numDigits: 1 },
      say('¿Hay alguien en peligro?', 'es'),
    );
    expect(g).toContain('language="es-US"');
    expect(g).toContain('numDigits="1"');
    expect(g).toContain('speechTimeout="auto"');
    expect(g).toContain('action="/v?step=answer"');
    const code = sayCode('KXMR-4827', 'en');
    expect(code).toContain('<say-as interpret-as="characters">KXMR 4827</say-as>');
    expect(code.match(/<Say /g)).toHaveLength(2);
    expect(spokenLines(say('one & two', 'en') + say('three', 'en'))).toEqual([
      'one & two',
      'three',
    ]);
  });
});

describe('media and senders', () => {
  it('accepts resident photo types only and decodes simulator data URLs', async () => {
    expect(isAllowedImage('image/jpeg')).toBe(true);
    expect(isAllowedImage('image/heic')).toBe(true);
    expect(isAllowedImage('application/pdf')).toBe(false);
    const { body, contentType } = await dataUrlFetcher().fetch(
      `data:image/png;base64,${Buffer.from('png-bytes').toString('base64')}`,
    );
    expect(body.toString()).toBe('png-bytes');
    expect(contentType).toBe('image/png');
    await expect(dataUrlFetcher().fetch('https://example.org/x.jpg')).rejects.toThrow();
  });

  it('the simulator records what went out; the Twilio sender needs the county number and reports the sid', async () => {
    const sim = new SimulatorSms();
    const r = await sim.send({ to: '+13145550199', body: 'hello' });
    expect(r.provider).toBe('simulator');
    expect(sim.sent[0]?.to).toBe('+13145550199');
    expect(r.segments).toBe(smsSegments('hello'));

    const calls: { url: string; body: string; auth: string }[] = [];
    const fakeFetch: typeof fetch = async (url, init) => {
      calls.push({
        url: String(url),
        body: String(init?.body),
        auth: String((init?.headers as Record<string, string>)['authorization']),
      });
      return new Response(JSON.stringify({ sid: 'SM123', status: 'queued', num_segments: '2' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const tw = new TwilioSms({
      accountSid: 'ACxxx',
      authToken: 'tok',
      fetch: fakeFetch,
      statusCallback: 'https://cb',
    });
    await expect(tw.send({ to: '+13145550199', body: 'x' })).rejects.toThrow(/sending number/);
    const receipt = await tw.send({ to: '+13145550199', body: 'x', from: '+13145550100' });
    expect(receipt).toEqual({
      provider: 'twilio',
      providerMessageId: 'SM123',
      status: 'queued',
      segments: 2,
    });
    expect(calls[0]?.url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACxxx/Messages.json');
    expect(calls[0]?.auth).toBe(`Basic ${Buffer.from('ACxxx:tok').toString('base64')}`);
    expect(calls[0]?.body).toContain('StatusCallback=https%3A%2F%2Fcb');
    const failing: typeof fetch = async () =>
      new Response(JSON.stringify({ code: 21610, message: 'blocked' }), { status: 400 });
    await expect(
      new TwilioSms({ accountSid: 'AC', authToken: 't', fetch: failing }).send({
        to: '+1',
        body: 'x',
        from: '+2',
      }),
    ).rejects.toThrow(/21610/);
  });
});
