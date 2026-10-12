/**
 * Log redaction (ADR-0023, CLAUDE.md rule 9). Credentials and any field that
 * can carry personal data are removed before a log line is written. Layer 1
 * extends this list from the data dictionary's classifications (SEC-11).
 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-twilio-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.phone',
  '*.email',
  '*.name',
  '*.address',
];
