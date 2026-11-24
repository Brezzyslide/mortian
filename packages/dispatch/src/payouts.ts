import { randomUUID } from 'node:crypto';
import type { Messaging, Payouts } from '@project/adapters';
import { AccountNotFoundError } from '@project/adapters';
import { formatNaira, kobo } from '@project/domain';
import { recordAudit, type PoolLike, type Queryable } from '@project/identity';
import { accountBalance, postEntryInTx, type LedgerLine } from '@project/ledger';
import { dsp } from './service.js';

export const payoutAccounts = {
  inTransit: (ref: string) => `dsp:payout_in_transit:${ref}`,
  feeIncome: 'dsp:income:payout_fees',
  feeExpense: 'dsp:expense:transfer_fees',
};

export class PayoutError extends Error {
  constructor(
    readonly code:
      | 'not_a_rider'
      | 'not_configured'
      | 'account_not_found'
      | 'no_bank_account'
      | 'bank_account_not_ready'
      | 'bank_account_rejected'
      | 'not_for_review'
      | 'same_person'
      | 'instant_disabled'
      | 'below_minimum'
      | 'insufficient_balance'
      | 'daily_limit'
      | 'loan_share_not_allowed'
      | 'not_found',
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface PayoutSettings {
  weeklyWeekday: number;
  minPayoutKobo: bigint;
  instantEnabled: boolean;
  instantFeePaidByRider: boolean;
  instantDailyLimitKobo: bigint;
  maxLoanShareBps: number;
  coolingOffHours: number;
}

/** Placeholder rules for testing: Monday payouts, ₦1,000 minimum, rider pays instant fees. */
export const PLACEHOLDER_PAYOUT_SETTINGS: PayoutSettings = {
  weeklyWeekday: 1,
  minPayoutKobo: 100_000n,
  instantEnabled: true,
  instantFeePaidByRider: true,
  instantDailyLimitKobo: 10_000_000n,
  maxLoanShareBps: 5000,
  coolingOffHours: 24,
};

/**
 * Does the bank's name for an account belong to this person? Banks order names differently
 * (surname first), add middle names and truncate, so this compares words, not strings: at least
 * two of the person's names must appear. Accents and dots below are ignored (Adébáyọ̀ = ADEBAYO).
 */
export function nameMatches(verifiedName: string, bankName: string): boolean {
  const words = (s: string) =>
    new Set(
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .split(/[^A-Z]+/)
        .filter((w) => w.length >= 2),
    );
  const mine = words(verifiedName);
  const bank = words(bankName);
  let hits = 0;
  for (const w of mine) if (bank.has(w)) hits++;
  return hits >= Math.min(2, mine.size) && hits > 0;
}

/** Lagos is UTC+1 all year. */
export const lagosDay = (d: Date) => new Date(d.getTime() + 3_600_000).toISOString().slice(0, 10);
const isoWeekday = (day: string) => ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;

async function inTx<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

interface Planned {
  id: string;
  reference: string;
  net: bigint;
  recipientCode: string;
  kind: string;
}

export class PayoutService {
  constructor(
    private readonly pool: PoolLike,
    private readonly payouts: Payouts,
    private readonly messaging: Messaging,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---------------- settings ----------------

  async settings(db: Queryable = this.pool): Promise<(PayoutSettings & { isPlaceholder: boolean }) | null> {
    const r = (await db.query<Record<string, unknown>>('SELECT * FROM payout_setting ORDER BY version DESC LIMIT 1')).rows[0];
    if (!r) return null;
    return {
      weeklyWeekday: r['weekly_weekday'] as number,
      minPayoutKobo: BigInt(r['min_payout_kobo'] as string),
      instantEnabled: r['instant_enabled'] as boolean,
      instantFeePaidByRider: r['instant_fee_paid_by_rider'] as boolean,
      instantDailyLimitKobo: BigInt(r['instant_daily_limit_kobo'] as string),
      maxLoanShareBps: r['max_loan_share_bps'] as number,
      coolingOffHours: r['cooling_off_hours'] as number,
      isPlaceholder: r['is_placeholder'] as boolean,
    };
  }

  async setSettings(s: PayoutSettings, actorId: string | null, isPlaceholder = false) {
    await this.pool.query(
      `INSERT INTO payout_setting (weekly_weekday, min_payout_kobo, instant_enabled, instant_fee_paid_by_rider, instant_daily_limit_kobo,
                                   max_loan_share_bps, cooling_off_hours, is_placeholder, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [s.weeklyWeekday, s.minPayoutKobo.toString(), s.instantEnabled, s.instantFeePaidByRider, s.instantDailyLimitKobo.toString(), s.maxLoanShareBps, s.coolingOffHours, isPlaceholder, actorId, this.clock()],
    );
    await recordAudit(this.pool, { actorId, actorKind: actorId ? 'person' : 'system', action: 'payouts.settings_set', details: { ...s, minPayoutKobo: String(s.minPayoutKobo), instantDailyLimitKobo: String(s.instantDailyLimitKobo) } });
  }

  private async mustSettings(db: Queryable = this.pool) {
    const s = await this.settings(db);
    if (!s) throw new PayoutError('not_configured', 'Payouts are not set up yet');
    return s;
  }

  banks() {
    return this.payouts.banks();
  }

  // ---------------- bank accounts ----------------

  /**
   * Links (or changes) the rider's payout account. The provider's name for the account is
   * compared with the rider's verified name; a mismatch waits for finance. A change starts a
   * cooling-off period and the rider is texted, so a hijacked phone cannot quietly redirect pay.
   */
  async linkBankAccount(personId: string, bankCode: string, accountNumber: string) {
    const settings = await this.mustSettings();
    const rider = (await this.pool.query<{ full_name: string | null; phone: string | null }>(
      'SELECT p.full_name, p.phone FROM rider r JOIN person p ON p.id = r.person_id WHERE r.person_id = $1',
      [personId],
    )).rows[0];
    if (!rider) throw new PayoutError('not_a_rider');
    if (!/^\d{10}$/.test(accountNumber)) throw new PayoutError('account_not_found', 'Account numbers have 10 digits');
    const bank = (await this.payouts.banks()).find((b) => b.code === bankCode);
    if (!bank) throw new PayoutError('account_not_found', 'Choose your bank from the list');
    let accountName: string;
    try {
      accountName = (await this.payouts.resolveAccount(bankCode, accountNumber)).accountName;
    } catch (e) {
      if (e instanceof AccountNotFoundError) throw new PayoutError('account_not_found', 'The bank does not recognise that account number');
      throw e;
    }
    const { recipientCode } = await this.payouts.createRecipient({ name: accountName, bankCode, accountNumber });
    const matched = nameMatches(rider.full_name ?? '', accountName);
    const now = this.clock();

    const { changed, account } = await inTx(this.pool, async (tx) => {
      await tx.query('SELECT 1 FROM rider WHERE person_id = $1 FOR UPDATE', [personId]);
      const prev = (await tx.query<{ id: string }>('SELECT id FROM rider_bank_account WHERE person_id = $1 AND replaced_at IS NULL', [personId])).rows[0];
      if (prev) await tx.query('UPDATE rider_bank_account SET replaced_at = $2 WHERE id = $1', [prev.id, now]);
      const usableFrom = prev ? new Date(now.getTime() + settings.coolingOffHours * 3_600_000) : now;
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO rider_bank_account (person_id, bank_code, bank_name, account_number, account_name, recipient_code, name_check, usable_from, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [personId, bankCode, bank.name, accountNumber, accountName, recipientCode, matched ? 'matched' : 'needs_review', usableFrom, now],
      );
      await recordAudit(tx, { actorId: personId, actorKind: 'person', action: prev ? 'payouts.bank_account_changed' : 'payouts.bank_account_linked', subjectType: 'rider_bank_account', subjectId: rows[0]!.id, details: { bankCode, last4: accountNumber.slice(-4), nameCheck: matched ? 'matched' : 'needs_review' } });
      return { changed: !!prev, account: rows[0]! };
    });
    if (changed && rider.phone) {
      await this.messaging.send('sms', rider.phone, 'payout_account_changed', {
        bank: bank.name,
        last4: accountNumber.slice(-4),
        hours: String(settings.coolingOffHours),
        support: '',
      });
    }
    return { ...(await this.bankAccount(personId))!, id: account.id };
  }

  async bankAccount(personId: string) {
    const r = (await this.pool.query<{ id: string; bank_name: string; account_number: string; account_name: string; name_check: string; usable_from: Date; review_note: string | null }>(
      `SELECT id, bank_name, account_number, account_name, name_check, usable_from, review_note FROM rider_bank_account WHERE person_id = $1 AND replaced_at IS NULL`,
      [personId],
    )).rows[0];
    if (!r) return null;
    return {
      id: r.id,
      bankName: r.bank_name,
      accountNumberMasked: `******${r.account_number.slice(-4)}`,
      accountName: r.account_name,
      nameCheck: r.name_check,
      usableFrom: r.usable_from,
      reviewNote: r.review_note,
      ready: ['matched', 'approved'].includes(r.name_check) && r.usable_from <= this.clock(),
    };
  }

  /** Finance staff: accounts whose name did not match the rider's verified name. */
  async accountsForReview() {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.person_id AS "personId", r.reference AS "riderReference", p.full_name AS "verifiedName", a.account_name AS "accountName",
              a.bank_name AS "bankName", '******' || right(a.account_number, 4) AS "accountNumberMasked", a.created_at AS "createdAt"
         FROM rider_bank_account a JOIN rider r ON r.person_id = a.person_id JOIN person p ON p.id = a.person_id
        WHERE a.name_check = 'needs_review' AND a.replaced_at IS NULL ORDER BY a.created_at`,
    );
    return rows;
  }

  async reviewBankAccount(accountId: string, staffId: string, decision: 'approved' | 'rejected', note: string) {
    const a = (await this.pool.query<{ person_id: string; name_check: string }>('SELECT person_id, name_check FROM rider_bank_account WHERE id = $1', [accountId])).rows[0];
    if (!a) throw new PayoutError('not_found');
    if (a.person_id === staffId) throw new PayoutError('same_person');
    if (a.name_check !== 'needs_review') throw new PayoutError('not_for_review');
    await this.pool.query(
      `UPDATE rider_bank_account SET name_check = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5 WHERE id = $1 AND name_check = 'needs_review'`,
      [accountId, decision, staffId, this.clock(), note],
    );
    await recordAudit(this.pool, { actorId: staffId, actorKind: 'person', action: `payouts.bank_account_${decision}`, subjectType: 'rider_bank_account', subjectId: accountId, details: { note } });
  }

  // ---------------- loan share ----------------

  /** A financed rider chooses what share of each payout goes to their loan (0 to stop). */
  async setLoanShare(personId: string, bps: number) {
    const s = await this.mustSettings();
    const r = (await this.pool.query<{ finance_account_id: string | null }>('SELECT finance_account_id FROM rider WHERE person_id = $1', [personId])).rows[0];
    if (!r) throw new PayoutError('not_a_rider');
    if (!r.finance_account_id && bps > 0) throw new PayoutError('loan_share_not_allowed', 'Only riders with a ride-to-own loan can send earnings to it');
    if (bps < 0 || bps > s.maxLoanShareBps) throw new PayoutError('loan_share_not_allowed', `Choose between 0% and ${s.maxLoanShareBps / 100}%`);
    await this.pool.query('UPDATE rider SET loan_share_bps = $2, loan_share_updated_at = $3 WHERE person_id = $1', [personId, bps, this.clock()]);
    await recordAudit(this.pool, { actorId: personId, actorKind: 'person', action: 'payouts.loan_share_set', subjectType: 'person', subjectId: personId, details: { bps } });
  }

  // ---------------- payouts ----------------

  /** Earned and not yet paid out (cash commissions owed reduce it; never below zero). */
  private async available(db: Queryable, riderRef: string): Promise<bigint> {
    const owed = -(await accountBalance(db, dsp.rider(riderRef)));
    return owed > 0n ? owed : 0n;
  }

  async summary(personId: string) {
    const r = (await this.pool.query<{ reference: string; loan_share_bps: number; finance_account_id: string | null }>('SELECT reference, loan_share_bps, finance_account_id FROM rider WHERE person_id = $1', [personId])).rows[0];
    if (!r) throw new PayoutError('not_a_rider');
    const s = await this.settings();
    const available = await this.available(this.pool, r.reference);
    const today = lagosDay(this.clock());
    const usedToday = await this.instantUsedToday(this.pool, personId, today);
    const fee = this.payouts.transferFee(kobo(available));
    return {
      availableKobo: available.toString(),
      loanShareBps: r.loan_share_bps,
      canSetLoanShare: !!r.finance_account_id,
      bankAccount: await this.bankAccount(personId),
      settings: s && { weeklyWeekday: s.weeklyWeekday, minPayoutKobo: s.minPayoutKobo.toString(), instantEnabled: s.instantEnabled, instantFeePaidByRider: s.instantFeePaidByRider, maxLoanShareBps: s.maxLoanShareBps },
      instantRemainingTodayKobo: s ? (s.instantDailyLimitKobo - usedToday > 0n ? s.instantDailyLimitKobo - usedToday : 0n).toString() : '0',
      instantFeeForAllKobo: s?.instantFeePaidByRider ? fee.toString() : '0',
      history: (await this.pool.query(
        `SELECT reference, kind, trigger, gross_kobo AS "grossKobo", rider_fee_kobo AS "riderFeeKobo", net_kobo AS "netKobo", status, failure_reason AS "failureReason",
                created_at AS "createdAt", completed_at AS "completedAt", '******' || right(destination_account, 4) AS "destination"
           FROM payout WHERE person_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [personId],
      )).rows,
    };
  }

  private async instantUsedToday(db: Queryable, personId: string, day: string): Promise<bigint> {
    const r = await db.query<{ s: string }>(
      `SELECT coalesce(sum(gross_kobo), 0)::text AS s FROM payout
        WHERE person_id = $1 AND trigger = 'instant' AND status <> 'failed'
          AND (created_at AT TIME ZONE 'Africa/Lagos')::date = $2::date`,
      [personId, day],
    );
    return BigInt(r.rows[0]!.s);
  }

  /** A withdrawal the rider asks for now. Without an amount, everything available. */
  async requestInstant(personId: string, amount?: bigint) {
    const planned = await inTx(this.pool, async (tx) => {
      const s = await this.mustSettings(tx);
      if (!s.instantEnabled) throw new PayoutError('instant_disabled', 'Instant withdrawals are switched off; your earnings are paid weekly');
      const rider = await this.lockRider(tx, personId);
      const available = await this.available(tx, rider.reference);
      const gross = amount ?? available;
      if (gross < s.minPayoutKobo) throw new PayoutError('below_minimum', `The minimum withdrawal is ${formatNaira(kobo(s.minPayoutKobo))}`);
      if (gross > available) throw new PayoutError('insufficient_balance', `You can withdraw up to ${formatNaira(kobo(available))}`);
      const used = await this.instantUsedToday(tx, personId, lagosDay(this.clock()));
      if (used + gross > s.instantDailyLimitKobo) throw new PayoutError('daily_limit', `Daily instant limit is ${formatNaira(kobo(s.instantDailyLimitKobo))}`);
      // Each request is its own payout (the rider lock prevents double-spending), so a random key.
      return this.planTx(tx, rider, gross, 'instant', s, `instant:${personId}:${randomUUID()}`);
    });
    return this.send(planned);
  }

  /** The weekly automatic payout: on the configured weekday, every rider's full balance. Idempotent per day. */
  async runWeekly(day = lagosDay(this.clock())) {
    const s = await this.settings();
    if (!s || isoWeekday(day) !== s.weeklyWeekday) return { day, ran: false, payouts: 0, skipped: 0 };
    const riders = (await this.pool.query<{ person_id: string }>(`SELECT person_id FROM rider WHERE status = 'active' ORDER BY person_id`)).rows;
    let payouts = 0;
    let skipped = 0;
    for (const { person_id } of riders) {
      try {
        const planned = await inTx(this.pool, async (tx) => {
          const rider = await this.lockRider(tx, person_id);
          const gross = await this.available(tx, rider.reference);
          if (gross < s.minPayoutKobo) return [];
          return this.planTx(tx, rider, gross, 'weekly', s, `weekly:${person_id}:${day}`);
        });
        if (planned.length) {
          await this.send(planned);
          payouts += planned.length;
        }
      } catch (e) {
        // One rider without a usable account must not stop everyone else's pay.
        if (e instanceof PayoutError) skipped++;
        else if ((e as { constraint?: string }).constraint === 'payout_idempotency_key_key') skipped++;
        else throw e;
      }
    }
    return { day, ran: true, payouts, skipped };
  }

  private async lockRider(tx: Queryable, personId: string) {
    const r = (await tx.query<{ reference: string; loan_share_bps: number; finance_account_id: string | null; full_name: string | null }>(
      `SELECT r.reference, r.loan_share_bps, r.finance_account_id, p.full_name FROM rider r JOIN person p ON p.id = r.person_id WHERE r.person_id = $1 FOR UPDATE OF r`,
      [personId],
    )).rows[0];
    if (!r) throw new PayoutError('not_a_rider');
    return { personId, ...r };
  }

  /**
   * Takes the money out of the rider's earnings in the ledger (under the rider lock, so two
   * withdrawals cannot spend the same balance) and records the payouts. The transfers are started
   * after commit; a failure there puts the money back.
   */
  private async planTx(
    tx: Queryable,
    rider: { personId: string; reference: string; loan_share_bps: number; finance_account_id: string | null; full_name: string | null },
    gross: bigint,
    trigger: 'weekly' | 'instant',
    s: PayoutSettings,
    key: string,
  ): Promise<Planned[]> {
    const acct = (await tx.query<{ id: string; bank_name: string; account_number: string; recipient_code: string; name_check: string; usable_from: Date }>(
      'SELECT id, bank_name, account_number, recipient_code, name_check, usable_from FROM rider_bank_account WHERE person_id = $1 AND replaced_at IS NULL',
      [rider.personId],
    )).rows[0];
    if (!acct) throw new PayoutError('no_bank_account', 'Add your bank account first');
    if (acct.name_check === 'rejected') throw new PayoutError('bank_account_rejected', 'Your bank account was not approved. Add an account in your own name.');
    if (acct.name_check === 'needs_review') throw new PayoutError('bank_account_not_ready', 'We are checking your bank account name');
    if (acct.usable_from > this.clock()) throw new PayoutError('bank_account_not_ready', 'Your new bank account can receive payouts from ' + acct.usable_from.toISOString());

    // Loan share: only while the loan is being repaid, and only to its own repayment account.
    const parts: { kind: 'earnings' | 'loan_repayment'; gross: bigint; bank: string; account: string; recipient: string; bankAccountId: string | null }[] = [];
    let loan = 0n;
    if (rider.loan_share_bps > 0 && rider.finance_account_id) {
      const fa = (await tx.query<{ status: string; account_number: string | null; bank_name: string | null }>(
        `SELECT f.status, v.account_number, v.bank_name FROM finance_account f LEFT JOIN virtual_account v ON v.finance_account_id = f.id WHERE f.id = $1`,
        [rider.finance_account_id],
      )).rows[0];
      const bankCode = fa?.bank_name ? (await this.payouts.banks()).find((b) => b.name === fa.bank_name)?.code : undefined;
      if (fa && ['active', 'in_arrears', 'repossession_review', 'repossessed'].includes(fa.status) && fa.account_number && bankCode) {
        loan = (gross * BigInt(rider.loan_share_bps)) / 10_000n;
        if (loan > 0n) {
          const { recipientCode } = await this.payouts.createRecipient({ name: rider.full_name ?? 'Loan repayment', bankCode, accountNumber: fa.account_number });
          parts.push({ kind: 'loan_repayment', gross: loan, bank: fa.bank_name!, account: fa.account_number, recipient: recipientCode, bankAccountId: null });
        }
      }
    }
    if (gross - loan > 0n) parts.push({ kind: 'earnings', gross: gross - loan, bank: acct.bank_name, account: acct.account_number, recipient: acct.recipient_code, bankAccountId: acct.id });

    const planned: Planned[] = [];
    for (const p of parts) {
      // Instant withdrawals: the rider may bear the fee. Weekly payouts and loan repayments: never.
      const riderFee = trigger === 'instant' && p.kind === 'earnings' && s.instantFeePaidByRider ? BigInt(this.payouts.transferFee(kobo(p.gross))) : 0n;
      if (riderFee >= p.gross) throw new PayoutError('below_minimum', 'The amount is too small to cover the transfer fee');
      const net = p.gross - riderFee;
      const providerFee = BigInt(this.payouts.transferFee(kobo(net)));
      const ref = (await tx.query<{ reference: string; id: string }>(`SELECT 'PO-' || lpad(nextval('payout_ref_seq')::text, 6, '0') AS reference, gen_random_uuid() AS id`)).rows[0]!;
      const lines: LedgerLine[] = [
        { account: dsp.rider(rider.reference), side: 'debit', amount: kobo(p.gross) },
        { account: payoutAccounts.inTransit(ref.reference), side: 'credit', amount: kobo(net) },
        ...(riderFee > 0n ? [{ account: payoutAccounts.feeIncome, side: 'credit' as const, amount: kobo(riderFee) }] : []),
      ];
      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `payout-create:${ref.reference}`,
        source: trigger === 'weekly' ? 'scheduler' : 'system',
        actorId: rider.personId,
        occurredAt: this.clock(),
        description: `${p.kind === 'loan_repayment' ? 'Loan repayment from earnings' : 'Payout'} ${ref.reference} (${trigger})`,
        lines,
      });
      await tx.query(
        `INSERT INTO payout (id, reference, person_id, kind, trigger, gross_kobo, rider_fee_kobo, provider_fee_kobo, net_kobo, bank_account_id,
                             destination_bank, destination_account, recipient_code, idempotency_key, created_entry_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [ref.id, ref.reference, rider.personId, p.kind, trigger, p.gross.toString(), riderFee.toString(), providerFee.toString(), net.toString(), p.bankAccountId, p.bank, p.account, p.recipient, `${key}:${p.kind}`, entryId, this.clock()],
      );
      planned.push({ id: ref.id, reference: ref.reference, net, recipientCode: p.recipient, kind: p.kind });
    }
    return planned;
  }

  private async send(planned: Planned[]) {
    const out = [];
    for (const p of planned) {
      try {
        const r = await this.payouts.transfer({ reference: p.reference, amount: kobo(p.net), recipientCode: p.recipientCode, reason: p.kind === 'loan_repayment' ? 'Loan repayment from earnings' : 'Rider earnings' });
        await this.pool.query(`UPDATE payout SET status = 'sent', provider_transfer_id = $2 WHERE id = $1 AND status = 'pending'`, [p.id, r.providerTransferId]);
        out.push({ reference: p.reference, kind: p.kind, netKobo: p.net.toString(), status: 'sent' });
      } catch (e) {
        await this.settle(p.reference, 'failed', `Could not start transfer: ${(e as Error).message}`, `sync-failure:${p.reference}`);
        out.push({ reference: p.reference, kind: p.kind, netKobo: p.net.toString(), status: 'failed' });
      }
    }
    return out;
  }

  /** Provider webhook: the transfer's final outcome. Exactly once per payout. */
  async transferOutcome(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const o = this.payouts.parseWebhook(rawBody, headers);
    if (!o) return { outcome: 'ignored' as const };
    return this.settle(o.reference, o.status, o.reason, o.providerEventId);
  }

  private async settle(reference: string, status: 'succeeded' | 'failed', reason: string | null, eventId: string) {
    const provider = this.payouts.info.provider;
    return inTx(this.pool, async (tx) => {
      const p = (await tx.query<{ id: string; person_id: string; status: string; gross_kobo: string; rider_fee_kobo: string; provider_fee_kobo: string; net_kobo: string; kind: string }>(
        'SELECT id, person_id, status, gross_kobo, rider_fee_kobo, provider_fee_kobo, net_kobo, kind FROM payout WHERE reference = $1 FOR UPDATE',
        [reference],
      )).rows[0];
      if (!p) return { outcome: 'unknown' as const };
      if (p.status === 'succeeded' || p.status === 'failed') return { outcome: 'duplicate' as const, status: p.status };
      const riderRef = (await tx.query<{ reference: string }>('SELECT reference FROM rider WHERE person_id = $1', [p.person_id])).rows[0]!.reference;
      const net = BigInt(p.net_kobo);
      const lines: LedgerLine[] =
        status === 'succeeded'
          ? [
              { account: payoutAccounts.inTransit(reference), side: 'debit', amount: kobo(net) },
              { account: dsp.clearing(provider), side: 'credit', amount: kobo(net) },
              ...(BigInt(p.provider_fee_kobo) > 0n
                ? [
                    { account: payoutAccounts.feeExpense, side: 'debit' as const, amount: kobo(BigInt(p.provider_fee_kobo)) },
                    { account: dsp.clearing(provider), side: 'credit' as const, amount: kobo(BigInt(p.provider_fee_kobo)) },
                  ]
                : []),
            ]
          : [
              // Failed: everything goes back to the rider, including any fee they were charged.
              { account: payoutAccounts.inTransit(reference), side: 'debit', amount: kobo(net) },
              ...(BigInt(p.rider_fee_kobo) > 0n ? [{ account: payoutAccounts.feeIncome, side: 'debit' as const, amount: kobo(BigInt(p.rider_fee_kobo)) }] : []),
              { account: dsp.rider(riderRef), side: 'credit', amount: kobo(BigInt(p.gross_kobo)) },
            ];
      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `payout-settle:${reference}`,
        source: eventId.startsWith('sync-failure') ? 'system' : 'webhook',
        actorId: `payouts:${provider}`,
        occurredAt: this.clock(),
        description: `Payout ${reference} ${status}${reason ? `: ${reason}` : ''} (event ${eventId})`,
        lines,
      });
      await tx.query(`UPDATE payout SET status = $2, failure_reason = $3, settled_entry_id = $4, completed_at = $5 WHERE id = $1`, [p.id, status, reason, entryId, this.clock()]);
      return { outcome: status, reference };
    });
  }

  /** Staff: every payout, newest first. */
  async list(status?: string) {
    const { rows } = await this.pool.query(
      `SELECT po.reference, po.kind, po.trigger, po.gross_kobo AS "grossKobo", po.net_kobo AS "netKobo", po.rider_fee_kobo AS "riderFeeKobo",
              po.provider_fee_kobo AS "providerFeeKobo", po.status, po.failure_reason AS "failureReason", po.created_at AS "createdAt",
              po.completed_at AS "completedAt", r.reference AS "riderReference", p.full_name AS "riderName", po.destination_bank AS "destinationBank",
              '******' || right(po.destination_account, 4) AS "destination"
         FROM payout po JOIN rider r ON r.person_id = po.person_id JOIN person p ON p.id = po.person_id
        ${status ? 'WHERE po.status = $1' : ''} ORDER BY po.created_at DESC LIMIT 300`,
      status ? [status] : [],
    );
    return rows;
  }
}
