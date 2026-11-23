import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidWebhookSignatureError, SandboxCollections } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { accountBalance, bookNet } from '@project/ledger';
import { clearingAccount, CollectionsService, UNMATCHED_SUSPENSE } from './collections.js';

let db: TestDatabase;
let svc: CollectionsService;
const provider = new SandboxCollections('finance-test-secret-1');
let personId: string;
let refSeq = 0;
const ref = () => `PAY-${++refSeq}`;

beforeAll(async () => {
  db = await createTestDatabase();
  svc = new CollectionsService(db.pool, provider);
  const { rows } = await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348030000001') RETURNING id`);
  personId = rows[0].id;
});
afterAll(async () => db?.drop());

async function activeAccount(status = 'active') {
  const fa = await svc.openAccount(personId, 'motorcycle_ride_to_own');
  await db.pool.query('UPDATE finance_account SET status = $2 WHERE id = $1', [fa.id, status]);
  const va = await svc.provisionVirtualAccount(fa.id, 'Test Rider');
  return { ...fa, accountNumber: va.accountNumber };
}

const webhook = (accountNumber: string, amountKobo: string, reference = ref()) =>
  provider.buildWebhook({ reference, accountNumber, amountKobo, paidAt: '2026-11-23T08:00:00Z' });

describe('virtual accounts', () => {
  it('provisioning twice returns the same account number', async () => {
    const fa = await svc.openAccount(personId, 'phone_financing');
    const a = await svc.provisionVirtualAccount(fa.id, 'X');
    const b = await svc.provisionVirtualAccount(fa.id, 'X');
    expect(b.accountNumber).toBe(a.accountNumber);
    expect(fa.reference).toMatch(/^FA-\d{6}$/);
  });
});

describe('ingestWebhook', () => {
  it('posts a payment to the account suspense and the provider clearing account', async () => {
    const fa = await activeAccount();
    const { body, headers } = webhook(fa.accountNumber, '2500000');
    const r = await svc.ingestWebhook(body, headers);
    expect(r).toMatchObject({ outcome: 'posted', financeAccountReference: fa.reference, problem: null });
    expect(await svc.suspenseBalance(fa.reference)).toBe(2500000n);
  });

  it('is exactly-once under redelivery', async () => {
    const fa = await activeAccount();
    const { body, headers } = webhook(fa.accountNumber, '100000');
    const first = await svc.ingestWebhook(body, headers);
    const again = await svc.ingestWebhook(body, headers);
    expect(again).toEqual({ outcome: 'duplicate', eventId: (first as { eventId: string }).eventId });
    expect(await svc.suspenseBalance(fa.reference)).toBe(100000n);
  });

  it('is exactly-once when the same webhook arrives 10 times concurrently', async () => {
    const fa = await activeAccount();
    const { body, headers } = webhook(fa.accountNumber, '77700');
    await Promise.all(Array.from({ length: 10 }, () => svc.ingestWebhook(body, headers)));
    expect(await svc.suspenseBalance(fa.reference)).toBe(77700n);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM payment_event WHERE account_number = $1', [
      fa.accountNumber,
    ]);
    expect(rows[0].n).toBe(1);
  });

  it('recovers when a previous delivery stopped after recording the event but before posting', async () => {
    const fa = await activeAccount();
    const reference = ref();
    const { body, headers } = webhook(fa.accountNumber, '55500', reference);
    // Simulate the crash: the event row exists in 'received' state, nothing posted.
    await db.pool.query(
      `INSERT INTO payment_event (provider, provider_reference, account_number, amount, paid_at, payload)
       VALUES ('sandbox', $1, $2, 55500, '2026-11-23T08:00:00Z', '{}')`,
      [reference, fa.accountNumber],
    );
    const r = await svc.ingestWebhook(body, headers);
    expect(r.outcome).toBe('posted');
    expect(await svc.suspenseBalance(fa.reference)).toBe(55500n);
  });

  it('flags, and does not post, a redelivery whose amount differs from the original', async () => {
    const fa = await activeAccount();
    const reference = ref();
    const a = webhook(fa.accountNumber, '10000', reference);
    await svc.ingestWebhook(a.body, a.headers);
    const b = webhook(fa.accountNumber, '99999', reference);
    const r = await svc.ingestWebhook(b.body, b.headers);
    expect(r.outcome).toBe('conflict');
    expect(await svc.suspenseBalance(fa.reference)).toBe(10000n);
    expect((await svc.openProblems()).map((p) => p.problem)).toContain('conflicting_redelivery');
  });

  it('posts unknown account numbers to unmatched suspense and queues them for review', async () => {
    const { body, headers } = webhook('9900000000', '4200');
    const r = await svc.ingestWebhook(body, headers);
    expect(r.outcome).toBe('unmatched');
    expect(-(await accountBalance(db.pool, UNMATCHED_SUSPENSE))).toBe(4200n);
    const problems = await svc.openProblems();
    expect(problems.some((p) => p.problem === 'unknown_account_number' && p.amount === 4200n)).toBe(true);
  });

  it('posts payments to closed accounts but flags them', async () => {
    const fa = await activeAccount('settled');
    const { body, headers } = webhook(fa.accountNumber, '3000');
    const r = await svc.ingestWebhook(body, headers);
    expect(r).toMatchObject({ outcome: 'posted', problem: 'account_status_settled' });
  });

  it('rejects a bad signature without writing anything', async () => {
    const fa = await activeAccount();
    const { body } = webhook(fa.accountNumber, '1000');
    const before = await db.pool.query('SELECT count(*)::int AS n FROM payment_event');
    await expect(svc.ingestWebhook(body, { 'x-sandbox-signature': 'f'.repeat(128) })).rejects.toBeInstanceOf(
      InvalidWebhookSignatureError,
    );
    const after = await db.pool.query('SELECT count(*)::int AS n FROM payment_event');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('exceptions queue', () => {
  it('assigns an unmatched payment to the right account via a suspense transfer', async () => {
    const fa = await activeAccount();
    const { body, headers } = webhook('9911111111', '6000');
    const r = (await svc.ingestWebhook(body, headers)) as { eventId: string };
    const unmatchedBefore = await accountBalance(db.pool, UNMATCHED_SUSPENSE);

    await svc.assignUnmatched(r.eventId, fa.reference, personId, 'customer sent proof of transfer');
    expect(await svc.suspenseBalance(fa.reference)).toBe(6000n);
    expect(await accountBalance(db.pool, UNMATCHED_SUSPENSE)).toBe(unmatchedBefore + 6000n);
    expect((await svc.openProblems()).some((p) => p.eventId === r.eventId)).toBe(false);
    await expect(svc.assignUnmatched(r.eventId, fa.reference, personId, 'again')).rejects.toThrow();
  });

  it('refuses to edit the stored facts of a payment event', async () => {
    await expect(db.pool.query('UPDATE payment_event SET amount = amount + 1')).rejects.toThrow(/immutable/);
    await expect(db.pool.query('DELETE FROM payment_event')).rejects.toThrow(/immutable/);
  });
});

describe('reconciliation invariants', () => {
  it('clearing equals the sum of every payment received, and the book nets to zero', async () => {
    const { rows } = await db.pool.query(`SELECT coalesce(sum(amount), 0)::text AS total FROM payment_event WHERE status <> 'received'`);
    expect(await accountBalance(db.pool, clearingAccount('sandbox'))).toBe(BigInt(rows[0].total));
    expect(await bookNet(db.pool, 'financing')).toBe(0n);
  });
});
