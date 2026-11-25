import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SandboxMessaging, SandboxPayouts, paystackNgTransferFee } from '@project/adapters';
import { kobo } from '@project/domain';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { accountBalance, bookNet, postEntry } from '@project/ledger';
import { lagosDay, nameMatches, payoutAccounts, PayoutService, PLACEHOLDER_PAYOUT_SETTINGS } from './payouts.js';
import { dsp } from './service.js';

let db: TestDatabase;
let now = new Date('2026-11-30T09:00:00Z'); // a Monday
const clock = () => now;
let messaging: SandboxMessaging;
let provider: SandboxPayouts;
let svc: PayoutService;
let staff: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  staff = (await db.pool.query(`INSERT INTO person (email, full_name) VALUES ('fin@x.com', 'Fin') RETURNING id`)).rows[0].id;
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  now = new Date('2026-11-30T09:00:00Z');
  messaging = new SandboxMessaging();
  provider = new SandboxPayouts('payout-test-secret');
  svc = new PayoutService(db.pool, provider, messaging, clock);
  await svc.setSettings(PLACEHOLDER_PAYOUT_SETTINGS, null, true);
});

/** An active rider with `earned` kobo of earnings in the dispatch book. */
async function rider(name: string, earned: bigint, financeAccountId: string | null = null) {
  const phone = `+234808${String(++n).padStart(7, '0')}`;
  const id = (await db.pool.query(`INSERT INTO person (phone, full_name) VALUES ($1, $2) RETURNING id`, [phone, name])).rows[0].id as string;
  const ref = (await db.pool.query(
    `INSERT INTO rider (person_id, kind, finance_account_id, status) VALUES ($1, $2, $3, 'active') RETURNING reference`,
    [id, financeAccountId ? 'financed' : 'own_bike', financeAccountId],
  )).rows[0].reference as string;
  if (earned > 0n) {
    await postEntry(db.pool, {
      idempotencyKey: `earn:${ref}`,
      source: 'system',
      actorId: 'test',
      occurredAt: now,
      description: 'deliveries',
      lines: [
        { account: dsp.prepaid(`DJ-T${n}`), side: 'debit', amount: kobo(earned) },
        { account: dsp.rider(ref), side: 'credit', amount: kobo(earned) },
      ],
    });
  }
  return { id, ref, phone };
}

async function withAccount(name: string, earned: bigint, bankName = name) {
  const r = await rider(name, earned);
  const acct = String(1_000_000_000 + n);
  provider.openAccount('999', acct, bankName);
  await svc.linkBankAccount(r.id, '999', acct);
  return { ...r, acct };
}

function outcome(reference: string, status: 'succeeded' | 'failed', eventId = `evt-${++n}`, reason?: string) {
  const w = provider.buildWebhook({ reference, status, eventId, ...(reason ? { reason } : {}) });
  return svc.transferOutcome(w.body, w.headers);
}

describe('matching the bank’s name to the rider', () => {
  it('compares words, in any order, ignoring accents, middle names and punctuation', () => {
    expect(nameMatches('Adébáyọ̀ Ọlọ́rùn', 'OLORUN ADEBAYO')).toBe(true);
    expect(nameMatches('Bola Rider', 'RIDER, BOLA AMINA')).toBe(true);
    expect(nameMatches('Chukwuemeka Obi', 'OBI CHUKWUEMEKA J.')).toBe(true);
    expect(nameMatches('Bola Rider', 'BOLA ADEYEMI')).toBe(false); // first name only: not enough
    expect(nameMatches('Bola Rider', 'MUSA IBRAHIM')).toBe(false);
  });
});

describe('bank accounts', () => {
  it('an account in the rider’s name is ready at once; another name waits for finance', async () => {
    const ok = await withAccount('Bola Rider', 0n, 'RIDER BOLA');
    expect(await svc.bankAccount(ok.id)).toMatchObject({ nameCheck: 'matched', ready: true, accountNumberMasked: `******${ok.acct.slice(-4)}` });

    const odd = await withAccount('Musa Rider', 500_000n, 'IBRAHIM TRADING VENTURES');
    expect(await svc.bankAccount(odd.id)).toMatchObject({ nameCheck: 'needs_review', ready: false });
    await expect(svc.requestInstant(odd.id)).rejects.toMatchObject({ code: 'bank_account_not_ready' });
    const review = (await svc.accountsForReview()).find((a: { personId: string }) => a.personId === odd.id)!;
    expect(review).toMatchObject({ verifiedName: 'Musa Rider', accountName: 'IBRAHIM TRADING VENTURES' });
    await expect(svc.reviewBankAccount(review.id, odd.id, 'approved', 'self')).rejects.toMatchObject({ code: 'same_person' });
    await svc.reviewBankAccount(review.id, staff, 'rejected', 'Business account; must be personal');
    await expect(svc.requestInstant(odd.id)).rejects.toMatchObject({ code: 'bank_account_rejected' });
  });

  it('an unknown account number is refused before anything is saved', async () => {
    const r = await rider('Ade Rider', 0n);
    await expect(svc.linkBankAccount(r.id, '999', '0000000000')).rejects.toMatchObject({ code: 'account_not_found' });
    await expect(svc.linkBankAccount(r.id, '123', '0000000000')).rejects.toMatchObject({ code: 'account_not_found' });
    expect(await svc.bankAccount(r.id)).toBeNull();
  });

  it('changing the account texts the rider and pauses payouts for the cooling-off period', async () => {
    const r = await withAccount('Tunde Rider', 1_000_000n);
    provider.openAccount('998', '2222222222', 'TUNDE RIDER');
    await svc.linkBankAccount(r.id, '998', '2222222222');
    expect(messaging.sent.find((m) => m.templateId === 'payout_account_changed')).toMatchObject({ to: r.phone, vars: { last4: '2222', hours: '24' } });
    await expect(svc.requestInstant(r.id)).rejects.toMatchObject({ code: 'bank_account_not_ready' });
    now = new Date(now.getTime() + 25 * 3_600_000);
    expect((await svc.requestInstant(r.id))[0]).toMatchObject({ status: 'sent' });
    expect(provider.transfers.at(-1)!.recipientCode).toContain('2222222222');
  });
});

describe('instant withdrawal', () => {
  it('pays the balance minus the transfer fee, which the rider bears; success books the provider fee', async () => {
    const r = await withAccount('Ngozi Rider', 2_000_000n); // ₦20,000
    const [p] = await svc.requestInstant(r.id);
    const fee = paystackNgTransferFee(kobo(2_000_000n)); // ₦25 + ₦50 stamp duty
    expect(fee).toBe(7_500n);
    expect(p).toMatchObject({ kind: 'earnings', netKobo: String(2_000_000n - fee), status: 'sent' });
    expect(provider.transfers.at(-1)!.amount).toBe(2_000_000n - fee);
    expect(await accountBalance(db.pool, dsp.rider(r.ref))).toBe(0n);

    await outcome(p!.reference, 'succeeded', 'evt-ok');
    expect(await outcome(p!.reference, 'succeeded', 'evt-ok')).toMatchObject({ outcome: 'duplicate' });
    expect(await accountBalance(db.pool, payoutAccounts.inTransit(p!.reference))).toBe(0n);
    expect(await accountBalance(db.pool, payoutAccounts.feeExpense)).toBeGreaterThan(0n);
    expect(await bookNet(db.pool, 'dispatch')).toBe(0n);
    await expect(db.pool.query(`UPDATE payout SET failure_reason = 'x' WHERE reference = $1`, [p!.reference])).rejects.toThrow(/final/);
  });

  it('cannot take more than is available, below the minimum, or past the daily limit; two at once cannot double-spend', async () => {
    const r = await withAccount('Ada Rider', 300_000n); // ₦3,000
    await expect(svc.requestInstant(r.id, 400_000n)).rejects.toMatchObject({ code: 'insufficient_balance' });
    await expect(svc.requestInstant(r.id, 50_000n)).rejects.toMatchObject({ code: 'below_minimum' });
    const race = await Promise.allSettled([svc.requestInstant(r.id, 200_000n), svc.requestInstant(r.id, 200_000n)]);
    expect(race.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await accountBalance(db.pool, dsp.rider(r.ref))).toBe(-100_000n);

    await svc.setSettings({ ...PLACEHOLDER_PAYOUT_SETTINGS, instantDailyLimitKobo: 250_000n }, staff);
    await expect(svc.requestInstant(r.id, 100_000n)).rejects.toMatchObject({ code: 'daily_limit' });
  });

  it('a rider who owes cash commission has nothing to withdraw', async () => {
    const r = await withAccount('Owing Rider', 0n);
    await postEntry(db.pool, {
      idempotencyKey: `owe:${r.ref}`, source: 'system', actorId: 'test', occurredAt: now, description: 'cash commission',
      lines: [{ account: dsp.rider(r.ref), side: 'debit', amount: kobo(20_000n) }, { account: dsp.commission, side: 'credit', amount: kobo(20_000n) }],
    });
    await expect(svc.requestInstant(r.id)).rejects.toMatchObject({ code: 'below_minimum' });
    expect((await svc.summary(r.id)).availableKobo).toBe('0');
  });

  it('a failed transfer gives everything back, fee included', async () => {
    const r = await withAccount('Fola Rider', 600_000n);
    const [p] = await svc.requestInstant(r.id);
    await outcome(p!.reference, 'failed', 'evt-fail', 'Account dormant');
    expect(await accountBalance(db.pool, dsp.rider(r.ref))).toBe(-600_000n);
    expect((await svc.summary(r.id)).history[0]).toMatchObject({ status: 'failed', failureReason: 'Account dormant' });

    provider.failNextTransfer = 'insufficient balance';
    const [q] = await svc.requestInstant(r.id);
    expect(q).toMatchObject({ status: 'failed' });
    expect(await accountBalance(db.pool, dsp.rider(r.ref))).toBe(-600_000n);
    expect(await bookNet(db.pool, 'dispatch')).toBe(0n);
  });
});

describe('weekly payout', () => {
  it('runs only on the set weekday, pays everyone their full balance with no fee to the rider, and once per day', async () => {
    const a = await withAccount('Week Rider', 3_000_000n);
    const noAccount = await rider('No Account Rider', 3_000_000n);
    const tuesday = '2026-12-01';
    expect(await svc.runWeekly(tuesday)).toMatchObject({ ran: false });
    expect(lagosDay(now)).toBe('2026-11-30');
    const r = await svc.runWeekly('2026-11-30');
    expect(r.ran).toBe(true);
    expect(r.skipped).toBeGreaterThanOrEqual(1); // the rider with no bank account is skipped, not fatal
    const mine = (await svc.summary(a.id)).history[0];
    expect(mine).toMatchObject({ trigger: 'weekly', grossKobo: '3000000', riderFeeKobo: '0', netKobo: '3000000' });
    expect((await svc.summary(noAccount.id)).availableKobo).toBe('3000000');
    const again = await svc.runWeekly('2026-11-30');
    expect((await svc.summary(a.id)).history.filter((h: { trigger: string }) => h.trigger === 'weekly')).toHaveLength(1);
    expect(again.ran).toBe(true);
  });
});

describe('loan repayment from earnings', () => {
  async function financed(name: string, earned: bigint) {
    const person = (await db.pool.query(`INSERT INTO person (phone, full_name) VALUES ($1, $2) RETURNING id`, [`+234807${String(++n).padStart(7, '0')}`, name])).rows[0].id;
    const fa = (await db.pool.query(`INSERT INTO finance_account (person_id, product_code, status) VALUES ($1, 'motorcycle_ride_to_own', 'active') RETURNING id`, [person])).rows[0].id;
    const va = `99${String(10_000_000 + n).padStart(8, '0')}`;
    await db.pool.query(`INSERT INTO virtual_account (account_number, bank_name, provider, provider_reference, finance_account_id) VALUES ($1, 'Sandbox Bank', 'sandbox', $2, $3)`, [va, `ref-${n}`, fa]);
    await db.pool.query('DELETE FROM person WHERE id = $1 AND false', [person]);
    const ref = (await db.pool.query(`INSERT INTO rider (person_id, kind, finance_account_id, status) VALUES ($1, 'financed', $2, 'active') RETURNING reference`, [person, fa])).rows[0].reference;
    await postEntry(db.pool, {
      idempotencyKey: `earn:${ref}`, source: 'system', actorId: 'test', occurredAt: now, description: 'deliveries',
      lines: [{ account: dsp.prepaid(`DJ-L${n}`), side: 'debit', amount: kobo(earned) }, { account: dsp.rider(ref), side: 'credit', amount: kobo(earned) }],
    });
    const acct = String(1_000_000_000 + ++n);
    provider.openAccount('999', acct, name);
    await svc.linkBankAccount(person, '999', acct);
    return { id: person as string, ref: ref as string, va };
  }

  it('the rider’s chosen share goes to their loan repayment account as its own transfer; the books stay separate', async () => {
    const r = await financed('Loan Rider', 1_000_000n);
    await expect(svc.setLoanShare(r.id, 6000)).rejects.toMatchObject({ code: 'loan_share_not_allowed' }); // above the 50% maximum
    await svc.setLoanShare(r.id, 3000);
    const parts = await svc.requestInstant(r.id);
    expect(parts.map((p) => p.kind)).toEqual(['loan_repayment', 'earnings']);
    expect(parts[0]!.netKobo).toBe('300000'); // 30%, no fee taken from the loan part
    const loanTransfer = provider.transfers.find((t) => t.reference === parts[0]!.reference)!;
    expect(loanTransfer.recipientCode).toContain(r.va);
    // nothing was posted to the financing book: the loan is credited when the transfer arrives at the repayment account
    const fin = await db.pool.query(`SELECT count(*)::int AS n FROM ledger_line WHERE book = 'financing'`);
    expect(fin.rows[0].n).toBe(0);
  });

  it('an own-bike rider cannot set a loan share', async () => {
    const r = await withAccount('Own Bike Rider', 0n);
    await expect(svc.setLoanShare(r.id, 1000)).rejects.toMatchObject({ code: 'loan_share_not_allowed' });
  });
});

describe('webhooks', () => {
  it('rejects forged ones', async () => {
    const w = provider.buildWebhook({ reference: 'PO-000001', status: 'succeeded', eventId: 'x' });
    await expect(svc.transferOutcome(Buffer.from(w.body.toString().replace('succeeded', 'failed')), w.headers)).rejects.toThrow(/signature/i);
  });
});
