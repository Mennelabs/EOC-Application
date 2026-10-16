/**
 * Log redaction (ADR-0023, CLAUDE.md rule 9). Credentials and any field that
 * can carry personal data are removed before a log line is written. Layer 1
 * extends this list from the data dictionary's classifications (SEC-11).
 */
import type { FastifyRequest } from 'fastify';

export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-twilio-signature"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.phone',
  '*.email',
  '*.name',
  '*.address',
];

/**
 * A URL with the values of credential parameters removed (GIS clients send `token=`; SCL-09),
 * and the single-use token in a facility owner's re-check link (REC-01).
 */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&](?:token|key|api_key|update)=)[^&#]*/gi, '$1[redacted]')
    .replace(/(\/facilities\/[^/?#]+\/update\/)[^/?#]+/gi, '$1[redacted]');
}

/** Request serializer: the default fields, with credential parameters removed from the URL. */
export const serializers = {
  req(req: FastifyRequest) {
    return {
      method: req.method,
      url: redactUrl(req.url),
      host: req.hostname,
      remoteAddress: req.ip,
      ...(req.socket?.remotePort !== undefined ? { remotePort: req.socket.remotePort } : {}),
    };
  },
};
