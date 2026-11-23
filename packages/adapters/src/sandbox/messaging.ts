import { randomUUID } from 'node:crypto';
import type { Channel, Messaging } from '../ports.js';

export interface SentMessage {
  readonly id: string;
  readonly channel: Channel;
  readonly to: string;
  readonly templateId: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly at: Date;
}

/**
 * Keeps messages in memory instead of sending them. Tests read `sent`; in staging the
 * API exposes recent messages to staff on a sandbox-only route so OTPs can be used
 * without an SMS provider. Never used when a real provider is configured.
 */
export class SandboxMessaging implements Messaging {
  readonly info = { port: 'Messaging', provider: 'sandbox', mode: 'sandbox' } as const;
  readonly sent: SentMessage[] = [];
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  async send(channel: Channel, to: string, templateId: string, vars: Record<string, string>): Promise<{ id: string }> {
    const msg: SentMessage = { id: randomUUID(), channel, to, templateId, vars: { ...vars }, at: new Date() };
    this.sent.push(msg);
    if (this.sent.length > this.limit) this.sent.shift();
    return { id: msg.id };
  }

  lastTo(to: string): SentMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to);
  }
}
