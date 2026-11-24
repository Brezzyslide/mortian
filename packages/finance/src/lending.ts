import { kobo, type Kobo } from '@project/domain';
import { recordAudit, type PoolLike, type Queryable } from '@project/identity';
import { accountBalance, postEntryInTx, type EntryDraft, type LedgerLine } from '@project/ledger';
import { allocate, DEFAULT_WATERFALL, type Bucket, type Due } from './allocation.js';
import { reactivationAmountOf, reactivationSteps, type ArrearsStep } from './arrears.js';
import { accountAssetTx, moveAccountAssetTx, productNeedsAsset } from './assets.js';
import { suspenseAccount, type FinanceProductCode } from './collections.js';
import { addPeriods, daysBetween, depositOf, financedPrincipalOf, generateSchedule, lagosDate } from './schedule.js';
import { resolveTerms, validateTierConfig, type NumericTerm, type TermSet, type TierConfig } from './terms.js';

export const acct = {
  principal: (ref: string) => `fin:receivable:principal:${ref}`,
  interest: (ref: string) => `fin:receivable:interest:${ref}`,
  fees: (ref: string) => `fin:receivable:fees:${ref}`,
  penalty: (ref: string) => `fin:receivable:penalty:${ref}`,
  suspense: suspenseAccount,
  assetSales: 'fin:sales:asset',
  interestIncome: 'fin:income:interest',
  feeIncome: 'fin:income:fees',
  feeWaivers: 'fin:expense:fee_waivers',
  /** Buyer money for a resold asset, until finance matches it to the bank deposit. */
  resaleClearing: 'fin:clearing:asset_resale',
  /** Resale proceeds beyond what the borrower owed: owed back to them. */
  surplus: (ref: string) => `fin:payable:resale_surplus:${ref}`,
};

export type ApprovalKind = 'terms_out_of_bounds' | 'fee_waiver' | 'repossession' | 'release' | 'close_recovered' | 'asset_sale';
export type RecoveryKind = 'repossession' | 'release' | 'close_recovered' | 'asset_sale';

class DryRun extends Error {}

export class LendingError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_status'
      | 'invalid_tier_config'
      | 'tier_not_found'
      | 'needs_second_approver'
      | 'same_person'
      | 'deposit_not_paid'
      | 'fee_not_open'
      | 'no_asset',
    message: string = code,
  ) {
    super(message);
    this.name = 'LendingError';
  }
}

interface AccountRow {
  id: string;
  reference: string;
  status: string;
  product_code: FinanceProductCode;
  current_snapshot_id: string | null;
}

export interface Statement {
  readonly reference: string;
  readonly status: string;
  readonly tier: string | null;
  readonly isPlaceholderTerms: boolean;
  readonly asOf: string;
  readonly outstanding: { principal: Kobo; interest: Kobo; fees: Kobo; penalty: Kobo; total: Kobo };
  readonly credit: Kobo;
  readonly missed: { instalments: number; amount: Kobo; oldestDueDate: string | null; daysOverdue: number };
  readonly next: { dueDate: string; amount: Kobo } | null;
  readonly paidOffPercent: number;
  readonly schedule: readonly {
    seq: number;
    dueDate: string;
    principal: Kobo;
    interest: Kobo;
    paid: Kobo;
    state: 'paid' | 'part_paid' | 'missed' | 'due' | 'upcoming';
  }[];
  /** Present whenever anything is overdue or the account is in review, repossessed or closed. */
  readonly arrears: {
    readonly reactivationAmount: Kobo;
    readonly penaltyOutstanding: Kobo;
    readonly feesOutstanding: Kobo;
    readonly arrearsSince: string | null;
    readonly reviewStartsOn: string | null;
    readonly reviewStartedOn: string | null;
    readonly cureDeadline: string | null;
    readonly cureDeadlinePassed: boolean;
    readonly repossessedOn: string | null;
    readonly steps: readonly ArrearsStep[];
  } | null;
}

export interface LendingOptions {
  /**
   * When true (the default) an asset can only be handed over once the contract is fully signed
   * (status 'contracted'). False exists only for tests that exercise lending without contracts;
   * the API refuses it in production.
   */
  readonly requireSignedContract?: boolean;
  /**
   * When true (the default) handover of a product that finances an asset needs a registered,
   * assigned asset. False exists only for tests that exercise lending without the register.
   */
  readonly requireAsset?: boolean;
}

export class LendingService {
  private readonly requireSignedContract: boolean;
  private readonly requireAsset: boolean;

  constructor(
    private readonly pool: PoolLike,
    private readonly clock: () => Date = () => new Date(),
    options: LendingOptions = {},
  ) {
    this.requireSignedContract = options.requireSignedContract ?? true;
    this.requireAsset = options.requireAsset ?? true;
  }

  today(): string {
    return lagosDate(this.clock());
  }

  // ---------------- Tier presets ----------------

  async publishTier(
    productCode: FinanceProductCode,
    tier: string,
    config: TierConfig,
    opts: { actorId: string | null; isPlaceholder: boolean; note?: string },
  ): Promise<{ id: string; version: number }> {
    const problems = validateTierConfig(config);
    if (problems.length) throw new LendingError('invalid_tier_config', `Invalid fields: ${problems.join(', ')}`);
    return inTx(this.pool, async (tx) => {
      // Serialise concurrent publishers of the same tier so versions never collide.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tier:${productCode}:${tier}`]);
      const { rows } = await tx.query<{ id: string; version: number }>(
        `INSERT INTO product_tier (product_code, tier, version, config, is_placeholder, note, created_by)
         SELECT $1, $2, coalesce(max(version), 0) + 1, $3, $4, $5, $6
           FROM product_tier WHERE product_code = $1 AND tier = $2
         RETURNING id, version`,
        [productCode, tier, JSON.stringify(config), opts.isPlaceholder, opts.note ?? null, opts.actorId],
      );
      await recordAudit(tx, {
        actorId: opts.actorId,
        actorKind: opts.actorId ? 'person' : 'system',
        action: 'lending.tier.published',
        subjectType: 'product_tier',
        subjectId: rows[0]!.id,
        details: { productCode, tier, version: rows[0]!.version, isPlaceholder: opts.isPlaceholder },
      });
      return rows[0]!;
    });
  }

  async currentTiers(productCode: FinanceProductCode) {
    const { rows } = await this.pool.query<{
      id: string;
      tier: string;
      version: number;
      config: TierConfig;
      is_placeholder: boolean;
      created_at: Date;
    }>(
      `SELECT id, tier, version, config, is_placeholder, created_at
         FROM product_tier_current WHERE product_code = $1 ORDER BY tier`,
      [productCode],
    );
    return rows;
  }

  // ---------------- Approval → term snapshot ----------------

  /**
   * Underwriter approves an application on a tier, optionally adjusting terms.
   * Adjustments outside the tier's bounds need a second, different approver and a reason.
   * The resolved terms are frozen into an immutable snapshot.
   */
  async approve(input: {
    financeAccountId: string;
    tier: string;
    assetPriceKobo: string;
    adjustments?: Partial<Pick<TermSet, NumericTerm>>;
    underwriterId: string;
    secondApprover?: { personId: string; reason: string };
  }): Promise<{ snapshotId: string; terms: TermSet; outOfBounds: string[] }> {
    return inTx(this.pool, (tx) => this.approveTx(tx, input));
  }

  private async approveTx(
    tx: Queryable,
    input: Parameters<LendingService['approve']>[0],
  ): Promise<{ snapshotId: string; terms: TermSet; outOfBounds: string[] }> {
    {
      const fa = await lockAccount(tx, input.financeAccountId);
      if (fa.status !== 'applied') throw new LendingError('invalid_status', `Account is ${fa.status}, not applied`);

      const t = await tx.query<{ id: string; config: TierConfig; is_placeholder: boolean }>(
        'SELECT id, config, is_placeholder FROM product_tier_current WHERE product_code = $1 AND tier = $2',
        [fa.product_code, input.tier],
      );
      const tierRow = t.rows[0];
      if (!tierRow) throw new LendingError('tier_not_found');

      const resolved = resolveTerms(tierRow.config, { assetPriceKobo: input.assetPriceKobo, ...input.adjustments });
      if (resolved.outOfBounds.length > 0) {
        if (!input.secondApprover) {
          throw new LendingError('needs_second_approver', `Outside tier bounds: ${resolved.outOfBounds.join(', ')}`);
        }
        if (input.secondApprover.personId === input.underwriterId) throw new LendingError('same_person');
      }

      const snap = await tx.query<{ id: string }>(
        `INSERT INTO term_snapshot
           (finance_account_id, version, product_tier_id, tier, terms, overridden, out_of_bounds, is_placeholder,
            created_by, approved_by, reason)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          fa.id,
          tierRow.id,
          input.tier,
          JSON.stringify(resolved.terms),
          resolved.overridden,
          resolved.outOfBounds,
          tierRow.is_placeholder,
          input.underwriterId,
          input.secondApprover?.personId ?? null,
          input.secondApprover?.reason ?? null,
        ],
      );
      const snapshotId = snap.rows[0]!.id;
      await tx.query(`UPDATE finance_account SET status = 'approved', current_snapshot_id = $2 WHERE id = $1`, [
        fa.id,
        snapshotId,
      ]);
      await recordAudit(tx, {
        actorId: input.underwriterId,
        actorKind: 'person',
        action: 'lending.application.approved',
        subjectType: 'finance_account',
        subjectId: fa.reference,
        details: {
          tier: input.tier,
          snapshotId,
          overridden: resolved.overridden,
          outOfBounds: resolved.outOfBounds,
          secondApprover: input.secondApprover?.personId ?? null,
        },
      });
      return { snapshotId, terms: resolved.terms, outOfBounds: resolved.outOfBounds };
    }
  }

  // ---------------- Activation ----------------

  /**
   * Hands over the asset: applies the deposit from credit, books the financed principal,
   * and generates the schedule from the frozen snapshot. The deposit must already be in credit.
   * Requires a fully signed contract (status 'contracted') unless the service was built for tests without one.
   */
  async activate(financeAccountId: string, actorId: string, startDate: string = this.today()) {
    return inTx(this.pool, async (tx) => {
      const fa = await lockAccount(tx, financeAccountId);
      const allowed = this.requireSignedContract ? ['contracted'] : ['approved', 'contracted'];
      if (!allowed.includes(fa.status) || !fa.current_snapshot_id) {
        throw new LendingError(
          'invalid_status',
          fa.status === 'approved' && this.requireSignedContract
            ? 'The contract must be fully signed before handover'
            : `Account is ${fa.status}`,
        );
      }
      const asset = await accountAssetTx(tx, fa.id);
      if (!asset && this.requireAsset && productNeedsAsset(fa.product_code)) {
        throw new LendingError('no_asset', 'Assign a registered asset to this account before handover');
      }
      const terms = await snapshotTerms(tx, fa.current_snapshot_id);
      const deposit = depositOf(terms);
      const financed = financedPrincipalOf(terms);
      const credit = await creditOf(tx, fa.reference);
      if (credit < deposit) {
        throw new LendingError('deposit_not_paid', `Deposit ${deposit} kobo required, ${credit} kobo in credit`);
      }

      const lines: LedgerLine[] = [
        { account: acct.principal(fa.reference), side: 'debit', amount: kobo(financed) },
        { account: acct.assetSales, side: 'credit', amount: kobo(BigInt(terms.assetPriceKobo)) },
      ];
      if (deposit > 0n) lines.push({ account: acct.suspense(fa.reference), side: 'debit', amount: kobo(deposit) });
      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `activate:${fa.reference}:${fa.current_snapshot_id}`,
        source: 'admin',
        actorId,
        occurredAt: this.clock(),
        description: `Activation of ${fa.reference}: asset price ${terms.assetPriceKobo}, deposit ${deposit}`,
        lines,
      });

      const schedule = generateSchedule(terms, startDate);
      await tx.query(
        `INSERT INTO instalment (finance_account_id, snapshot_id, seq, due_date, principal_due, interest_due)
         SELECT $1, $2, s, d::date, p::bigint, i::bigint
           FROM unnest($3::int[], $4::text[], $5::text[], $6::text[]) AS t(s, d, p, i)`,
        [
          fa.id,
          fa.current_snapshot_id,
          schedule.map((x) => x.seq),
          schedule.map((x) => x.dueDate),
          schedule.map((x) => x.principal.toString()),
          schedule.map((x) => x.interest.toString()),
        ],
      );
      await tx.query(`UPDATE finance_account SET status = 'active', activated_on = $2 WHERE id = $1`, [fa.id, startDate]);
      if (asset) {
        await moveAccountAssetTx(tx, fa.id, { from: ['assigned'], to: 'with_customer', event: 'handed_over', actorId, at: this.clock(), location: 'With customer' });
      }
      await recordAudit(tx, {
        actorId,
        actorKind: 'person',
        action: 'lending.account.activated',
        subjectType: 'finance_account',
        subjectId: fa.reference,
        details: { entryId, instalments: schedule.length, startDate },
      });
      return { entryId, instalments: schedule.length, deposit, financed };
    });
  }

  // ---------------- Due-date processing and allocation ----------------

  /**
   * Books interest for every instalment due on or before `asOf`, then applies available
   * credit through the waterfall. Safe to run any number of times for the same date.
   * `trigger` names what caused the run (a payment event id, or a daily job date).
   */
  async applyCredit(financeAccountId: string, trigger: string, asOf: string = this.today()) {
    return inTx(this.pool, async (tx) => {
      const fa = await lockAccount(tx, financeAccountId);
      if (!fa.current_snapshot_id || ['applied', 'approved', 'contracted', 'declined', 'withdrawn'].includes(fa.status)) {
        return { allocated: 0n, remainingCredit: await creditOf(tx, fa.reference) };
      }
      await this.accrueDueInterest(tx, fa, asOf);

      // A trigger is applied once. Re-running it later (when balances have moved) is a no-op,
      // not a conflicting second allocation under the same key.
      const key = `alloc:${fa.reference}:${trigger}`;
      const seen = await tx.query('SELECT 1 FROM ledger_entry WHERE idempotency_key = $1', [key]);
      if (seen.rows.length > 0) return { allocated: 0n, remainingCredit: await creditOf(tx, fa.reference) };

      const dues = await duesOf(tx, fa, asOf);
      const credit = await creditOf(tx, fa.reference);
      const { allocations, remaining } = allocate(dues, credit, asOf, DEFAULT_WATERFALL as Bucket[]);
      const total = credit - remaining;
      if (total === 0n) return { allocated: 0n, remainingCredit: credit };

      const byAccount = new Map<string, bigint>();
      const credit_ = (account: string, a: bigint) => byAccount.set(account, (byAccount.get(account) ?? 0n) + a);
      for (const a of allocations) {
        const target =
          a.component === 'fee'
            ? acct.fees(fa.reference)
            : a.component === 'penalty'
              ? acct.penalty(fa.reference)
              : a.component === 'interest'
                ? acct.interest(fa.reference)
                : acct.principal(fa.reference);
        credit_(target, a.allocated);
      }
      const entry: EntryDraft = {
        idempotencyKey: key,
        source: 'system',
        actorId: 'allocation-engine',
        occurredAt: this.clock(),
        description: `Apply ${total} kobo credit to ${fa.reference} (${trigger})`,
        lines: [
          { account: acct.suspense(fa.reference), side: 'debit', amount: kobo(total) },
          ...[...byAccount].map(([account, amount]) => ({ account, side: 'credit' as const, amount: kobo(amount) })),
        ],
      };
      const posted = await postEntryInTx(tx, entry);
      if (posted.duplicate) return { allocated: 0n, remainingCredit: credit };

      for (const a of allocations) {
        await tx.query(
          `INSERT INTO allocation (finance_account_id, ledger_entry_id, component, instalment_id, fee_charge_id, amount)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            fa.id,
            posted.entryId,
            a.component,
            'instalmentId' in a ? a.instalmentId : null,
            'feeChargeId' in a ? a.feeChargeId : null,
            a.allocated.toString(),
          ],
        );
      }
      await this.settleIfComplete(tx, fa);
      return { allocated: total, remainingCredit: remaining };
    });
  }

  private async accrueDueInterest(tx: Queryable, fa: AccountRow, asOf: string): Promise<void> {
    const { rows } = await tx.query<{ id: string; seq: number; interest_due: string; due_date: string }>(
      `SELECT id::text, seq, interest_due::text, to_char(due_date, 'YYYY-MM-DD') AS due_date
         FROM instalment
        WHERE finance_account_id = $1 AND snapshot_id = $2 AND due_date <= $3
          AND interest_accrued_entry_id IS NULL AND interest_due > 0
        ORDER BY seq`,
      [fa.id, fa.current_snapshot_id, asOf],
    );
    for (const r of rows) {
      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `accrue:interest:${r.id}`,
        source: 'scheduler',
        actorId: 'due-date-job',
        occurredAt: new Date(`${r.due_date}T00:00:00+01:00`),
        description: `Interest due on ${fa.reference} instalment ${r.seq}`,
        lines: [
          { account: acct.interest(fa.reference), side: 'debit', amount: kobo(BigInt(r.interest_due)) },
          { account: acct.interestIncome, side: 'credit', amount: kobo(BigInt(r.interest_due)) },
        ],
      });
      await tx.query('UPDATE instalment SET interest_accrued_entry_id = $2 WHERE id = $1', [r.id, entryId]);
    }
  }

  private async settleIfComplete(tx: Queryable, fa: AccountRow): Promise<void> {
    const left = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM instalment i
        WHERE i.finance_account_id = $1 AND i.snapshot_id = $2
          AND i.principal_due + i.interest_due >
              coalesce((SELECT sum(amount) FROM allocation a WHERE a.instalment_id = i.id), 0)`,
      [fa.id, fa.current_snapshot_id],
    );
    const owed =
      (await accountBalance(tx, acct.principal(fa.reference))) +
      (await accountBalance(tx, acct.interest(fa.reference))) +
      (await accountBalance(tx, acct.fees(fa.reference))) +
      (await accountBalance(tx, acct.penalty(fa.reference)));
    if (left.rows[0]!.n === 0 && owed === 0n) {
      await tx.query(`UPDATE finance_account SET status = 'settled', settled_on = $2 WHERE id = $1`, [fa.id, this.today()]);
      if (await accountAssetTx(tx, fa.id)) {
        await moveAccountAssetTx(tx, fa.id, { from: ['with_customer'], to: 'paid_off', event: 'paid_off', actorId: null, at: this.clock() });
      }
      await recordAudit(tx, {
        actorKind: 'system',
        action: 'lending.account.settled',
        subjectType: 'finance_account',
        subjectId: fa.reference,
      });
    }
  }

  // ---------------- Fees ----------------

  async chargeFee(financeAccountId: string, code: string, amount: Kobo, actorId: string): Promise<string> {
    if (amount <= 0n) throw new Error('fee amount must be positive');
    return inTx(this.pool, async (tx) => {
      const fa = await lockAccount(tx, financeAccountId);
      const id = (await tx.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `fee:${id}`,
        source: 'admin',
        actorId,
        occurredAt: this.clock(),
        description: `Fee ${code} on ${fa.reference}`,
        lines: [
          { account: acct.fees(fa.reference), side: 'debit', amount },
          { account: acct.feeIncome, side: 'credit', amount },
        ],
      });
      await tx.query(
        `INSERT INTO fee_charge (id, finance_account_id, code, amount, charged_entry_id, charged_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, fa.id, code, amount.toString(), entryId, actorId],
      );
      await recordAudit(tx, {
        actorId,
        actorKind: 'person',
        action: 'lending.fee.charged',
        subjectType: 'finance_account',
        subjectId: fa.reference,
        details: { feeChargeId: id, code, amount: amount.toString() },
      });
      return id;
    });
  }

  /** Management waiver of what remains unpaid on a fee. Requester and approver must differ. */
  async waiveFee(feeChargeId: string, requestedBy: string, approvedBy: string, reason: string): Promise<Kobo> {
    return inTx(this.pool, (tx) => this.waiveFeeTx(tx, feeChargeId, requestedBy, approvedBy, reason));
  }

  private async waiveFeeTx(
    tx: Queryable,
    feeChargeId: string,
    requestedBy: string,
    approvedBy: string,
    reason: string,
  ): Promise<Kobo> {
    if (requestedBy === approvedBy) throw new LendingError('same_person');
    {
      const { rows } = await tx.query<{ finance_account_id: string; amount: string; status: string; paid: string }>(
        `SELECT f.finance_account_id, f.amount::text, f.status,
                coalesce((SELECT sum(amount) FROM allocation a WHERE a.fee_charge_id = f.id), 0)::text AS paid
           FROM fee_charge f WHERE f.id = $1 FOR UPDATE`,
        [feeChargeId],
      );
      const f = rows[0];
      if (!f || f.status !== 'open') throw new LendingError('fee_not_open');
      const fa = await lockAccount(tx, f.finance_account_id);
      const remaining = BigInt(f.amount) - BigInt(f.paid);
      if (remaining <= 0n) throw new LendingError('fee_not_open', 'Fee is already fully paid');

      const { entryId } = await postEntryInTx(tx, {
        idempotencyKey: `fee-waiver:${feeChargeId}`,
        source: 'admin',
        actorId: approvedBy,
        occurredAt: this.clock(),
        description: `Waiver of fee ${feeChargeId} on ${fa.reference}: ${reason}`,
        lines: [
          { account: acct.feeWaivers, side: 'debit', amount: kobo(remaining) },
          { account: acct.fees(fa.reference), side: 'credit', amount: kobo(remaining) },
        ],
      });
      await tx.query(
        `UPDATE fee_charge SET status = 'waived', waiver_requested_by = $2, waiver_approved_by = $3,
                waiver_reason = $4, waiver_entry_id = $5, waived_at = now()
          WHERE id = $1`,
        [feeChargeId, requestedBy, approvedBy, reason, entryId],
      );
      await recordAudit(tx, {
        actorId: approvedBy,
        actorKind: 'person',
        action: 'lending.fee.waived',
        subjectType: 'finance_account',
        subjectId: fa.reference,
        details: { feeChargeId, requestedBy, amount: remaining.toString(), reason },
      });
      return kobo(remaining);
    }
  }

  // ---------------- Two-person approvals ----------------

  /** Proposes an action that needs a second person. One pending request per kind per account. */
  async requestApproval(input: {
    kind: ApprovalKind;
    financeAccountId: string;
    payload: Record<string, unknown>;
    reason: string;
    requestedBy: string;
  }): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO approval_request (kind, finance_account_id, payload, reason, requested_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.kind, input.financeAccountId, JSON.stringify(input.payload), input.reason, input.requestedBy],
    );
    await recordAudit(this.pool, {
      actorId: input.requestedBy,
      actorKind: 'person',
      action: `approval.requested.${input.kind}`,
      subjectType: 'approval_request',
      subjectId: rows[0]!.id,
      details: { financeAccountId: input.financeAccountId },
    });
    return rows[0]!.id;
  }

  /**
   * A different staff member approves or rejects. Approval performs the action in the same
   * transaction, so a request is never marked approved without its effect, or vice versa.
   */
  async decideApproval(requestId: string, deciderId: string, decision: 'approved' | 'rejected', note: string) {
    return inTx(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        kind: ApprovalKind;
        finance_account_id: string;
        payload: Record<string, unknown>;
        reason: string;
        requested_by: string;
        status: string;
      }>(
        `SELECT kind, finance_account_id, payload, reason, requested_by, status
           FROM approval_request WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      const r = rows[0];
      if (!r) throw new LendingError('not_found');
      if (r.status !== 'pending') throw new LendingError('invalid_status', `Request is ${r.status}`);
      if (r.requested_by === deciderId) throw new LendingError('same_person');

      let result: unknown = null;
      if (decision === 'approved') {
        if (r.kind === 'terms_out_of_bounds') {
          const p = r.payload as { tier: string; assetPriceKobo: string; adjustments?: Partial<Pick<TermSet, NumericTerm>> };
          result = await this.approveTx(tx, {
            financeAccountId: r.finance_account_id,
            tier: p.tier,
            assetPriceKobo: p.assetPriceKobo,
            ...(p.adjustments ? { adjustments: p.adjustments } : {}),
            underwriterId: r.requested_by,
            secondApprover: { personId: deciderId, reason: `${r.reason} | approved: ${note}` },
          });
        } else if (r.kind === 'fee_waiver') {
          const p = r.payload as { feeChargeId: string };
          result = { waived: (await this.waiveFeeTx(tx, p.feeChargeId, r.requested_by, deciderId, r.reason)).toString() };
        } else {
          result = await this.recoveryActionTx(tx, r.kind, r.finance_account_id, r.payload, deciderId);
        }
      }
      await tx.query(
        `UPDATE approval_request SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
        [requestId, decision, deciderId, note],
      );
      await recordAudit(tx, {
        actorId: deciderId,
        actorKind: 'person',
        action: `approval.${decision}.${r.kind}`,
        subjectType: 'approval_request',
        subjectId: requestId,
        details: { note },
      });
      return { status: decision, result };
    });
  }

  /** Checks a recovery action is possible now, so a request is refused early rather than at approval. */
  async assertRecoveryAllowed(kind: RecoveryKind, financeAccountId: string, payload: Record<string, unknown> = {}): Promise<void> {
    await inTx(this.pool, async (tx) => {
      await this.recoveryActionTx(tx, kind, financeAccountId, payload, null);
      throw new DryRun();
    }).catch((err) => {
      if (!(err instanceof DryRun)) throw err;
    });
  }

  /**
   * Repossession, release and closure. Only reachable through decideApproval (two people);
   * decider null means a dry run used to validate a request before it is filed.
   */
  private async recoveryActionTx(
    tx: Queryable,
    kind: RecoveryKind,
    financeAccountId: string,
    payload: Record<string, unknown>,
    deciderId: string | null,
  ) {
    const row = (
      await tx.query<AccountRow & { cure_deadline: string | null }>(
        `SELECT id, reference, status, product_code, current_snapshot_id, to_char(cure_deadline, 'YYYY-MM-DD') AS cure_deadline
           FROM finance_account WHERE id = $1 FOR UPDATE`,
        [financeAccountId],
      )
    ).rows[0];
    if (!row || !row.current_snapshot_id) throw new LendingError('not_found');
    const today = this.today();

    if (kind === 'repossession') {
      if (row.status !== 'repossession_review') {
        throw new LendingError('invalid_status', `Repossession needs repossession_review; account is ${row.status}`);
      }
      const asset = await accountAssetTx(tx, row.id);
      if (asset && asset.status !== 'with_customer') throw new LendingError('invalid_status', `Asset is ${asset.status}, not with the customer`);
      if (deciderId === null) return null;
      await tx.query(`UPDATE finance_account SET status = 'repossessed', repossessed_on = $2 WHERE id = $1`, [row.id, today]);
      if (asset) {
        const where = typeof payload['location'] === 'string' ? (payload['location'] as string) : null;
        await moveAccountAssetTx(tx, row.id, { from: ['with_customer'], to: 'recovered', event: 'recovered', actorId: deciderId, at: this.clock(), location: where, details: payload });
      }
      await recordAudit(tx, {
        actorId: deciderId,
        actorKind: 'person',
        action: 'arrears.repossessed',
        subjectType: 'finance_account',
        subjectId: row.reference,
        details: payload,
      });
      return { status: 'repossessed', repossessedOn: today };
    }

    if (kind === 'release') {
      if (row.status !== 'repossessed') throw new LendingError('invalid_status', `Release needs repossessed; account is ${row.status}`);
      const r = await reactivationAmountOf(tx, { ...row, current_snapshot_id: row.current_snapshot_id }, today);
      if (r.total > 0n) {
        throw new LendingError('invalid_status', `Reactivation amount not cleared: ${r.total} kobo still owed`);
      }
      const asset = await accountAssetTx(tx, row.id);
      if (asset && asset.status !== 'recovered') throw new LendingError('invalid_status', `Asset is ${asset.status}; it can only be returned from the yard`);
      if (deciderId === null) return null;
      if (asset) {
        await moveAccountAssetTx(tx, row.id, { from: ['recovered'], to: 'with_customer', event: 'returned', actorId: deciderId, at: this.clock(), location: 'With customer' });
      }
      await tx.query(
        `UPDATE finance_account SET status = 'active', arrears_since = NULL, review_started_on = NULL,
                cure_deadline = NULL, repossessed_on = NULL WHERE id = $1`,
        [row.id],
      );
      await recordAudit(tx, {
        actorId: deciderId,
        actorKind: 'person',
        action: 'arrears.reactivated',
        subjectType: 'finance_account',
        subjectId: row.reference,
        details: payload,
      });
      return { status: 'active' };
    }

    if (kind === 'asset_sale') return this.assetSaleTx(tx, row, payload, deciderId);

    // close_recovered
    if (!['repossession_review', 'repossessed'].includes(row.status)) {
      throw new LendingError('invalid_status', `Closing needs review or repossessed; account is ${row.status}`);
    }
    if (!row.cure_deadline || row.cure_deadline >= today) {
      throw new LendingError('invalid_status', `Cure deadline ${row.cure_deadline ?? 'not set'} has not passed`);
    }
    if (deciderId === null) return null;
    await tx.query(`UPDATE finance_account SET status = 'closed_recovered', closed_on = $2 WHERE id = $1`, [row.id, today]);
    // A recovered asset becomes available to sell; one still with the customer stays recorded there.
    if ((await accountAssetTx(tx, row.id))?.status === 'recovered') {
      await moveAccountAssetTx(tx, row.id, { from: ['recovered'], to: 'for_sale', event: 'listed_for_sale', actorId: deciderId, at: this.clock() });
    }
    await recordAudit(tx, {
      actorId: deciderId,
      actorKind: 'person',
      action: 'arrears.closed_recovered',
      subjectType: 'finance_account',
      subjectId: row.reference,
      details: payload,
    });
    return { status: 'closed_recovered', closedOn: today };
  }

  /**
   * Sells a recovered asset of a closed account. The proceeds pay down what the borrower still
   * owes in the usual order (fees, penalty, interest, principal); any surplus is recorded as owed
   * back to the borrower. A shortfall stays on the account. Money arrives in the resale clearing
   * account for finance to match against the bank deposit.
   */
  private async assetSaleTx(
    tx: Queryable,
    row: AccountRow,
    payload: Record<string, unknown>,
    deciderId: string | null,
  ) {
    if (row.status !== 'closed_recovered') throw new LendingError('invalid_status', `Sale needs a closed account; account is ${row.status}`);
    const asset = await accountAssetTx(tx, row.id);
    if (!asset) throw new LendingError('no_asset', 'This account has no registered asset');
    if (asset.status !== 'for_sale') throw new LendingError('invalid_status', `Asset is ${asset.status}, not for sale`);
    const price = BigInt(String(payload['priceKobo'] ?? '0'));
    if (price <= 0n) throw new LendingError('invalid_status', 'Sale price must be more than zero');
    if (deciderId === null) return null;

    const owed: [string, bigint][] = [
      [acct.fees(row.reference), await accountBalance(tx, acct.fees(row.reference))],
      [acct.penalty(row.reference), await accountBalance(tx, acct.penalty(row.reference))],
      [acct.interest(row.reference), await accountBalance(tx, acct.interest(row.reference))],
      [acct.principal(row.reference), await accountBalance(tx, acct.principal(row.reference))],
    ];
    let left = price;
    const lines: LedgerLine[] = [{ account: acct.resaleClearing, side: 'debit', amount: kobo(price) }];
    const applied: Record<string, string> = {};
    for (const [account, balance] of owed) {
      const take = balance > 0n ? (left < balance ? left : balance) : 0n;
      if (take > 0n) {
        lines.push({ account, side: 'credit', amount: kobo(take) });
        applied[account.split(':')[2]!] = take.toString();
        left -= take;
      }
    }
    if (left > 0n) lines.push({ account: acct.surplus(row.reference), side: 'credit', amount: kobo(left) });
    const { entryId } = await postEntryInTx(tx, {
      idempotencyKey: `asset_sale:${asset.id}`,
      source: 'admin',
      actorId: deciderId,
      occurredAt: this.clock(),
      description: `Resale of the asset recovered from ${row.reference}`,
      lines,
    });
    const shortfall = owed.reduce((sum, [, b]) => sum + (b > 0n ? b : 0n), 0n) - (price - left);
    const details = { priceKobo: price.toString(), buyerName: payload['buyerName'], buyerPhone: payload['buyerPhone'], entryId, applied, surplusKobo: left.toString(), shortfallKobo: shortfall.toString() };
    await moveAccountAssetTx(tx, row.id, { from: ['for_sale'], to: 'sold', event: 'sold', actorId: deciderId, at: this.clock(), location: 'Sold', details });
    await recordAudit(tx, { actorId: deciderId, actorKind: 'person', action: 'asset.sold', subjectType: 'finance_account', subjectId: row.reference, details });
    return { status: 'sold', entryId, surplusKobo: left.toString(), shortfallKobo: shortfall.toString() };
  }

  async pendingApprovals() {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.kind, f.reference AS finance_account_reference, r.payload, r.reason, r.requested_by, r.requested_at
         FROM approval_request r JOIN finance_account f ON f.id = r.finance_account_id
        WHERE r.status = 'pending' ORDER BY r.requested_at`,
    );
    return rows;
  }

  /** Daily job: books interest due and applies credit for every account with a schedule. */
  async runDueDate(asOf: string = this.today()): Promise<{ accounts: number; allocated: bigint }> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM finance_account
        WHERE current_snapshot_id IS NOT NULL
          AND status IN ('active', 'in_arrears', 'repossession_review', 'repossessed')`,
    );
    let allocated = 0n;
    for (const r of rows) allocated += (await this.applyCredit(r.id, `due:${asOf}`, asOf)).allocated;
    return { accounts: rows.length, allocated };
  }

  // ---------------- Borrower statement ----------------

  async statement(financeAccountId: string, asOf: string = this.today()): Promise<Statement> {
    const db = this.pool;
    const fa = (await db.query<AccountRow & {
      arrears_since: string | null;
      review_started_on: string | null;
      cure_deadline: string | null;
      repossessed_on: string | null;
    }>(
      `SELECT id, reference, status, product_code, current_snapshot_id,
              to_char(arrears_since, 'YYYY-MM-DD') AS arrears_since,
              to_char(review_started_on, 'YYYY-MM-DD') AS review_started_on,
              to_char(cure_deadline, 'YYYY-MM-DD') AS cure_deadline,
              to_char(repossessed_on, 'YYYY-MM-DD') AS repossessed_on
         FROM finance_account WHERE id = $1`,
      [financeAccountId],
    )).rows[0];
    if (!fa) throw new LendingError('not_found');

    const snap = fa.current_snapshot_id
      ? (await db.query<{ tier: string; is_placeholder: boolean }>(
          'SELECT tier, is_placeholder FROM term_snapshot WHERE id = $1',
          [fa.current_snapshot_id],
        )).rows[0]
      : undefined;

    const rows = fa.current_snapshot_id
      ? (
          await db.query<{ seq: number; due_date: string; principal_due: string; interest_due: string; paid: string }>(
            `SELECT i.seq, to_char(i.due_date, 'YYYY-MM-DD') AS due_date, i.principal_due::text, i.interest_due::text,
                    coalesce((SELECT sum(amount) FROM allocation a WHERE a.instalment_id = i.id), 0)::text AS paid
               FROM instalment i WHERE i.finance_account_id = $1 AND i.snapshot_id = $2 ORDER BY i.seq`,
            [fa.id, fa.current_snapshot_id],
          )
        ).rows
      : [];

    const schedule = rows.map((r) => {
      const total = BigInt(r.principal_due) + BigInt(r.interest_due);
      const paid = BigInt(r.paid);
      const state =
        paid >= total
          ? ('paid' as const)
          : r.due_date < asOf
            ? ('missed' as const)
            : r.due_date === asOf
              ? ('due' as const)
              : paid > 0n
                ? ('part_paid' as const)
                : ('upcoming' as const);
      return {
        seq: r.seq,
        dueDate: r.due_date,
        principal: kobo(BigInt(r.principal_due)),
        interest: kobo(BigInt(r.interest_due)),
        paid: kobo(paid),
        state,
        owed: total - paid,
      };
    });

    const missed = schedule.filter((s) => s.state === 'missed');
    const oldest = missed[0]?.dueDate ?? null;
    const next = schedule.find((s) => s.owed > 0n && s.dueDate >= asOf);
    const totalPrincipal = schedule.reduce((a, s) => a + s.principal, 0n);
    const principalPaid = (
      await db.query<{ p: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS p FROM allocation WHERE finance_account_id = $1 AND component = 'principal'`,
        [fa.id],
      )
    ).rows[0]!.p;

    const principal = await accountBalance(db, acct.principal(fa.reference));
    const interest = await accountBalance(db, acct.interest(fa.reference));
    const fees = await accountBalance(db, acct.fees(fa.reference));
    const penalty = await accountBalance(db, acct.penalty(fa.reference));

    return {
      reference: fa.reference,
      status: fa.status,
      tier: snap?.tier ?? null,
      isPlaceholderTerms: snap?.is_placeholder ?? false,
      asOf,
      outstanding: {
        principal: kobo(principal),
        interest: kobo(interest),
        fees: kobo(fees),
        penalty: kobo(penalty),
        total: kobo(principal + interest + fees + penalty),
      },
      credit: kobo(await creditOf(db, fa.reference)),
      missed: {
        instalments: missed.length,
        amount: kobo(missed.reduce((a, s) => a + s.owed, 0n)),
        oldestDueDate: oldest,
        daysOverdue: oldest ? daysBetween(oldest, asOf) : 0,
      },
      next: next ? { dueDate: next.dueDate, amount: kobo(next.owed) } : null,
      paidOffPercent: totalPrincipal === 0n ? 0 : Number((BigInt(principalPaid) * 10_000n) / totalPrincipal) / 100,
      schedule: schedule.map(({ owed: _owed, ...s }) => s),
      arrears: await this.arrearsBlock(fa, asOf, missed.length),
    };
  }

  private async arrearsBlock(
    fa: AccountRow & {
      arrears_since: string | null;
      review_started_on: string | null;
      cure_deadline: string | null;
      repossessed_on: string | null;
    },
    asOf: string,
    missedCount: number,
  ): Promise<Statement['arrears']> {
    const inScope = ['in_arrears', 'repossession_review', 'repossessed', 'closed_recovered'].includes(fa.status);
    if (!fa.current_snapshot_id || (!inScope && missedCount === 0)) return null;
    const r = await reactivationAmountOf(this.pool, { ...fa, current_snapshot_id: fa.current_snapshot_id }, asOf);
    const terms = await snapshotTerms(this.pool, fa.current_snapshot_id);
    const reviewStartsOn =
      r.missed.oldestDueDate && !fa.review_started_on
        ? addPeriods(r.missed.oldestDueDate, 'daily', terms.repossessionReviewDaysOverdue)
        : null;
    const va = (
      await this.pool.query<{ account_number: string; bank_name: string }>(
        'SELECT account_number, bank_name FROM virtual_account WHERE finance_account_id = $1',
        [fa.id],
      )
    ).rows[0];
    return {
      reactivationAmount: kobo(r.total),
      penaltyOutstanding: kobo(r.penalty),
      feesOutstanding: kobo(r.fees),
      arrearsSince: fa.arrears_since,
      reviewStartsOn,
      reviewStartedOn: fa.review_started_on,
      cureDeadline: fa.cure_deadline,
      cureDeadlinePassed: fa.cure_deadline !== null && fa.cure_deadline < asOf,
      repossessedOn: fa.repossessed_on,
      steps: reactivationSteps({
        status: fa.status === 'active' && missedCount > 0 ? 'in_arrears' : fa.status,
        reactivationAmount: kobo(r.total),
        cureDeadline: fa.cure_deadline,
        reviewStartsOn,
        repayment: va ? { accountNumber: va.account_number, bankName: va.bank_name } : null,
      }),
    };
  }
}

// ---------------- helpers ----------------

async function inTx<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Row lock on the account: every money-moving operation on one account runs one at a time. */
async function lockAccount(tx: Queryable, id: string): Promise<AccountRow> {
  const { rows } = await tx.query<AccountRow>(
    'SELECT id, reference, status, product_code, current_snapshot_id FROM finance_account WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rows[0]) throw new LendingError('not_found');
  return rows[0];
}

async function snapshotTerms(tx: Queryable, snapshotId: string): Promise<TermSet> {
  const { rows } = await tx.query<{ terms: TermSet }>('SELECT terms FROM term_snapshot WHERE id = $1', [snapshotId]);
  return rows[0]!.terms;
}

/** Credit = suspense balance. Suspense is a liability, so its credit balance is the customer's money. */
async function creditOf(db: Queryable, reference: string): Promise<bigint> {
  return -(await accountBalance(db, acct.suspense(reference)));
}

async function duesOf(tx: Queryable, fa: AccountRow, asOf: string): Promise<Due[]> {
  const dues: Due[] = [];

  const fees = await tx.query<{ id: string; since: string; owed: string }>(
    `SELECT f.id, to_char(f.charged_at, 'YYYY-MM-DD') AS since,
            (f.amount - coalesce((SELECT sum(amount) FROM allocation a WHERE a.fee_charge_id = f.id), 0))::text AS owed
       FROM fee_charge f WHERE f.finance_account_id = $1 AND f.status = 'open'`,
    [fa.id],
  );
  for (const f of fees.rows) {
    const owed = BigInt(f.owed);
    if (owed > 0n) dues.push({ component: 'fee', feeChargeId: f.id, since: f.since, amount: owed });
  }

  const penalty = await accountBalance(tx, acct.penalty(fa.reference));
  if (penalty > 0n) dues.push({ component: 'penalty', amount: penalty });

  const inst = await tx.query<{
    id: string;
    seq: number;
    due_date: string;
    principal_owed: string;
    interest_owed: string;
  }>(
    `SELECT i.id::text, i.seq, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
            (i.principal_due - coalesce((SELECT sum(amount) FROM allocation a
                                          WHERE a.instalment_id = i.id AND a.component = 'principal'), 0))::text AS principal_owed,
            (i.interest_due - coalesce((SELECT sum(amount) FROM allocation a
                                         WHERE a.instalment_id = i.id AND a.component = 'interest'), 0))::text AS interest_owed
       FROM instalment i
      WHERE i.finance_account_id = $1 AND i.snapshot_id = $2 AND i.due_date <= $3
      ORDER BY i.seq`,
    [fa.id, fa.current_snapshot_id, asOf],
  );
  for (const r of inst.rows) {
    const p = BigInt(r.principal_owed);
    const i = BigInt(r.interest_owed);
    if (i > 0n) dues.push({ component: 'interest', instalmentId: r.id, seq: r.seq, dueDate: r.due_date, amount: i });
    if (p > 0n) dues.push({ component: 'principal', instalmentId: r.id, seq: r.seq, dueDate: r.due_date, amount: p });
  }
  return dues;
}
