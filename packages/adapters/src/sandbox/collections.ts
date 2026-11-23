import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { kobo } from '@project/domain';
import {
  InvalidWebhookPayloadError,
  InvalidWebhookSignatureError,
  type Collections,
  type IncomingPayment,
  type VirtualAccount,
} from '../ports.js';

export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

export interface SandboxPaymentEvent {
  readonly event: 'payment.received';
  readonly reference: string;
  readonly accountNumber: string;
  /** Integer kobo as a decimal string, so no precision is lost in JSON. */
  readonly amountKobo: string;
  readonly paidAt: string;
}

/**
 * Our own simulated collections provider. Its webhook format and signature scheme
 * (HMAC-SHA512 of the raw body, hex, in x-sandbox-signature) are ours, not any real
 * provider's: a real adapter is written from that provider's published docs.
 */
export class SandboxCollections implements Collections {
  readonly info = { port: 'Collections', provider: 'sandbox', mode: 'sandbox' } as const;

  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length < 16) throw new Error('webhookSecret must be at least 16 characters');
  }

  async createVirtualAccount(financeAccountId: string): Promise<VirtualAccount> {
    // 99xxxxxxxx: a range no Nigerian bank issues, so a sandbox number can never be mistaken for a real one.
    const accountNumber = `99${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
    return { accountNumber, bankName: 'Sandbox Bank', providerReference: `sbx-va-${financeAccountId}` };
  }

  sign(rawBody: Buffer | string): string {
    return createHmac('sha512', this.webhookSecret).update(rawBody).digest('hex');
  }

  /** Builds a signed webhook exactly as the provider would send it. For tests and the staging simulator. */
  buildWebhook(e: Omit<SandboxPaymentEvent, 'event'>): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify({ event: 'payment.received', ...e }));
    return { body, headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: this.sign(body) } };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): IncomingPayment | null {
    const given = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof given !== 'string' || !/^[0-9a-f]{128}$/.test(given)) throw new InvalidWebhookSignatureError();
    const expected = Buffer.from(this.sign(rawBody), 'hex');
    if (!timingSafeEqual(expected, Buffer.from(given, 'hex'))) throw new InvalidWebhookSignatureError();

    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new InvalidWebhookPayloadError('not JSON');
    }
    const b = body as Partial<SandboxPaymentEvent> & { event?: string };
    if (b.event !== 'payment.received') return null;

    if (typeof b.reference !== 'string' || !/^[A-Za-z0-9_\-.]{1,100}$/.test(b.reference)) {
      throw new InvalidWebhookPayloadError('reference');
    }
    if (typeof b.accountNumber !== 'string' || !/^[0-9]{10}$/.test(b.accountNumber)) {
      throw new InvalidWebhookPayloadError('accountNumber');
    }
    if (typeof b.amountKobo !== 'string' || !/^[1-9][0-9]{0,17}$/.test(b.amountKobo)) {
      throw new InvalidWebhookPayloadError('amountKobo');
    }
    const paidAt = typeof b.paidAt === 'string' ? new Date(b.paidAt) : new Date(NaN);
    if (Number.isNaN(paidAt.getTime())) throw new InvalidWebhookPayloadError('paidAt');

    return {
      providerReference: b.reference,
      virtualAccountNumber: b.accountNumber,
      amount: kobo(BigInt(b.amountKobo)),
      paidAt,
      raw: body,
    };
  }
}
