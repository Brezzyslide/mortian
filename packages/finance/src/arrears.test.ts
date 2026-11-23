import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { bookNet } from '@project/ledger';
import { ArrearsService } from './arrears.js';
import { CollectionsService } from './collections.js';
import { LendingService } from './lending.js';
import { addPeriods } from './schedule.js';
import { MOTORCYCLE_PLACEHOLDER_TIERS } from './terms.js';

/**
 * Tier B placeholder: weekly, ₦31,384.61 per instalment (3,138,461 kobo), penalty 10 bp/day after
 * 1 grace day, repossession review at 14 days overdue, 10-day reactivation window.
 */
const INSTALMENT = 3_138_461n;

let db: TestDatabase;
let today = '2026-12-01';
const clock = () => new Date(`${today}T10:00:00+01:00`);
let messaging: SandboxMessaging;
let lending: LendingService;
let arrears: ArrearsService;
let collections: CollectionsService;
const provider = new SandboxCollections('arrears-test-secret');
let staffA: string;
let staffB: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const p = await db.pool.query(`INSERT INTO person (email) VALUES ('a@x.com'), ('b@x.com') RETURNING id`);
  staffA = p.rows[0].id;
  staffB = p.rows[1].id;
  const l = new LendingService(db.pool, clock);
  for (const [tier, config] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
    await l.publishTier('motorcycle_ride_to_own', tier, config, { actorId: null, isPlaceholder: true });
  }
});
afterAll(async () => db?.drop());
beforeEach(() => {
  today = '2026-12-01';
  messaging = new SandboxMessaging();
  lending = new LendingService(db.pool, clock);
  arrears = new ArrearsService(db.pool, lending, messaging, clock);
  collections = new CollectionsService(db.pool, provider);
});

async function loan() {
  const phone = `+234805${String(++n).padStart(7, '0')}`;
  const person = await db.pool.query(`INSERT INTO person (phone) VALUES ($1) RETURNING id`, [phone]);
  const fa = await collections.openAccount(person.rows[0].id, 'motorcycle_ride_to_own');
  const va = await collections.provisionVirtualAccount(fa.id, 'Rider');
  await lending.approve({ financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: staffA });
  await pay(va.accountNumber, 30_000_000n);
  await lending.activate(fa.id, staffB, '2026-12-01');
  return { ...fa, accountNumber: va.accountNumber, phone };
}

async function pay(accountNumber: string, amount: bigint) {
  const { body, headers } = provider.buildWebhook({
    reference: `AR-${++n}`,
    accountNumber,
    amountKobo: amount.toString(),
    paidAt: clock().toISOString(),
  });
  await collections.ingestWebhook(body, headers);
}

async function day(d: string, faId: string) {
  today = d;
  return arrears.processAccount(faId, d);
}

const status = async (id: string) =>
  (await db.pool.query('SELECT status FROM finance_account WHERE id = $1', [id])).rows[0].status as string;

describe('penalty interest', () => {
  it('starts after the grace day, on overdue principal + interest only, once per day', async () => {
    const fa = await loan();
    await day('2026-12-08', fa.id); // due today
    await day('2026-12-09', fa.id); // 1 day overdue: inside grace
    let p = await db.pool.query('SELECT accrual_date, base_amount, amount FROM penalty_accrual WHERE finance_account_id = $1', [fa.id]);
    expect(p.rows).toHaveLength(0);

    await day('2026-12-10', fa.id); // past grace
    await day('2026-12-10', fa.id); // re-run: no second accrual
    p = await db.pool.query(
      `SELECT to_char(accrual_date,'YYYY-MM-DD') d, base_amount::text b, amount::text a FROM penalty_accrual WHERE finance_account_id = $1`,
      [fa.id],
    );
    expect(p.rows).toEqual([{ d: '2026-12-10', b: INSTALMENT.toString(), a: '3138' }]);

    await day('2026-12-11', fa.id);
    const base11 = await db.pool.query(
      `SELECT base_amount::text b FROM penalty_accrual WHERE finance_account_id = $1 AND accrual_date = '2026-12-11'`,
      [fa.id],
    );
    // base does not include yesterday's penalty: no compounding
    expect(base11.rows[0].b).toBe(INSTALMENT.toString());
  });
});

describe('status and notices', () => {
  it('goes in_arrears on the first missed day, notifies once, and returns to active when paid', async () => {
    const fa = await loan();
    await day('2026-12-09', fa.id);
    expect(await status(fa.id)).toBe('in_arrears');
    await day('2026-12-09', fa.id);
    const sent = messaging.sent.filter((m) => m.to === fa.phone && m.templateId === 'arrears_notice');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.vars['amount']).toBe('₦31,384.61');

    const s = await lending.statement(fa.id, '2026-12-09');
    expect(s.arrears).toMatchObject({ reviewStartsOn: '2026-12-22', reactivationAmount: INSTALMENT });
    expect(s.arrears!.steps[0]!.text).toContain('₦31,384.61');
    expect(s.arrears!.steps[0]!.text).toContain(fa.accountNumber);

    today = '2026-12-11';
    await pay(fa.accountNumber, INSTALMENT + 10_000n);
    await day('2026-12-11', fa.id);
    expect(await status(fa.id)).toBe('active');
  });

  it('moves to repossession review at 14 days overdue with a cure deadline, and tells the borrower', async () => {
    const fa = await loan();
    for (let d = '2026-12-09'; d <= '2026-12-22'; d = addPeriods(d, 'daily', 1)) await day(d, fa.id);
    expect(await status(fa.id)).toBe('repossession_review');
    const s = await lending.statement(fa.id, '2026-12-22');
    expect(s.arrears).toMatchObject({ reviewStartedOn: '2026-12-22', cureDeadline: '2027-01-01', cureDeadlinePassed: false });
    expect(s.missed.instalments).toBe(2);
    expect(s.arrears!.reactivationAmount).toBe(s.missed.amount + s.arrears!.penaltyOutstanding);
    const notice = messaging.sent.find((m) => m.to === fa.phone && m.templateId === 'arrears_repossession_review')!;
    expect(notice.vars).toMatchObject({ deadline: '2027-01-01', missed: '2' });
  });

  it('a borrower who pays the full reactivation amount during review returns to active without staff action', async () => {
    const fa = await loan();
    for (let d = '2026-12-09'; d <= '2026-12-22'; d = addPeriods(d, 'daily', 1)) await day(d, fa.id);
    const owed = (await lending.statement(fa.id, '2026-12-23')).arrears!.reactivationAmount;
    today = '2026-12-23';
    await pay(fa.accountNumber, owed + 50_000n); // covers tonight's penalty too
    await day('2026-12-23', fa.id);
    await day('2026-12-24', fa.id);
    expect(await status(fa.id)).toBe('active');
    expect(messaging.sent.some((m) => m.to === fa.phone && m.templateId === 'arrears_cured')).toBe(true);
  });
});

describe('repossession, release and closure (two people)', () => {
  async function inReview() {
    const fa = await loan();
    for (let d = '2026-12-09'; d <= '2026-12-22'; d = addPeriods(d, 'daily', 1)) await day(d, fa.id);
    return fa;
  }

  it('repossession is refused before review and needs a second person', async () => {
    const early = await loan();
    await expect(lending.assertRecoveryAllowed('repossession', early.id)).rejects.toMatchObject({ code: 'invalid_status' });

    const fa = await inReview();
    await lending.assertRecoveryAllowed('repossession', fa.id);
    const req = await lending.requestApproval({
      kind: 'repossession',
      financeAccountId: fa.id,
      payload: { location: 'Mararaba park', condition: 'good', photoRefs: ['s3://x/1.jpg'] },
      reason: '14 days overdue, borrower unreachable',
      requestedBy: staffA,
    });
    await expect(lending.decideApproval(req, staffA, 'approved', 'self')).rejects.toMatchObject({ code: 'same_person' });
    await lending.decideApproval(req, staffB, 'approved', 'confirmed');
    expect(await status(fa.id)).toBe('repossessed');

    // Paying does not release automatically.
    today = '2026-12-23';
    const owed = (await lending.statement(fa.id, '2026-12-23')).arrears!;
    expect(owed.steps.map((x) => x.code)).toEqual(['pay_to_reactivate', 'manager_release', 'contact_support']);
    await expect(lending.assertRecoveryAllowed('release', fa.id)).rejects.toMatchObject({ code: 'invalid_status' });
    await pay(fa.accountNumber, owed.reactivationAmount + 50_000n);
    await day('2026-12-23', fa.id);
    expect(await status(fa.id)).toBe('repossessed');

    await lending.assertRecoveryAllowed('release', fa.id);
    const rel = await lending.requestApproval({
      kind: 'release',
      financeAccountId: fa.id,
      payload: { handoverNote: 'Bike returned in same condition' },
      reason: 'Reactivation amount paid in full',
      requestedBy: staffA,
    });
    await lending.decideApproval(rel, staffB, 'approved', 'released');
    expect(await status(fa.id)).toBe('active');
  });

  it('closing as recovered is only possible after the cure deadline', async () => {
    const fa = await inReview();
    today = '2026-12-30';
    await expect(lending.assertRecoveryAllowed('close_recovered', fa.id)).rejects.toMatchObject({ code: 'invalid_status' });
    today = '2027-01-02';
    await lending.assertRecoveryAllowed('close_recovered', fa.id);
    const req = await lending.requestApproval({
      kind: 'close_recovered',
      financeAccountId: fa.id,
      payload: {},
      reason: 'Not cured by deadline',
      requestedBy: staffA,
    });
    await lending.decideApproval(req, staffB, 'approved', 'close');
    expect(await status(fa.id)).toBe('closed_recovered');
    const s = await lending.statement(fa.id, '2027-01-02');
    expect(s.arrears!.steps[0]!.code).toBe('contact_support');
  });
});

describe('daily job', () => {
  it('processes missed days in order, once each, and refuses a huge gap', async () => {
    await loan();
    const r1 = await arrears.runDaily('2026-12-08');
    expect(r1.dates).toEqual(['2026-12-08']);
    const r2 = await arrears.runDaily('2026-12-11');
    expect(r2.dates).toEqual(['2026-12-09', '2026-12-10', '2026-12-11']);
    expect((await arrears.runDaily('2026-12-11')).skipped).toBe('already up to date');
    await expect(arrears.runDaily('2027-06-01')).rejects.toThrow(/behind/);
  });

  it('reports ageing buckets and PAR30, and the book still nets to zero', async () => {
    const p = await arrears.portfolio('2026-12-30');
    const total = Object.values(p.buckets).reduce((a, b) => a + b.principal, 0n);
    expect(total).toBe(p.principalOutstanding);
    expect(p.par30Percent).toBeGreaterThanOrEqual(0);
    expect(await bookNet(db.pool, 'financing')).toBe(0n);
  });
});
