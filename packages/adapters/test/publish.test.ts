/** publishConfirmed (SCL-06): a confirm, a failed confirm, a closed channel and a lost confirm. */
import { describe, expect, it } from 'vitest';
import { publishConfirmed } from '../src/queue.ts';

type Publish = Parameters<typeof publishConfirmed>[0]['publish'];
const channel = (publish: (cb: (err: unknown) => void) => void) => ({
  publish: ((_e, _k, _b, _o, cb) => {
    publish(cb as (err: unknown) => void);
    return true;
  }) as Publish,
});

describe('publishConfirmed (SCL-06)', () => {
  it('resolves on the confirm and rejects on a negative one', async () => {
    await expect(
      publishConfirmed(
        channel((cb) => cb(null)),
        'x',
        '',
        Buffer.from('{}'),
        {},
      ),
    ).resolves.toBeUndefined();
    await expect(
      publishConfirmed(
        channel((cb) => cb(new Error('nack'))),
        'x',
        '',
        Buffer.from('{}'),
        {},
      ),
    ).rejects.toThrow('nack');
  });

  it('turns a closed channel and a confirm that never comes into errors', async () => {
    await expect(
      publishConfirmed(
        channel(() => {
          throw new Error('Channel closed');
        }),
        'x',
        '',
        Buffer.from('{}'),
        {},
      ),
    ).rejects.toThrow('Channel closed');
    await expect(
      publishConfirmed(
        channel(() => undefined),
        'x',
        '',
        Buffer.from('{}'),
        {},
        30,
      ),
    ).rejects.toThrow('no publish confirm');
  });
});
