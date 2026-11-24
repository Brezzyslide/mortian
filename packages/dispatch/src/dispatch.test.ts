import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SandboxCheckout, SandboxMessaging, SandboxRoutes } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { accountBalance, bookNet } from '@project/ledger';
import { DispatchService, dsp, fareFor, PLACEHOLDER_PRICING, QUOTE_TTL_MS } from './service.js';

let db: TestDatabase;
let now = new Date('2026-12-01T09:00:00Z');
const clock = () => now;
let messaging: SandboxMessaging;
let svc: DispatchService;
const checkout = new SandboxCheckout('dispatch-test-secret');
let staff: string;
let n = 0;

// Mararaba (pickup) to Karu (drop-off), about 3 km apart; riders wait near the pickup.
const MARARABA = { lat: 9.0333, lng: 7.5833, address: 'Mararaba main market' };
const KARU = { lat: 9.0167, lng: 7.5667, address: 'Karu site, plot 12' };
const NEAR = { lat: 9.035, lng: 7.585 };
const FAR = { lat: 9.3, lng: 7.9 };

beforeAll(async () => {
  db = await createTestDatabase();
  staff = (await db.pool.query(`INSERT INTO person (email, full_name) VALUES ('ops@x.com', 'Ops') RETURNING id`)).rows[0].id;
  await db.pool.query(`UPDATE product_setting SET live = true WHERE product_code = 'dispatch'`);
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  now = new Date('2026-12-01T09:00:00Z');
  messaging = new SandboxMessaging();
  svc = new DispatchService(db.pool, new SandboxRoutes(), checkout, messaging, { codePepper: randomBytes(32) }, clock);
  await svc.setPricing(PLACEHOLDER_PRICING, null, true);
});

async function person(name: string) {
  const phone = `+234809${String(++n).padStart(7, '0')}`;
  return (await db.pool.query(`INSERT INTO person (phone, full_name) VALUES ($1, $2) RETURNING id`, [phone, name])).rows[0].id as string;
}

async function activeRider(name = 'Rider') {
  const id = await person(name);
  await svc.applyAsRider(id, { kind: 'own_bike' });
  await db.pool.query(
    `INSERT INTO customer_document (person_id, kind, content_type, size_bytes, sha256, storage_key, status, reviewed_by, reviewed_at)
     VALUES ($1, 'drivers_licence', 'image/jpeg', 10, $2, $3, 'accepted', $4, now())`,
    [id, randomBytes(32).toString('hex'), `kyc/${id}/${n}.jpg`, staff],
  );
  await svc.decideRider(id, staff, 'active', 'licence checked');
  await svc.setOnline(id, true, NEAR);
  return id;
}

async function booked(paymentMethod: 'cash' | 'in_app' = 'cash') {
  const customer = await person('Sender');
  const q = await svc.quote(customer, MARARABA, KARU);
  const job = await svc.book(customer, { quoteId: q.quoteId, paymentMethod, recipientName: 'Ada Recipient', recipientPhone: '0803 555 0101' });
  return { customer, job, quote: q };
}

function pay(reference: string, amountKobo: string, eventId = `evt-${++n}`) {
  const w = checkout.buildWebhook({ reference, amountKobo, paidAt: now.toISOString(), eventId });
  return svc.paymentReceived(w.body, w.headers);
}

describe('pricing', () => {
  it('charges base plus distance in whole naira, never below the minimum, with commission in kobo', () => {
    expect(fareFor(3900, PLACEHOLDER_PRICING)).toEqual({ fare: 108_500n, commission: 21_700n }); // ₦500 + 3.9km × ₦150 = ₦1,085
    expect(fareFor(100, PLACEHOLDER_PRICING).fare).toBe(100_000n); // minimum ₦1,000
    expect(fareFor(10_001, PLACEHOLDER_PRICING).fare).toBe(200_100n); // ₦2,000.15 rounds up to ₦2,001, never down
  });

  it('a quote expires after 10 minutes, belongs to one customer, and books once', async () => {
    const customer = await person('Sender');
    const q = await svc.quote(customer, MARARABA, KARU);
    expect(q.isPlaceholderPricing).toBe(true);
    const other = await person('Other');
    await expect(svc.book(other, { quoteId: q.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '08035550101' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(svc.book(customer, { quoteId: q.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '+447700900000' })).rejects.toMatchObject({ code: 'invalid_phone' });
    await svc.book(customer, { quoteId: q.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '08035550101' });
    await expect(svc.book(customer, { quoteId: q.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '08035550101' })).rejects.toMatchObject({ code: 'quote_used' });

    const q2 = await svc.quote(customer, MARARABA, KARU);
    now = new Date(now.getTime() + QUOTE_TTL_MS + 1000);
    await expect(svc.book(customer, { quoteId: q2.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '08035550101' })).rejects.toMatchObject({ code: 'quote_expired' });
  });

  it('a price change does not change a quote already given', async () => {
    const customer = await person('Sender');
    const before = await svc.quote(customer, MARARABA, KARU);
    await svc.setPricing({ ...PLACEHOLDER_PRICING, perKmKobo: 50_000n }, staff);
    const job = await svc.book(customer, { quoteId: before.quoteId, paymentMethod: 'cash', recipientName: 'Ada', recipientPhone: '08035550101' });
    expect(job.fareKobo).toBe(before.fareKobo);
  });
});

describe('riders', () => {
  it('need an accepted driver’s licence to be activated, by someone else', async () => {
    const id = await person('New Rider');
    await svc.applyAsRider(id, { kind: 'own_bike' });
    await expect(svc.applyAsRider(id, { kind: 'own_bike' })).rejects.toMatchObject({ code: 'already_rider' });
    await expect(svc.setOnline(id, true, NEAR)).rejects.toMatchObject({ code: 'rider_not_active' });
    await expect(svc.decideRider(id, staff, 'active', 'ok')).rejects.toMatchObject({ code: 'licence_not_accepted' });
    await expect(svc.decideRider(id, id, 'active', 'self')).rejects.toMatchObject({ code: 'same_person' });
  });

  it('a financed rider rides only while the bike is with them', async () => {
    const id = await person('Financed Rider');
    const fa = (await db.pool.query(`INSERT INTO finance_account (person_id, product_code, status) VALUES ($1, 'motorcycle_ride_to_own', 'approved') RETURNING id, reference`, [id])).rows[0];
    await expect(svc.applyAsRider(id, { kind: 'financed', financeReference: fa.reference })).rejects.toMatchObject({ code: 'finance_account_not_eligible' });
    await db.pool.query(`UPDATE finance_account SET status = 'active' WHERE id = $1`, [fa.id]);
    await svc.applyAsRider(id, { kind: 'financed', financeReference: fa.reference });
    await db.pool.query(
      `INSERT INTO customer_document (person_id, kind, content_type, size_bytes, sha256, storage_key, status, reviewed_by, reviewed_at)
       VALUES ($1, 'drivers_licence', 'image/jpeg', 10, $2, $3, 'accepted', $4, now())`,
      [id, randomBytes(32).toString('hex'), `kyc/${id}/f.jpg`, staff],
    );
    await svc.decideRider(id, staff, 'active', 'ok');
    await svc.setOnline(id, true, NEAR);
    await db.pool.query(`UPDATE finance_account SET status = 'repossessed' WHERE id = $1`, [fa.id]);
    await expect(svc.setOnline(id, true, NEAR)).rejects.toMatchObject({ code: 'finance_account_not_eligible' });
    expect((await svc.rider(id)).financeReference).toBe(fa.reference);
  });
});

describe('a cash delivery', () => {
  it('nearby riders see it; first to accept wins; codes at pickup and drop-off; the rider then owes the commission', async () => {
    const { customer, job } = await booked('cash');
    expect(job.status).toBe('searching');
    expect(job.pickupCode).toMatch(/^\d{6}$/);
    const a = await activeRider('Rider A');
    const b = await activeRider('Rider B');
    const far = await activeRider('Far Rider');
    await svc.setOnline(far, true, FAR);

    const seen = (await svc.availableJobs(a)).jobs.find((j) => j.reference === job.reference)!;
    expect(seen).toMatchObject({ paymentMethod: 'cash', fareKobo: job.fareKobo });
    expect(BigInt(seen.earningKobo)).toBe((BigInt(job.fareKobo) * 8n) / 10n);
    expect((await svc.availableJobs(far)).jobs.some((j) => j.reference === job.reference)).toBe(false);

    const race = await Promise.allSettled([svc.accept(a, job.reference), svc.accept(b, job.reference)]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rider = race[0]!.status === 'fulfilled' ? a : b;

    const view = await svc.customerView(customer, job.reference);
    expect(view.rider!.phone).toMatch(/^\+234/);

    await expect(svc.pickup(rider, job.reference, '000000', MARARABA)).rejects.toMatchObject({ code: 'code_invalid' });
    await expect(svc.deliver(rider, job.reference, view.deliveryCode!, KARU)).rejects.toMatchObject({ code: 'invalid_status' });
    await svc.pickup(rider, job.reference, view.pickupCode!, MARARABA);
    const sms = messaging.sent.find((m) => m.templateId === 'dispatch_delivery_code')!;
    expect(sms).toMatchObject({ to: '+2348035550101', vars: { reference: job.reference, code: view.deliveryCode } });
    await expect(svc.cancelByCustomer(customer, job.reference, 'changed my mind')).rejects.toMatchObject({ code: 'invalid_status' });

    const done = await svc.deliver(rider, job.reference, view.deliveryCode!, KARU);
    expect(done).toMatchObject({ status: 'delivered', collectCashKobo: job.fareKobo, flaggedFarFromDropoff: false });
    const riderRef = (await svc.rider(rider)).reference;
    const commission = BigInt(job.fareKobo) / 5n;
    expect(await accountBalance(db.pool, dsp.rider(riderRef))).toBe(commission); // rider owes it
    expect((await svc.rider(rider)).earningsBalanceKobo).toBe((-commission).toString());
    expect(await bookNet(db.pool, 'dispatch')).toBe(0n);

    const after = await svc.customerView(customer, job.reference);
    expect(after).toMatchObject({ status: 'delivered', pickupCode: null, deliveryCode: null });
    expect(after.rider!.phone).toBeNull();
    expect((await svc.jobEvents(job.reference)).map((e: { kind: string }) => e.kind)).toEqual(['booked', 'accepted', 'picked_up', 'delivered']);
  });

  it('a rider owing more than the limit gets no cash jobs until it is recovered', async () => {
    const rider = await activeRider();
    const ref = (await svc.rider(rider)).reference;
    await db.pool.query(`SELECT 1`);
    // Simulate earlier unpaid cash commissions above the ₦5,000 limit.
    const { postEntry } = await import('@project/ledger');
    await postEntry(db.pool, {
      idempotencyKey: `test-debt:${ref}`,
      source: 'system',
      actorId: 'test',
      occurredAt: now,
      description: 'earlier cash commissions',
      lines: [
        { account: dsp.rider(ref), side: 'debit', amount: 600_000n as never },
        { account: dsp.commission, side: 'credit', amount: 600_000n as never },
      ],
    });
    const cash = await booked('cash');
    const view = await svc.availableJobs(rider);
    expect(view.cashBlocked).toBe(true);
    expect(view.jobs.some((j) => j.reference === cash.job.reference)).toBe(false);
    await expect(svc.accept(rider, cash.job.reference)).rejects.toMatchObject({ code: 'cash_debt_limit' });
    expect((await svc.earnings(rider)).cashBlocked).toBe(true);
  });

  it('codes lock after 5 wrong tries; a rider cannot take their own job or two at once', async () => {
    const rider = await activeRider();
    const own = await svc.quote(rider, MARARABA, KARU);
    const ownJob = await svc.book(rider, { quoteId: own.quoteId, paymentMethod: 'cash', recipientName: 'Me', recipientPhone: '08035550101' });
    await expect(svc.accept(rider, ownJob.reference)).rejects.toMatchObject({ code: 'own_job' });

    const { customer, job } = await booked('cash');
    await svc.accept(rider, job.reference);
    const second = await booked('cash');
    await expect(svc.accept(rider, second.job.reference)).rejects.toMatchObject({ code: 'rider_busy' });
    for (let i = 0; i < 4; i++) await expect(svc.pickup(rider, job.reference, '111111', MARARABA)).rejects.toMatchObject({ code: 'code_invalid' });
    await expect(svc.pickup(rider, job.reference, '111111', MARARABA)).rejects.toMatchObject({ code: 'code_locked' });
    const right = (await svc.customerView(customer, job.reference)).pickupCode!;
    await expect(svc.pickup(rider, job.reference, right, MARARABA)).rejects.toMatchObject({ code: 'code_locked' });
    expect((await svc.jobs('accepted')).find((j: { reference: string }) => j.reference === job.reference)).toMatchObject({ codeLocked: true });
  });

  it('a delivery confirmed far from the drop-off is flagged for review, not refused', async () => {
    const { customer, job } = await booked('cash');
    const rider = await activeRider();
    await svc.accept(rider, job.reference);
    const v = await svc.customerView(customer, job.reference);
    await svc.pickup(rider, job.reference, v.pickupCode!, MARARABA);
    expect((await svc.deliver(rider, job.reference, v.deliveryCode!, MARARABA)).flaggedFarFromDropoff).toBe(true);
    expect((await svc.jobs('delivered')).find((j: { reference: string }) => j.reference === job.reference)).toMatchObject({ flagged: true });
  });
});

describe('an in-app paid delivery', () => {
  it('waits for a verified payment, then the fare is split into rider earnings and commission', async () => {
    const { customer, job } = await booked('in_app');
    expect(job).toMatchObject({ status: 'awaiting_payment', payUrl: expect.stringContaining(job.reference) });
    const rider = await activeRider();
    expect((await svc.availableJobs(rider)).jobs.some((j) => j.reference === job.reference)).toBe(false);

    // wrong amount: held in suspense, the job is not released
    expect(await pay(job.reference, '100')).toMatchObject({ outcome: 'unmatched' });
    expect((await svc.customerView(customer, job.reference)).status).toBe('awaiting_payment');

    expect(await pay(job.reference, job.fareKobo, 'evt-good')).toMatchObject({ outcome: 'paid' });
    expect(await pay(job.reference, job.fareKobo, 'evt-good')).toMatchObject({ outcome: 'duplicate' });
    // a second, different payment for the same job is not counted twice
    expect(await pay(job.reference, job.fareKobo, 'evt-second')).toMatchObject({ outcome: 'unmatched' });
    expect(await accountBalance(db.pool, dsp.prepaid(job.reference))).toBe(-BigInt(job.fareKobo));

    await svc.accept(rider, job.reference);
    const v = await svc.customerView(customer, job.reference);
    await svc.pickup(rider, job.reference, v.pickupCode!, MARARABA);
    await svc.deliver(rider, job.reference, v.deliveryCode!, KARU);
    const fare = BigInt(job.fareKobo);
    const ref = (await svc.rider(rider)).reference;
    expect(await accountBalance(db.pool, dsp.prepaid(job.reference))).toBe(0n);
    expect(-(await accountBalance(db.pool, dsp.rider(ref)))).toBe(fare - fare / 5n);
    expect(await bookNet(db.pool, 'dispatch')).toBe(0n);
    // dispatch money never touches the financing book
    const fin = await db.pool.query(`SELECT count(*)::int AS n FROM ledger_line WHERE book = 'financing' AND account_code LIKE '%DJ-%'`);
    expect(fin.rows[0].n).toBe(0);
  });

  it('cancelling a paid job before pickup turns the fare into a refund owed to the customer', async () => {
    const { customer, job } = await booked('in_app');
    await pay(job.reference, job.fareKobo);
    const r = await svc.cancelByCustomer(customer, job.reference, 'no longer needed');
    expect(r).toMatchObject({ status: 'cancelled', refundKobo: job.fareKobo });
    expect(await accountBalance(db.pool, dsp.refund(job.reference))).toBe(-BigInt(job.fareKobo));
    await expect(db.pool.query(`UPDATE dispatch_job SET status = 'searching' WHERE reference = $1`, [job.reference])).rejects.toThrow(/final/);
    // a payment arriving after cancellation is held, not applied
    expect(await pay(job.reference, job.fareKobo)).toMatchObject({ outcome: 'unmatched' });
  });

  it('rejects forged webhooks', async () => {
    const { job } = await booked('in_app');
    const w = checkout.buildWebhook({ reference: job.reference, amountKobo: job.fareKobo, paidAt: now.toISOString(), eventId: 'evt-forged' });
    await expect(svc.paymentReceived(Buffer.from(w.body.toString().replace(job.fareKobo, '1')), w.headers)).rejects.toThrow(/signature/i);
  });
});

describe('the job record', () => {
  it('fare and parties cannot be changed, and history is append-only', async () => {
    const { job } = await booked('cash');
    await expect(db.pool.query(`UPDATE dispatch_job SET fare_kobo = 1 WHERE reference = $1`, [job.reference])).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`DELETE FROM dispatch_job_event`)).rejects.toThrow(/cannot be deleted/);
  });
});
