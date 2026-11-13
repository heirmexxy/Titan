import { config } from '../config.js';

export interface EmailSender {
  send(to: string | string[], subject: string, text: string, html?: string, replyTo?: string): Promise<boolean>;
}
export interface SmsSender {
  send(to: string, text: string): Promise<boolean>;
}

/** Resend adapter. Without an API key it logs instead of sending, so local dev never fails. */
export class ResendEmail implements EmailSender {
  constructor(private apiKey = config.resend.apiKey, private from = config.resend.from) {}
  async send(to: string | string[], subject: string, text: string, html?: string, replyTo?: string) {
    if (!this.apiKey) {
      console.log(JSON.stringify({ level: 'info', msg: 'email (not sent: RESEND_API_KEY unset)', to, subject }));
      return false;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: Array.isArray(to) ? to : [to], subject, text, html, reply_to: replyTo }),
    });
    if (!res.ok) console.error(JSON.stringify({ level: 'error', msg: 'resend failed', status: res.status, body: await res.text() }));
    return res.ok;
  }
}

/** Termii adapter (generic route). */
export class TermiiSms implements SmsSender {
  constructor(private apiKey = config.termii.apiKey, private from = config.termii.senderId, private baseUrl = config.termii.baseUrl) {}
  async send(to: string, text: string) {
    if (!this.apiKey) {
      console.log(JSON.stringify({ level: 'info', msg: 'sms (not sent: TERMII_API_KEY unset)', to, text }));
      return false;
    }
    const res = await fetch(`${this.baseUrl}/api/sms/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: to.replace(/^\+/, ''), from: this.from, sms: text, type: 'plain', channel: 'generic', api_key: this.apiKey }),
    });
    if (!res.ok) console.error(JSON.stringify({ level: 'error', msg: 'termii failed', status: res.status, body: await res.text() }));
    return res.ok;
  }
}
