import type { Messaging } from '@project/adapters';
import { brand, formatNaira, kobo, type Kobo } from '@project/domain';
import { recordAudit, type PoolLike, type Queryable } from '@project/identity';
import { accountBalance, postEntryInTx } from '@project/ledger';
import type { LendingService } from './lending.js';
import { addPeriods, daysBetween, divRoundHalfUp, lagosDate } from './schedule.js';
import type { TermSet } from './terms.js';

export const PENALTY_INCOME = 'fin:income:penalty';
const penaltyReceivable = (ref: string) => `fin:receivable:penalty:${ref}`;
const feesReceivable = (ref: string) => `fin:receivable:fees:${ref}`;

/** Statuses the daily job looks after. */
export const SERVICED = ['active', 'in_arrears', 'repossession_review', 'repossessed'] as const;
/** Statuses that still accrue penalty. */
const ACCRUES_PENALTY = new Set<string>(SERVICED);

export interface MissedInfo {
  readonly instalments: number;
  readonly amount: bigint;
  readonly oldestDueDate: string | null;
  readonly daysOverdue: number;
}

/** Instalments due before `asOf` and not fully paid. */
export async function missedOf(db: Queryable, financeAccountId: string, snapshotId: string, asOf: string): Promise<MissedInfo> {
  const { rows } = await db.query<{ n: number; owed: string; oldest: string | null }>(
    `SELECT count(*)::int AS n, coalesce(sum(owed), 0)::text AS owed, to_char(min(due_date), 'YYYY-MM-DD') AS oldest
       FROM (
         SELECT i.due_date,
                i.principal_due + i.interest_due
                  - coalesce((SELECT sum(amount) FROM allocation a WHERE a.instalment_id = i.id), 0) AS owed
           FROM instalment i
          WHERE i.finance_account_id = $1 AND i.snapshot_id = $2 AND i.due_date < $3
       ) t WHERE owed > 0`,
    [financeAccountId, snapshotId, asOf],
  );
  const r = rows[0]!;
  return {
    instalments: r.n,
    amount: BigInt(r.owed),
    oldestDueDate: r.oldest,
    daysOverdue: r.oldest ? daysBetween(r.oldest, asOf) : 0,
  };
}

/** Overdue principal + interest on instalments whose grace period has ended by `asOf`. */
export async function penaltyBase(
  db: Queryable,
  financeAccountId: string,
  snapshotId: string,
  asOf: string,
  graceDays: number,
): Promise<bigint> {
  const cutoff = addPeriods(asOf, 'daily', -graceDays); // due before this date → past grace
  const { rows } = await db.query<{ owed: string }>(
    `SELECT coalesce(sum(owed), 0)::text AS owed FROM (
       SELECT i.principal_due + i.interest_due
                - coalesce((SELECT sum(amount) FROM allocation a WHERE a.instalment_id = i.id), 0) AS owed
         FROM instalment i
        WHERE i.finance_account_id = $1 AND i.snapshot_id = $2 AND i.due_date < $3
     ) t WHERE owed > 0`,
    [financeAccountId, snapshotId, cutoff],
  );
  return BigInt(rows[0]!.owed);
}

/** What a borrower must pay to bring the account back: missed instalments + penalty + fees (incl. recovery costs). */
export async function reactivationAmountOf(
  db: Queryable,
  fa: { id: string; reference: string; current_snapshot_id: string },
  asOf: string,
): Promise<{ missed: MissedInfo; penalty: bigint; fees: bigint; total: bigint }> {
  const missed = await missedOf(db, fa.id, fa.current_snapshot_id, asOf);
  const penalty = await accountBalance(db, penaltyReceivable(fa.reference));
  const fees = await accountBalance(db, feesReceivable(fa.reference));
  return { missed, penalty, fees, total: missed.amount + penalty + fees };
}

export interface ArrearsStep {
  readonly code: 'pay_missed' | 'pay_to_reactivate' | 'automatic_return' | 'manager_release' | 'contact_support';
  readonly text: string;
}

/** Plain instructions shown to the borrower: what to do, how much, by when. */
export function reactivationSteps(input: {
  status: string;
  reactivationAmount: Kobo;
  cureDeadline: string | null;
  reviewStartsOn: string | null;
  repayment: { accountNumber: string; bankName: string } | null;
}): ArrearsStep[] {
  const pay = (amount: Kobo) =>
    input.repayment
      ? `Pay ${formatNaira(amount)} to ${input.repayment.bankName} account ${input.repayment.accountNumber}`
      : `Pay ${formatNaira(amount)} to your repayment account`;
  switch (input.status) {
    case 'in_arrears':
      return [
        {
          code: 'pay_missed',
          text: `${pay(input.reactivationAmount)}${input.reviewStartsOn ? ` before ${input.reviewStartsOn}` : ''} to clear your missed payments and stop penalty interest.`,
        },
      ];
    case 'repossession_review':
      return [
        {
          code: 'pay_to_reactivate',
          text: `${pay(input.reactivationAmount)}${input.cureDeadline ? ` by ${input.cureDeadline}` : ''}.`,
        },
        { code: 'automatic_return', text: 'When the full amount arrives, your account returns to active automatically.' },
      ];
    case 'repossessed':
      return [
        {
          code: 'pay_to_reactivate',
          text: `${pay(input.reactivationAmount)}${input.cureDeadline ? ` by ${input.cureDeadline}` : ''}.`,
        },
        { code: 'manager_release', text: 'After payment, a manager confirms release and arranges the handover back to you.' },
        { code: 'contact_support', text: `Questions: call ${brand.supportPhone}.` },
      ];
    case 'closed_recovered':
      return [{ code: 'contact_support', text: `This account is closed. Call ${brand.supportPhone} to discuss it.` }];
    default:
      return [];
  }
}

interface AccountForJob {
  id: string;
  reference: string;
  person_id: string;
  status: string;
  current_snapshot_id: string;
  review_started_on: string | null;
}

export class ArrearsService {
  constructor(
    private readonly pool: PoolLike,
    private readonly lending: LendingService,
    private readonly messaging: Messaging,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Daily job. Processes every date from the day after the last completed run up to `asOf`,
   * strictly in order, so a missed day is never skipped. Each date is safe to re-run.
   */
  async runDaily(asOf: string = lagosDate(this.clock()), maxCatchUpDays = 60) {
    const client = await this.pool.connect();
    try {
      // One runner at a time across all API instances.
      const lock = await client.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('job:daily-arrears')) AS ok`);
      if (!lock.rows[0]!.ok) return { skipped: 'another run is in progress' as const, dates: [] as string[] };
      try {
        const last = await client.query<{ d: string | null }>(
          `SELECT to_char(max(run_date), 'YYYY-MM-DD') AS d FROM job_run WHERE job = 'daily-arrears' AND completed_at IS NOT NULL`,
        );
        const from = last.rows[0]!.d ? addPeriods(last.rows[0]!.d, 'daily', 1) : asOf;
        if (from > asOf) return { skipped: 'already up to date' as const, dates: [] as string[] };
        const gap = daysBetween(from, asOf) + 1;
        if (gap > maxCatchUpDays) {
          throw new Error(`Daily job is ${gap} days behind (from ${from}); run catch-up in batches with an explicit maxCatchUpDays`);
        }
        const dates: string[] = [];
        for (let d = from; d <= asOf; d = addPeriods(d, 'daily', 1)) {
          await client.query(
            `INSERT INTO job_run (job, run_date) VALUES ('daily-arrears', $1)
             ON CONFLICT (job, run_date) DO UPDATE SET started_at = now()`,
            [d],
          );
          const accounts = await this.processDate(d);
          await client.query(
            `UPDATE job_run SET completed_at = now(), accounts = $2 WHERE job = 'daily-arrears' AND run_date = $1`,
            [d, accounts],
          );
          dates.push(d);
        }
        return { skipped: null, dates };
      } finally {
        await client.query(`SELECT pg_advisory_unlock(hashtext('job:daily-arrears'))`);
      }
    } finally {
      client.release();
    }
  }

  async processDate(asOf: string): Promise<number> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM finance_account WHERE current_snapshot_id IS NOT NULL AND status = ANY($1) ORDER BY reference`,
      [SERVICED],
    );
    for (const r of rows) await this.processAccount(r.id, asOf);
    return rows.length;
  }

  /** One account, one date: apply credit, accrue penalty, move status, notify. Idempotent per date. */
  async processAccount(financeAccountId: string, asOf: string): Promise<{ status: string }> {
    await this.lending.applyCredit(financeAccountId, `due:${asOf}`, asOf);

    const notices: { personId: string; faId: string; template: string; vars: Record<string, string>; key: string }[] = [];
    const status = await inTx(this.pool, async (tx) => {
      const { rows } = await tx.query<AccountForJob>(
        `SELECT id, reference, person_id, status, current_snapshot_id,
                to_char(review_started_on, 'YYYY-MM-DD') AS review_started_on
           FROM finance_account WHERE id = $1 FOR UPDATE`,
        [financeAccountId],
      );
      const fa = rows[0]!;
      if (!SERVICED.includes(fa.status as (typeof SERVICED)[number])) return fa.status;
      const terms = (await tx.query<{ terms: TermSet }>('SELECT terms FROM term_snapshot WHERE id = $1', [fa.current_snapshot_id]))
        .rows[0]!.terms;

      // 1. Penalty interest for this date.
      if (ACCRUES_PENALTY.has(fa.status) && terms.penaltyBpsPerDay > 0) {
        const done = await tx.query('SELECT 1 FROM penalty_accrual WHERE finance_account_id = $1 AND accrual_date = $2', [
          fa.id,
          asOf,
        ]);
        if (done.rows.length === 0) {
          const base = await penaltyBase(tx, fa.id, fa.current_snapshot_id, asOf, terms.graceDays);
          const amount = divRoundHalfUp(base * BigInt(terms.penaltyBpsPerDay), 10_000n);
          if (amount > 0n) {
            const { entryId } = await postEntryInTx(tx, {
              idempotencyKey: `penalty:${fa.reference}:${asOf}`,
              source: 'scheduler',
              actorId: 'daily-arrears',
              occurredAt: new Date(`${asOf}T23:59:59+01:00`),
              description: `Penalty interest ${terms.penaltyBpsPerDay}bp/day on ${base} kobo overdue, ${fa.reference}, ${asOf}`,
              lines: [
                { account: penaltyReceivable(fa.reference), side: 'debit', amount: kobo(amount) },
                { account: PENALTY_INCOME, side: 'credit', amount: kobo(amount) },
              ],
            });
            await tx.query(
              `INSERT INTO penalty_accrual (finance_account_id, accrual_date, base_amount, rate_bps_per_day, amount, ledger_entry_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [fa.id, asOf, base.toString(), terms.penaltyBpsPerDay, amount.toString(), entryId],
            );
          }
        }
      }

      // 2. Status.
      const r = await reactivationAmountOf(tx, fa, asOf);
      const missed = r.missed;
      let next = fa.status;
      const reviewThreshold = terms.repossessionReviewDaysOverdue;

      if ((fa.status === 'active' || fa.status === 'in_arrears') && missed.daysOverdue >= reviewThreshold) {
        next = 'repossession_review';
        const deadline = addPeriods(asOf, 'daily', terms.reactivationWindowDays);
        await tx.query(
          `UPDATE finance_account SET status = 'repossession_review', review_started_on = $2, cure_deadline = $3,
                  arrears_since = coalesce(arrears_since, $2) WHERE id = $1`,
          [fa.id, asOf, deadline],
        );
        notices.push({
          personId: fa.person_id,
          faId: fa.id,
          template: 'arrears_repossession_review',
          vars: {
            reference: fa.reference,
            missed: String(missed.instalments),
            amount: formatNaira(kobo(r.total)),
            deadline,
          },
          key: `review:${fa.reference}:${asOf}`,
        });
      } else if (fa.status === 'active' && missed.instalments > 0) {
        next = 'in_arrears';
        await tx.query(`UPDATE finance_account SET status = 'in_arrears', arrears_since = $2 WHERE id = $1`, [fa.id, asOf]);
        notices.push({
          personId: fa.person_id,
          faId: fa.id,
          template: 'arrears_notice',
          vars: { reference: fa.reference, amount: formatNaira(kobo(r.total)), since: missed.oldestDueDate ?? asOf },
          key: `arrears:${fa.reference}:${missed.oldestDueDate}`,
        });
      } else if (fa.status === 'in_arrears' && missed.instalments === 0) {
        next = 'active';
        await tx.query(`UPDATE finance_account SET status = 'active', arrears_since = NULL WHERE id = $1`, [fa.id]);
      } else if (fa.status === 'repossession_review' && r.total === 0n) {
        // Cured before any repossession: back to active, no staff action needed.
        next = 'active';
        await tx.query(
          `UPDATE finance_account SET status = 'active', arrears_since = NULL, review_started_on = NULL, cure_deadline = NULL
            WHERE id = $1`,
          [fa.id],
        );
        notices.push({
          personId: fa.person_id,
          faId: fa.id,
          template: 'arrears_cured',
          vars: { reference: fa.reference },
          key: `cured:${fa.reference}:${fa.review_started_on}`,
        });
      }
      // 'repossessed' never changes automatically: release needs a manager (see approvals).

      if (next !== fa.status) {
        await recordAudit(tx, {
          actorKind: 'system',
          action: `arrears.status.${fa.status}_to_${next}`,
          subjectType: 'finance_account',
          subjectId: fa.reference,
          details: { asOf, daysOverdue: missed.daysOverdue, missed: missed.instalments, amount: r.total.toString() },
        });
      }
      return next;
    });

    for (const n of notices) await this.notify(n.personId, n.faId, n.template, n.vars, n.key);
    return { status };
  }

  /** Sends one SMS per dedupe key, ever. A failed send is removed so the next run retries it. */
  private async notify(personId: string, faId: string, template: string, vars: Record<string, string>, key: string) {
    const ins = await this.pool.query<{ id: string }>(
      `INSERT INTO notification_log (finance_account_id, person_id, template, dedupe_key, channel)
       VALUES ($1, $2, $3, $4, 'sms') ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
      [faId, personId, template, key],
    );
    if (!ins.rows[0]) return;
    const phone = (await this.pool.query<{ phone: string | null }>('SELECT phone FROM person WHERE id = $1', [personId])).rows[0]
      ?.phone;
    if (!phone) return;
    try {
      const { id } = await this.messaging.send('sms', phone, template, vars);
      await this.pool.query('UPDATE notification_log SET provider_message_id = $2 WHERE id = $1', [ins.rows[0].id, id]);
    } catch (err) {
      await this.pool.query('DELETE FROM notification_log WHERE id = $1', [ins.rows[0].id]);
      throw err;
    }
  }

  /** Ageing buckets and portfolio at risk, by outstanding principal. */
  async portfolio(asOf: string = lagosDate(this.clock())) {
    const { rows } = await this.pool.query<{ id: string; reference: string; current_snapshot_id: string; status: string }>(
      `SELECT id, reference, current_snapshot_id, status FROM finance_account
        WHERE current_snapshot_id IS NOT NULL AND status = ANY($1)`,
      [SERVICED],
    );
    const buckets = ['current', '1-7', '8-30', '31-60', '61-90', '90+'] as const;
    const totals = Object.fromEntries(buckets.map((b) => [b, { accounts: 0, principal: 0n }])) as Record<
      (typeof buckets)[number],
      { accounts: number; principal: bigint }
    >;
    let all = 0n;
    let par30 = 0n;
    for (const r of rows) {
      const m = await missedOf(this.pool, r.id, r.current_snapshot_id, asOf);
      const principal = await accountBalance(this.pool, `fin:receivable:principal:${r.reference}`);
      const d = m.daysOverdue;
      const b = d === 0 ? 'current' : d <= 7 ? '1-7' : d <= 30 ? '8-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+';
      totals[b].accounts += 1;
      totals[b].principal += principal;
      all += principal;
      if (d > 30) par30 += principal;
    }
    return {
      asOf,
      buckets: totals,
      principalOutstanding: all,
      par30Percent: all === 0n ? 0 : Number((par30 * 10_000n) / all) / 100,
    };
  }
}

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
