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
  readonly receivedAt: Date;
}

export interface Collections {
  readonly info: AdapterInfo;
  createVirtualAccount(financeAccountId: string, customerName: string): Promise<VirtualAccount>;
  /** Verifies the provider signature and parses the body. Throws on an invalid signature. */
  parseWebhook(rawBody: string, headers: Record<string, string>): IncomingPayment;
}

// ---------- Messaging ----------
export type Channel = 'sms' | 'whatsapp' | 'email' | 'push';

export interface Messaging {
  readonly info: AdapterInfo;
  send(channel: Channel, to: string, templateId: string, vars: Record<string, string>): Promise<{ id: string }>;
}
