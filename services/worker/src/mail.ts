/**
 * Email adapter (finding G-02, Q-02): SMTP to Mailpit locally; the provider
 * chosen later only changes SMTP_URL. Messages name the county, never the
 * product (ADM-03), and carry no restricted data.
 */
import nodemailer from 'nodemailer';

export interface Mailer {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export function smtpMailer(smtpUrl: string, from: string): Mailer {
  const transport = nodemailer.createTransport(smtpUrl);
  return {
    async send(msg) {
      await transport.sendMail({ from, ...msg });
    },
  };
}

export const nullMailer: Mailer = { send: async () => undefined };
