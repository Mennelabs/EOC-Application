import { connect } from 'node:net';
import type { Probe } from './health.ts';

/** TCP reachability of the SMTP relay (Mailpit locally, finding Q-02). */
export function smtpProbe(name: string, smtpUrl: string): Probe {
  const u = new URL(smtpUrl);
  return {
    name,
    check(signal) {
      return new Promise((resolve, reject) => {
        const socket = connect({ host: u.hostname, port: Number(u.port || 25) });
        const done = (err?: Error) => {
          socket.destroy();
          if (err) reject(err);
          else resolve();
        };
        socket.once('connect', () => done());
        socket.once('error', done);
        signal.addEventListener('abort', () => done(new Error('timeout')), { once: true });
      });
    },
  };
}
