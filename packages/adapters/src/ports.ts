import type { Kobo } from '@project/domain';

/** Every adapter declares what it is. Only an adapter built against a real provider may say 'live'. */
export type AdapterMode = 'sandbox' | 'live';

export interface AdapterInfo {
  readonly port: string;
  readonly provider: string;
  readonly mode: AdapterMode;
}

// ---------- Identity / KYC ----------
export type IdentityOutcome = 'verified' | 'failed' | 'manual_review';

export interface IdentityCheckRequest {
  readonly personId: string;
  readonly nin?: string;
  readonly bvn?: string;
  readonly phone: string;
  readonly fullName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
}

export interface IdentityCheckResult {
  readonly outcome: IdentityOutcome;
  readonly providerReference: string;
  readonly reasons: readonly string[];
}

export interface IdentityVerification {
  readonly info: AdapterInfo;
  verify(req: IdentityCheckRequest): Promise<IdentityCheckResult>;
}

// ---------- Credit ----------
export interface CreditCheckResult {
  readonly providerReference: string;
  readonly score: number | null;
  readonly activeFacilities: number;
  readonly delinquent: boolean;
}

export interface CreditCheck {
  readonly info: AdapterInfo;
  check(personId: string, bvn: string): Promise<CreditCheckResult>;
}

// ---------- Collections (virtual accounts + webhooks) ----------
export interface VirtualAccount {
  readonly accountNumber: string;
  readonly bankName: string;
  readonly providerReference: string;
}

export interface IncomingPayment {
  readonly providerReference: string;
  readonly virtualAccountNumber: string;
  readonly amount: Kobo;
  /** When the payer's money arrived, according to the provider. */
  readonly paidAt: Date;
  /** The provider's parsed body, stored as received. */
  readonly raw: unknown;
}

export class InvalidWebhookSignatureError extends Error {
  constructor() {
    super('Webhook signature is missing or invalid');
    this.name = 'InvalidWebhookSignatureError';
  }
}

export class InvalidWebhookPayloadError extends Error {
  constructor(detail: string) {
    super(`Webhook payload rejected: ${detail}`);
    this.name = 'InvalidWebhookPayloadError';
  }
}

export interface Collections {
  readonly info: AdapterInfo;
  createVirtualAccount(financeAccountId: string, customerName: string): Promise<VirtualAccount>;
  /**
   * Verifies the provider signature over the exact raw bytes, then parses the body.
   * Throws InvalidWebhookSignatureError or InvalidWebhookPayloadError.
   * Returns null for event types that are not incoming payments (acknowledged, ignored).
   */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): IncomingPayment | null;
}

// ---------- Checkout (one-off payments, e.g. a delivery fare) ----------
export interface CheckoutCharge {
  /** Our reference for the payment; the provider echoes it back in the webhook. */
  readonly reference: string;
  /** Where the customer completes payment (hosted page, or bank-transfer instructions). */
  readonly payUrl: string;
}

export interface ChargePaid {
  readonly reference: string;
  readonly amount: Kobo;
  readonly paidAt: Date;
  readonly providerEventId: string;
}

export interface Checkout {
  readonly info: AdapterInfo;
  createCharge(input: { reference: string; amount: Kobo; customerPhone: string; description: string }): Promise<CheckoutCharge>;
  /** Signature checked over the raw bytes. Returns null for events that are not successful charges. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ChargePaid | null;
}

// ---------- Payouts (transfers to bank accounts) ----------
export interface Bank {
  readonly code: string;
  readonly name: string;
}

export class AccountNotFoundError extends Error {
  constructor() {
    super('account_not_found');
  }
}

export interface TransferResult {
  readonly providerTransferId: string;
}

export interface TransferOutcome {
  /** Our payout reference, echoed back by the provider. */
  readonly reference: string;
  readonly status: 'succeeded' | 'failed';
  readonly reason: string | null;
  readonly providerEventId: string;
}

export interface Payouts {
  readonly info: AdapterInfo;
  banks(): Promise<readonly Bank[]>;
  /** The name the bank holds for this account. Throws AccountNotFoundError. */
  resolveAccount(bankCode: string, accountNumber: string): Promise<{ accountName: string }>;
  /** Registers a destination; returns the provider's code for it. */
  createRecipient(input: { name: string; bankCode: string; accountNumber: string }): Promise<{ recipientCode: string }>;
  /** Starts a transfer. The final outcome arrives by webhook. */
  transfer(input: { reference: string; amount: Kobo; recipientCode: string; reason: string }): Promise<TransferResult>;
  /** What the provider charges for a transfer of this amount (including any duty it collects). */
  transferFee(amount: Kobo): Kobo;
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): TransferOutcome | null;
}

// ---------- Routes (distance for pricing) ----------
export interface Point {
  readonly lat: number;
  readonly lng: number;
}

export interface RouteEstimate {
  readonly distanceMeters: number;
  /** How the distance was worked out, recorded on every quote. */
  readonly source: string;
}

export interface Routes {
  readonly info: AdapterInfo;
  estimate(from: Point, to: Point): Promise<RouteEstimate>;
}

// ---------- Messaging ----------
export type Channel = 'sms' | 'whatsapp' | 'email' | 'push';

export interface Messaging {
  readonly info: AdapterInfo;
  send(channel: Channel, to: string, templateId: string, vars: Record<string, string>): Promise<{ id: string }>;
}

// ---------- Document archive ----------
export interface StoredDocument {
  readonly key: string;
  readonly sha256: string;
}

export interface DocumentStore {
  readonly info: AdapterInfo;
  /** Writes once. Implementations must refuse to overwrite an existing key. */
  put(key: string, body: Buffer, contentType: string): Promise<StoredDocument>;
  get(key: string): Promise<Buffer>;
}
