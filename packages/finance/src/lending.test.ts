import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxCollections } from '@project/adapters';
import { kobo } from '@project/domain';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { bookNet } from '@project/ledger';
import { CollectionsService } from './collections.js';
import { LendingError, LendingService } from './lending.js';
import { MOTORCYCLE_PLACEHOLDER_TIERS } from './terms.js';

let db: TestDatabase;
let collections: CollectionsService;
let now = new Date('2026-12-01T09:00:00Z');
const lending = () => new LendingService(db.pool, () => now, { requireSignedContract: false });
const provider = new SandboxCollections('lending-test-secret-1');
let underwriter: string;
let manager: string;
let seq = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  collections = new CollectionsService(db.pool, provider);
  const people = await db.pool.query(
    `INSERT INTO person (email) VALUES ('uw@x.com'), ('mgr@x.com') RETURNING id`,
  );
  underwriter = people.rows[0].id;
  manager = people.rows[1].id;
  for (const [tier, config] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
    await lending().publishTier('motorcycle_ride_to_own', tier, config, { actorId: null, isPlaceholder: true });
  }
});
afterAll(async () => db?.drop());

async function application() {
  const { rows } = await db.pool.query(
    `INSERT INTO person (phone) VALUES ('+234803' || lpad($1::text, 7, '0')) RETURNING id`,
    [++seq],
  );
  const fa = await collections.openAccount(rows[0].id, 'motorcycle_ride_to_own');
  const va = await collections.provisionVirtualAccount(fa.id, 'Rider');
  return { ...fa, accountNumber: va.accountNumber };
}

async function pay(accountNumber: string, amount: bigint) {
  const { body, headers } = provider.buildWebhook({
    reference: `P-${++seq}`,
    accountNumber,
    amountKobo: amount.toString(),
    paidAt: now.toISOString(),
  });
  return collections.ingestWebhook(body, headers);
}

/** Tier B defaults: ₦1.5m, 20% deposit (₦300k), 52 weekly, 36% flat → instalment ₦23,076.92 + ₦8,307.69. */
async function activeLoan() {
  const fa = await application();
  await lending().approve({ financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: underwriter });
  await pay(fa.accountNumber, 30_000_000n);
  await lending().activate(fa.id, manager, '2026-12-01');
  return fa;
}

describe('tiers', () => {
  it('lists current placeholder tiers', async () => {
    const tiers = await lending().currentTiers('motorcycle_ride_to_own');
    expect(tiers.map((t) => t.tier)).toEqual(['A', 'B', 'C']);
    expect(tiers.every((t) => t.is_placeholder)).toBe(true);
  });

  it('a new version never changes snapshots already taken', async () => {
    const fa = await application();
    const { snapshotId, terms } = await lending().approve({
      financeAccountId: fa.id,
      tier: 'A',
      assetPriceKobo: '150000000',
      underwriterId: underwriter,
    });
    const changed = {
      ...MOTORCYCLE_PLACEHOLDER_TIERS.A,
      bounds: { ...MOTORCYCLE_PLACEHOLDER_TIERS.A.bounds, annualInterestBps: { default: 3_300, min: 2_500, max: 3_500 } },
    };
    const v2 = await lending().publishTier('motorcycle_ride_to_own', 'A', changed, { actorId: manager, isPlaceholder: true });
    expect(v2.version).toBe(2);
    const { rows } = await db.pool.query('SELECT terms FROM term_snapshot WHERE id = $1', [snapshotId]);
    expect(rows[0].terms.annualInterestBps).toBe(terms.annualInterestBps);
    await expect(db.pool.query(`UPDATE term_snapshot SET tier = 'C'`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE product_tier SET is_placeholder = false`)).rejects.toThrow(/immutable/);
  });

  it('rejects an invalid tier config', async () => {
    const bad = { ...MOTORCYCLE_PLACEHOLDER_TIERS.B, frequency: 'hourly' as never };
    await expect(
      lending().publishTier('motorcycle_ride_to_own', 'D', bad, { actorId: manager, isPlaceholder: true }),
    ).rejects.toBeInstanceOf(LendingError);
  });
});

describe('approval', () => {
  it('requires a second, different approver for terms outside the tier bounds', async () => {
    const fa = await application();
    const base = { financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: underwriter };
    await expect(lending().approve({ ...base, adjustments: { tenorPeriods: 100 } })).rejects.toMatchObject({
      code: 'needs_second_approver',
    });
    await expect(
      lending().approve({ ...base, adjustments: { tenorPeriods: 100 }, secondApprover: { personId: underwriter, reason: 'x' } }),
    ).rejects.toMatchObject({ code: 'same_person' });
    const ok = await lending().approve({
      ...base,
      adjustments: { tenorPeriods: 100 },
      secondApprover: { personId: manager, reason: 'Long-standing rider, verified income' },
    });
    expect(ok.outOfBounds).toEqual(['tenorPeriods']);
  });

  it('only approves applications once', async () => {
    const fa = await application();
    const input = { financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: underwriter };
    await lending().approve(input);
    await expect(lending().approve(input)).rejects.toMatchObject({ code: 'invalid_status' });
  });
});

describe('activation', () => {
  it('refuses to hand over the asset before the deposit is in credit', async () => {
    const fa = await application();
    await lending().approve({ financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: underwriter });
    await pay(fa.accountNumber, 29_999_999n);
    await expect(lending().activate(fa.id, manager, '2026-12-01')).rejects.toMatchObject({ code: 'deposit_not_paid' });
  });

  it('books principal, uses the deposit and generates 52 instalments', async () => {
    const fa = await activeLoan();
    const s = await lending().statement(fa.id, '2026-12-01');
    expect(s.status).toBe('active');
    expect(s.isPlaceholderTerms).toBe(true);
    expect(s.outstanding.principal).toBe(120_000_000n);
    expect(s.credit).toBe(0n);
    expect(s.schedule).toHaveLength(52);
    expect(s.next).toEqual({ dueDate: '2026-12-08', amount: 2_307_692n + 830_769n });
  });
});

describe('payments through the waterfall', () => {
  it('early payment waits as credit, then pays the instalment on its due date', async () => {
    const fa = await activeLoan();
    await pay(fa.accountNumber, 3_138_461n);
    expect((await lending().applyCredit(fa.id, 'early', '2026-12-05')).allocated).toBe(0n);
    const r = await lending().applyCredit(fa.id, 'due:2026-12-08', '2026-12-08');
    expect(r.allocated).toBe(3_138_461n);
    const s = await lending().statement(fa.id, '2026-12-08');
    expect(s.schedule[0]!.state).toBe('paid');
    expect(s.outstanding.interest).toBe(0n);
    expect(s.missed.instalments).toBe(0);
  });

  it('shows the borrower exactly what they have missed and for how long', async () => {
    const fa = await activeLoan();
    await pay(fa.accountNumber, 1_000_000n);
    await lending().applyCredit(fa.id, 'due:2026-12-08', '2026-12-08');
    await lending().applyCredit(fa.id, 'due:2026-12-15', '2026-12-15');
    const s = await lending().statement(fa.id, '2026-12-20');
    expect(s.missed.instalments).toBe(2);
    expect(s.missed.oldestDueDate).toBe('2026-12-08');
    expect(s.missed.daysOverdue).toBe(12);
    expect(s.missed.amount).toBe(2n * 3_138_461n - 1_000_000n);
    // interest first within the oldest instalment, per the waterfall
    expect(s.schedule[0]!.paid).toBe(1_000_000n);
  });

  it('pays fees before instalments, and a waiver needs two different people', async () => {
    const fa = await activeLoan();
    const feeId = await lending().chargeFee(fa.id, 'late_handling', kobo(50_000n), manager);
    await pay(fa.accountNumber, 30_000n);
    await lending().applyCredit(fa.id, 'due:2026-12-08', '2026-12-08');
    const s = await lending().statement(fa.id, '2026-12-08');
    expect(s.outstanding.fees).toBe(20_000n);
    expect(s.schedule[0]!.paid).toBe(0n);

    await expect(lending().waiveFee(feeId, manager, manager, 'goodwill')).rejects.toMatchObject({ code: 'same_person' });
    expect(await lending().waiveFee(feeId, underwriter, manager, 'goodwill: first late payment')).toBe(20_000n);
    expect((await lending().statement(fa.id, '2026-12-08')).outstanding.fees).toBe(0n);
    await expect(lending().waiveFee(feeId, underwriter, manager, 'again')).rejects.toMatchObject({ code: 'fee_not_open' });
  });

  it('settles the account when everything is paid, and the book still nets to zero', async () => {
    const fa = await activeLoan();
    const s0 = await lending().statement(fa.id, '2026-12-01');
    const totalDue = s0.schedule.reduce((a, i) => a + i.principal + i.interest, 0n);
    await pay(fa.accountNumber, totalDue);
    await lending().applyCredit(fa.id, 'final', s0.schedule.at(-1)!.dueDate);
    const s = await lending().statement(fa.id, s0.schedule.at(-1)!.dueDate);
    expect(s.status).toBe('settled');
    expect(s.outstanding.total).toBe(0n);
    expect(s.paidOffPercent).toBe(100);
    expect(await bookNet(db.pool, 'financing')).toBe(0n);
  });

  it('concurrent runs never allocate the same credit twice', async () => {
    const fa = await activeLoan();
    await pay(fa.accountNumber, 4_000_000n);
    const runs = await Promise.all(
      Array.from({ length: 8 }, (_, i) => lending().applyCredit(fa.id, `race-${i}`, '2026-12-15')),
    );
    const total = runs.reduce((a, r) => a + r.allocated, 0n);
    expect(total).toBe(4_000_000n);
    const s = await lending().statement(fa.id, '2026-12-15');
    expect(s.credit).toBe(0n);
  });

  it('re-running a trigger is a no-op', async () => {
    const fa = await activeLoan();
    await pay(fa.accountNumber, 500_000n);
    await lending().applyCredit(fa.id, 'due:2026-12-08', '2026-12-08');
    await pay(fa.accountNumber, 500_000n);
    expect((await lending().applyCredit(fa.id, 'due:2026-12-08', '2026-12-08')).allocated).toBe(0n);
  });

  it('schedule rows cannot be edited', async () => {
    await expect(db.pool.query('UPDATE instalment SET principal_due = 1')).rejects.toThrow(/immutable/);
    await expect(db.pool.query('DELETE FROM allocation')).rejects.toThrow(/immutable/);
  });
});

describe('two-person approval requests', () => {
  it('out-of-bounds terms: proposer cannot confirm their own request; a manager can', async () => {
    const fa = await application();
    const id = await lending().requestApproval({
      kind: 'terms_out_of_bounds',
      financeAccountId: fa.id,
      payload: { tier: 'B', assetPriceKobo: '150000000', adjustments: { tenorPeriods: 90 } },
      reason: 'Verified rider income supports a longer tenor',
      requestedBy: underwriter,
    });
    await expect(lending().decideApproval(id, underwriter, 'approved', 'self')).rejects.toMatchObject({ code: 'same_person' });
    const r = await lending().decideApproval(id, manager, 'approved', 'ok');
    expect((r.result as { outOfBounds: string[] }).outOfBounds).toEqual(['tenorPeriods']);
    const { rows } = await db.pool.query('SELECT created_by, approved_by FROM term_snapshot WHERE finance_account_id = $1', [fa.id]);
    expect(rows[0]).toEqual({ created_by: underwriter, approved_by: manager });
    await expect(lending().decideApproval(id, manager, 'approved', 'again')).rejects.toMatchObject({ code: 'invalid_status' });
  });

  it('only one pending request of a kind per account', async () => {
    const fa = await application();
    const req = {
      kind: 'terms_out_of_bounds' as const,
      financeAccountId: fa.id,
      payload: { tier: 'B', assetPriceKobo: '150000000', adjustments: { tenorPeriods: 90 } },
      reason: 'Longer tenor requested',
      requestedBy: underwriter,
    };
    await lending().requestApproval(req);
    await expect(lending().requestApproval(req)).rejects.toThrow(/approval_request_one_pending/);
  });

  it('fee waiver via request; rejection changes nothing', async () => {
    const fa = await activeLoan();
    const feeId = await lending().chargeFee(fa.id, 'admin_fee', kobo(10_000n), manager);
    const r1 = await lending().requestApproval({
      kind: 'fee_waiver', financeAccountId: fa.id, payload: { feeChargeId: feeId }, reason: 'Customer complaint upheld', requestedBy: underwriter,
    });
    await lending().decideApproval(r1, manager, 'rejected', 'not justified');
    expect((await lending().statement(fa.id, '2026-12-01')).outstanding.fees).toBe(10_000n);
    const r2 = await lending().requestApproval({
      kind: 'fee_waiver', financeAccountId: fa.id, payload: { feeChargeId: feeId }, reason: 'Customer complaint upheld on review', requestedBy: underwriter,
    });
    await lending().decideApproval(r2, manager, 'approved', 'ok');
    expect((await lending().statement(fa.id, '2026-12-01')).outstanding.fees).toBe(0n);
  });

  it('daily run allocates credit across accounts and is safe to repeat', async () => {
    const fa = await activeLoan();
    await pay(fa.accountNumber, 3_138_461n);
    const first = await lending().runDueDate('2026-12-08');
    expect(first.allocated >= 3_138_461n).toBe(true);
    const again = await lending().runDueDate('2026-12-08');
    expect(again.allocated).toBe(0n);
    expect((await lending().statement(fa.id, '2026-12-08')).schedule[0]!.state).toBe('paid');
  });
});
