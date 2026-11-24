import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { kobo, type Kobo } from '@project/domain';
import {
  AccountNotFoundError,
  InvalidWebhookPayloadError,
  InvalidWebhookSignatureError,
  type Bank,
  type Payouts,
  type TransferOutcome,
  type TransferResult,
} from '../ports.js';
import { SANDBOX_SIGNATURE_HEADER } from './collections.js';

/**
 * Fees as published by Paystack for Nigerian transfers (checked November 2026): ₦10 up to
 * ₦5,000; ₦25 up to ₦50,000; ₦50 above; plus ₦50 stamp duty on transfers of ₦10,000 or more.
 * The sandbox charges the same so test books show realistic costs. A real adapter must take its
 * fees from its own provider's pricing.
 */
export function paystackNgTransferFee(amount: Kobo): Kobo {
  const band = amount <= 500_000n ? 1_000n : amount <= 5_000_000n ? 2_500n : 5_000n;
  const duty = amount >= 1_000_000n ? 5_000n : 0n;
  return kobo(band + duty);
}

/**
 * Our own simulated payouts provider. Accounts must be registered with `openAccount` first, so
 * tests decide what name the "bank" returns. Webhook format and signature are ours.
 */
export class SandboxPayouts implements Payouts {
  readonly info = { port: 'Payouts', provider: 'sandbox', mode: 'sandbox' } as const;
  private readonly accounts = new Map<string, string>();
  readonly transfers: { reference: string; amount: Kobo; recipientCode: string; reason: string; providerTransferId: string }[] = [];
  /** Set to make the next transfer call fail synchronously (provider down, insufficient balance). */
  failNextTransfer: string | null = null;

  constructor(private readonly webhookSecret: string) {
    if (webhookSecret.length < 16) throw new Error('webhookSecret must be at least 16 characters');
  }

  /** Test/simulator helper: what the "bank" will say this account is called. */
  openAccount(bankCode: string, accountNumber: string, accountName: string): void {
    this.accounts.set(`${bankCode}:${accountNumber}`, accountName);
  }

  async banks(): Promise<readonly Bank[]> {
    return [
      { code: '999', name: 'Sandbox Bank' },
      { code: '998', name: 'Sandbox Microfinance Bank' },
    ];
  }

  async resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }> {
    const name = this.accounts.get(`${bankCode}:${accountNumber}`);
    if (!name) throw new AccountNotFoundError();
    return { accountName: name };
  }

  async createRecipient(input: { bankCode: string; accountNumber: string }): Promise<{ recipientCode: string }> {
    return { recipientCode: `SBX_RCP_${input.bankCode}_${input.accountNumber}` };
  }

  async transfer(input: { reference: string; amount: Kobo; recipientCode: string; reason: string }): Promise<TransferResult> {
    if (this.failNextTransfer) {
      const why = this.failNextTransfer;
      this.failNextTransfer = null;
      throw new Error(why);
    }
    const providerTransferId = `SBX_TRF_${randomUUID()}`;
    this.transfers.push({ ...input, providerTransferId });
    return { providerTransferId };
  }

  transferFee(amount: Kobo): Kobo {
    return paystackNgTransferFee(amount);
  }

  sign(body: Buffer | string): string {
    return createHmac('sha512', this.webhookSecret).update(body).digest('hex');
  }

  buildWebhook(e: { reference: string; status: 'succeeded' | 'failed'; reason?: string; eventId: string }): { body: Buffer; headers: Record<string, string> } {
    const body = Buffer.from(JSON.stringify({ event: `transfer.${e.status}`, reference: e.reference, reason: e.reason ?? null, eventId: e.eventId }));
    return { body, headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: this.sign(body) } };
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): TransferOutcome | null {
    const given = headers[SANDBOX_SIGNATURE_HEADER];
    if (typeof given !== 'string' || !/^[0-9a-f]{128}$/.test(given)) throw new InvalidWebhookSignatureError();
    if (!timingSafeEqual(Buffer.from(this.sign(rawBody), 'hex'), Buffer.from(given, 'hex'))) throw new InvalidWebhookSignatureError();
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new InvalidWebhookPayloadError('not JSON');
    }
    const status = b['event'] === 'transfer.succeeded' ? 'succeeded' : b['event'] === 'transfer.failed' ? 'failed' : null;
    if (!status) return null;
    const ref = b['reference'];
    const id = b['eventId'];
    if (typeof ref !== 'string' || !/^PO-\d{6,}$/.test(ref)) throw new InvalidWebhookPayloadError('reference');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_\-.]{1,100}$/.test(id)) throw new InvalidWebhookPayloadError('eventId');
    return { reference: ref, status, reason: typeof b['reason'] === 'string' ? b['reason'] : null, providerEventId: id };
  }
}
