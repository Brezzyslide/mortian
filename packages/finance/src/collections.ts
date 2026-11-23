import type { Collections, VirtualAccount } from '@project/adapters';
import { kobo, type Kobo } from '@project/domain';
import { recordAudit, type PoolLike } from '@project/identity';
import { accountBalance, postEntry, type EntryDraft } from '@project/ledger';

export type FinanceProductCode =
  | 'motorcycle_ride_to_own'
  | 'phone_financing'
  | 'school_fee_financing'
  | 'business_equipment_finance'
  | 'purchase_and_deliver';

/** Statuses in which an incoming payment is expected. Anything else is posted but flagged for review. */
const ACCEPTS_PAYMENTS = new Set([
  'approved',
  'contracted',
  'deposit_paid',
  'active',
  'in_arrears',
  'repossession_review',
  'repossessed',
]);

export const UNMATCHED_SUSPENSE = 'fin:suspense:unmatched';
export const suspenseAccount = (financeAccountRef: string) => `fin:suspense:${financeAccountRef}`;
export const clearingAccount = (provider: string) => `fin:clearing:${provider}`;

export type IngestResult =
  | { outcome: 'ignored' }
  | {
      outcome: 'posted';
      eventId: string;
      entryId: string;
      financeAccountId: string;
      financeAccountReference: string;
      problem: string | null;
    }
  | { outcome: 'unmatched'; eventId: string; entryId: string }
  | { outcome: 'duplicate'; eventId: string }
  | { outcome: 'conflict'; eventId: string };

export interface PaymentProblem {
  readonly eventId: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly accountNumber: string;
  readonly amount: Kobo;
  readonly paidAt: Date;
  readonly problem: string;
  readonly financeAccountReference: string | null;
}

export class CollectionsService {
  constructor(
    private readonly pool: PoolLike,
    private readonly collections: Collections,
  ) {}

  private get provider(): string {
    return this.collections.info.provider;
  }

  async openAccount(personId: string, productCode: FinanceProductCode): Promise<{ id: string; reference: string }> {
    const { rows } = await this.pool.query<{ id: string; reference: string }>(
      `INSERT INTO finance_account (person_id, product_code) VALUES ($1, $2) RETURNING id, reference`,
      [personId, productCode],
    );
    return rows[0]!;
  }

  /** Gives a finance account its dedicated repayment account number. Safe to call twice. */
  async provisionVirtualAccount(financeAccountId: string, customerName: string): Promise<VirtualAccount> {
    const existing = await this.pool.query<{ account_number: string; bank_name: string; provider_reference: string }>(
      'SELECT account_number, bank_name, provider_reference FROM virtual_account WHERE finance_account_id = $1',
      [financeAccountId],
    );
    if (existing.rows[0]) {
      const r = existing.rows[0];
      return { accountNumber: r.account_number, bankName: r.bank_name, providerReference: r.provider_reference };
    }
    const va = await this.collections.createVirtualAccount(financeAccountId, customerName);
    await this.pool.query(
      `INSERT INTO virtual_account (account_number, bank_name, provider, provider_reference, finance_account_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [va.accountNumber, va.bankName, this.provider, va.providerReference, financeAccountId],
    );
    return va;
  }

  /**
   * Handles one provider webhook end to end. Safe under redelivery and concurrent delivery:
   * the payment_event row and the ledger idempotency key both make it exactly-once,
   * and a crash between posting and marking the event is recovered on the next delivery.
   * Throws the adapter's signature/payload errors unchanged.
   */
  async ingestWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<IngestResult> {
    const p = this.collections.parseWebhook(rawBody, headers);
    if (!p) return { outcome: 'ignored' };

    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO payment_event (provider, provider_reference, account_number, amount, paid_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (provider, provider_reference) DO NOTHING
       RETURNING id`,
      [this.provider, p.providerReference, p.virtualAccountNumber, p.amount.toString(), p.paidAt, JSON.stringify(p.raw)],
    );

    let eventId: string;
    if (inserted.rows[0]) {
      eventId = inserted.rows[0].id;
    } else {
      const { rows } = await this.pool.query<{
        id: string;
        status: string;
        account_number: string;
        amount: string;
        problem: string | null;
      }>(
        `SELECT id, status, account_number, amount::text, problem
           FROM payment_event WHERE provider = $1 AND provider_reference = $2`,
        [this.provider, p.providerReference],
      );
      const prev = rows[0]!;
      eventId = prev.id;
      if (prev.account_number !== p.virtualAccountNumber || BigInt(prev.amount) !== p.amount) {
        // Same provider reference, different money: never overwrite. A person must look at it.
        if (prev.problem !== 'conflicting_redelivery') {
          await this.pool.query(`UPDATE payment_event SET problem = 'conflicting_redelivery' WHERE id = $1`, [eventId]);
          await recordAudit(this.pool, {
            actorKind: 'system',
            action: 'payments.webhook.conflicting_redelivery',
            subjectType: 'payment_event',
            subjectId: eventId,
            details: { provider: this.provider, reference: p.providerReference },
          });
        }
        return { outcome: 'conflict', eventId };
      }
      if (prev.status !== 'received') return { outcome: 'duplicate', eventId };
      // status 'received': a previous delivery stopped part-way. Continue; posting below is idempotent.
    }

    const match = await this.pool.query<{ id: string; reference: string; status: string }>(
      `SELECT f.id, f.reference, f.status
         FROM virtual_account v JOIN finance_account f ON f.id = v.finance_account_id
        WHERE v.account_number = $1 AND v.provider = $2`,
      [p.virtualAccountNumber, this.provider],
    );
    const fa = match.rows[0];

    const entry: EntryDraft = {
      idempotencyKey: `collections:${this.provider}:${p.providerReference}`,
      source: 'webhook',
      actorId: `provider:${this.provider}`,
      occurredAt: p.paidAt,
      description: fa
        ? `Payment received for ${fa.reference} (ref ${p.providerReference})`
        : `Unmatched payment to ${p.virtualAccountNumber} (ref ${p.providerReference})`,
      lines: [
        { account: clearingAccount(this.provider), side: 'debit', amount: p.amount },
        { account: fa ? suspenseAccount(fa.reference) : UNMATCHED_SUSPENSE, side: 'credit', amount: p.amount },
      ],
    };
    const { entryId } = await postEntry(this.pool, entry);

    if (!fa) {
      await this.pool.query(
        `UPDATE payment_event SET status = 'unmatched', ledger_entry_id = $2, problem = 'unknown_account_number'
          WHERE id = $1`,
        [eventId, entryId],
      );
      return { outcome: 'unmatched', eventId, entryId };
    }

    const problem = ACCEPTS_PAYMENTS.has(fa.status) ? null : `account_status_${fa.status}`;
    await this.pool.query(
      `UPDATE payment_event SET status = 'posted', ledger_entry_id = $2, finance_account_id = $3, problem = $4
        WHERE id = $1`,
      [eventId, entryId, fa.id, problem],
    );
    return { outcome: 'posted', eventId, entryId, financeAccountId: fa.id, financeAccountReference: fa.reference, problem };
  }

  /** The exceptions queue: payments a person must review. Oldest first. */
  async openProblems(limit = 100): Promise<PaymentProblem[]> {
    const { rows } = await this.pool.query<{
      id: string;
      provider: string;
      provider_reference: string;
      account_number: string;
      amount: string;
      paid_at: Date;
      problem: string;
      reference: string | null;
    }>(
      `SELECT e.id, e.provider, e.provider_reference, e.account_number, e.amount::text, e.paid_at, e.problem, f.reference
         FROM payment_event e LEFT JOIN finance_account f ON f.id = e.finance_account_id
        WHERE e.problem IS NOT NULL AND e.resolved_at IS NULL
        ORDER BY e.received_at LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      eventId: r.id,
      provider: r.provider,
      providerReference: r.provider_reference,
      accountNumber: r.account_number,
      amount: kobo(BigInt(r.amount)),
      paidAt: r.paid_at,
      problem: r.problem,
      financeAccountReference: r.reference,
    }));
  }

  /**
   * Moves an unmatched payment to the right finance account and closes the exception.
   * Posts a ledger transfer between suspense accounts; never edits the original entry.
   */
  async assignUnmatched(eventId: string, financeAccountReference: string, staffId: string, note: string): Promise<string> {
    const { rows } = await this.pool.query<{ status: string; amount: string; resolved_at: Date | null; provider_reference: string }>(
      'SELECT status, amount::text, resolved_at, provider_reference FROM payment_event WHERE id = $1',
      [eventId],
    );
    const e = rows[0];
    if (!e || e.status !== 'unmatched' || e.resolved_at) throw new Error('Not an open unmatched payment');
    const fa = await this.pool.query<{ id: string }>('SELECT id FROM finance_account WHERE reference = $1', [
      financeAccountReference,
    ]);
    if (!fa.rows[0]) throw new Error(`Unknown finance account ${financeAccountReference}`);
    const amount = kobo(BigInt(e.amount));

    const { entryId } = await postEntry(this.pool, {
      idempotencyKey: `collections:assign:${eventId}`,
      source: 'admin',
      actorId: staffId,
      occurredAt: new Date(),
      description: `Assign unmatched payment ${e.provider_reference} to ${financeAccountReference}: ${note}`,
      lines: [
        { account: UNMATCHED_SUSPENSE, side: 'debit', amount },
        { account: suspenseAccount(financeAccountReference), side: 'credit', amount },
      ],
    });
    await this.pool.query(
      `UPDATE payment_event SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL`,
      [eventId, staffId],
    );
    await recordAudit(this.pool, {
      actorId: staffId,
      actorKind: 'person',
      action: 'payments.unmatched.assigned',
      subjectType: 'payment_event',
      subjectId: eventId,
      details: { financeAccountReference, entryId, note },
    });
    return entryId;
  }

  /** Closes a reviewed exception that needs no money movement (e.g. accepted late payment). */
  async resolveProblem(eventId: string, staffId: string, note: string): Promise<void> {
    const r = await this.pool.query(
      `UPDATE payment_event SET resolved_at = now(), resolved_by = $2
        WHERE id = $1 AND problem IS NOT NULL AND resolved_at IS NULL AND status <> 'unmatched'`,
      [eventId, staffId],
    );
    if (r.rowCount === 0) throw new Error('Not an open, non-unmatched exception');
    await recordAudit(this.pool, {
      actorId: staffId,
      actorKind: 'person',
      action: 'payments.problem.resolved',
      subjectType: 'payment_event',
      subjectId: eventId,
      details: { note },
    });
  }

  async suspenseBalance(financeAccountReference: string): Promise<Kobo> {
    // Suspense is a liability: credits increase it, so flip the sign of the net debit balance.
    return kobo(-(await accountBalance(this.pool, suspenseAccount(financeAccountReference))));
  }
}
