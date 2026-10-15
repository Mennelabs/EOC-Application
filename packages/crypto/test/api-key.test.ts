/** Per-tenant API keys (layer-6 task H; SCL-09): format, hash only, constant-time match. */
import { describe, expect, it } from 'vitest';
import { apiKeyHash, apiKeyMatches, apiKeyPrefix, newApiKey } from '../src/api-key.ts';

describe('API keys (SCL-09)', () => {
  it('a key is cgk_, a 12-character prefix and 32 random bytes; only its hash is kept', () => {
    const k = newApiKey();
    expect(k.key).toMatch(/^cgk_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(apiKeyPrefix(k.key)).toBe(k.prefix);
    expect(k.hash).toBe(apiKeyHash(k.key));
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(k.hash).not.toContain(k.key.slice(17));
    expect(newApiKey().key).not.toBe(k.key);
  });

  it('matches only the exact key', () => {
    const k = newApiKey();
    expect(apiKeyMatches(k.key, k.hash)).toBe(true);
    expect(apiKeyMatches(`${k.key.slice(0, -1)}x`, k.hash)).toBe(false);
    expect(apiKeyMatches(k.key, 'ab')).toBe(false);
    expect(apiKeyPrefix('cgk_short_x')).toBeNull();
    expect(apiKeyPrefix(`${k.key} `)).toBeNull();
  });
});
