/**
 * Outbound webhooks (layer-6 task H; SCL-09): where a delivery may go
 * (HTTPS host names resolving to public addresses only, OWASP SSRF), the
 * Standard Webhooks signature, and the retry schedule.
 */
import { describe, expect, it } from 'vitest';
import {
  httpsWebhookSender,
  isPublicAddress,
  newWebhookSecret,
  signWebhook,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  webhookUrlProblem,
} from '../src/webhooks.ts';

describe('webhook addresses (SCL-09, SSRF)', () => {
  it('takes an HTTPS host name on the standard ports', () => {
    expect(webhookUrlProblem('https://hooks.example.org/in?x=1')).toBeNull();
    expect(webhookUrlProblem('https://hooks.example.org:8443/in')).toBeNull();
  });

  it('refuses everything else', () => {
    for (const url of [
      'not a url',
      'http://hooks.example.org/in',
      'ftp://hooks.example.org/in',
      'https://user:pw@hooks.example.org/in',
      'https://hooks.example.org:22/in',
      'https://127.0.0.1/in',
      'https://[::1]/in',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/in',
      'https://intranet/in',
      'https://db.internal/in',
      'https://printer.local/in',
      `https://hooks.example.org/${'a'.repeat(500)}`,
    ])
      expect(webhookUrlProblem(url), url).not.toBeNull();
  });

  it('knows which addresses are public', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isPublicAddress(ip), ip).toBe(true);
    for (const ip of [
      '10.1.2.3',
      '172.20.0.5',
      '192.168.1.1',
      '127.0.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      '::ffff:a00:1',
      'not-an-ip',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
  });

  it('the sender refuses a host that resolves to a private address, without connecting', async () => {
    const send = httpsWebhookSender({ resolve: async () => ['93.184.216.34', '10.0.0.8'] });
    const r = await send({ url: 'https://hooks.example.org/in', headers: {}, body: '{}' });
    expect(r).toEqual({
      status: null,
      error: 'The host name resolves to an address that is not public.',
    });
    const none = httpsWebhookSender({
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(
      (await none({ url: 'https://hooks.example.org/in', headers: {}, body: '{}' })).error,
    ).toBe('The host name did not resolve.');
    const plain = httpsWebhookSender({ resolve: async () => ['93.184.216.34'] });
    expect(
      (await plain({ url: 'http://hooks.example.org/in', headers: {}, body: '{}' })).error,
    ).toBe('The address must start with https://.');
  });
});

describe('Standard Webhooks signature (SCL-09)', () => {
  it('matches the published test vector', () => {
    // From the Standard Webhooks specification's examples.
    const headers = signWebhook(
      'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
      'msg_p5jXN8AQM9LWM0D4loKWxJek',
      1614265330,
      '{"test": 2432232314}',
    );
    expect(headers).toEqual({
      'webhook-id': 'msg_p5jXN8AQM9LWM0D4loKWxJek',
      'webhook-timestamp': '1614265330',
      'webhook-signature': 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    });
  });

  it('a new secret is 24 random bytes after whsec_', () => {
    const a = newWebhookSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(newWebhookSecret()).not.toBe(a);
  });

  it('retries back off and stop after the last attempt', () => {
    expect([1, 2, 3, 4, 5].map(webhookBackoffMs)).toEqual([
      60_000, 300_000, 1_800_000, 7_200_000, 21_600_000,
    ]);
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(8);
  });
});
