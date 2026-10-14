// SMS, email and push delivery. Every message is recorded in ops.outbox (delivery log); the sandbox
// adapters stop there, real adapters also call the provider.
import type { Queryable } from '../db/pool.ts';

export interface OutMessage {
  channel: 'sms' | 'email' | 'push';
  to: string;
  subject?: string;
  body: string;
  data?: Record<string, unknown>;
}

export interface Messenger {
  readonly name: string;
  send(q: Queryable, m: OutMessage): Promise<void>;
}

async function record(q: Queryable, provider: string, m: OutMessage, status: 'sent' | 'failed', ref?: string): Promise<void> {
  await q.query(
    'INSERT INTO ops.outbox (channel, destination, subject, body, data, provider, provider_ref, status, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8 = \'sent\' THEN now() END)',
    [m.channel, m.to, m.subject ?? null, m.body, JSON.stringify(m.data ?? {}), provider, ref ?? null, status],
  );
}

export class SandboxMessenger implements Messenger {
  readonly name = 'sandbox';
  async send(q: Queryable, m: OutMessage): Promise<void> {
    await record(q, this.name, m, 'sent');
  }
}

/** Termii (Nigerian SMS provider) — https://developers.termii.com */
export class TermiiSms implements Messenger {
  readonly name = 'termii';
  constructor(private readonly apiKey: string, private readonly senderId: string) {}
  async send(q: Queryable, m: OutMessage): Promise<void> {
    const r = await fetch('https://api.ng.termii.com/api/sms/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: m.to.replace(/^\+/, ''), from: this.senderId, sms: m.body, type: 'plain', channel: 'dnd', api_key: this.apiKey }),
    });
    const j = (await r.json().catch(() => ({}))) as { message_id?: string };
    await record(q, this.name, m, r.ok ? 'sent' : 'failed', j.message_id);
    if (!r.ok) throw new Error(`termii send failed: ${r.status}`);
  }
}

/** Postmark transactional email. */
export class PostmarkEmail implements Messenger {
  readonly name = 'postmark';
  constructor(private readonly token: string, private readonly from: string) {}
  async send(q: Queryable, m: OutMessage): Promise<void> {
    const r = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'X-Postmark-Server-Token': this.token },
      body: JSON.stringify({ From: this.from, To: m.to, Subject: m.subject ?? 'Backstop', TextBody: m.body }),
    });
    const j = (await r.json().catch(() => ({}))) as { MessageID?: string };
    await record(q, this.name, m, r.ok ? 'sent' : 'failed', j.MessageID);
    if (!r.ok) throw new Error(`postmark send failed: ${r.status}`);
  }
}

/** Expo push service (the mobile apps are built with Expo). */
export class ExpoPush implements Messenger {
  readonly name = 'expo';
  constructor(private readonly accessToken?: string) {}
  async send(q: Queryable, m: OutMessage): Promise<void> {
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}) },
      body: JSON.stringify({ to: m.to, title: m.subject, body: m.body, data: m.data ?? {} }),
    });
    await record(q, this.name, m, r.ok ? 'sent' : 'failed');
    if (!r.ok) throw new Error(`expo push failed: ${r.status}`);
  }
}

export function createMessengers(adapters: { sms: string; email: string; push: string }): Record<'sms' | 'email' | 'push', Messenger> {
  const sandbox = new SandboxMessenger();
  return {
    sms: adapters.sms === 'termii' ? new TermiiSms(process.env.TERMII_API_KEY ?? '', process.env.TERMII_SENDER_ID ?? 'Backstop') : sandbox,
    email: adapters.email === 'postmark' ? new PostmarkEmail(process.env.POSTMARK_TOKEN ?? '', process.env.EMAIL_FROM ?? 'no-reply@backstop.ng') : sandbox,
    push: adapters.push === 'expo' ? new ExpoPush(process.env.EXPO_ACCESS_TOKEN) : sandbox,
  };
}
