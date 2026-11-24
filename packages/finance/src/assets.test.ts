import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { accountBalance, bookNet } from '@project/ledger';
import { ArrearsService } from './arrears.js';
import { AssetService, isValidImei, normaliseId, PRODUCT_ASSET_KINDS, productNeedsAsset } from './assets.js';

const PRODUCT_CODES_FINANCED = Object.keys(PRODUCT_ASSET_KINDS) as (keyof typeof PRODUCT_ASSET_KINDS)[];
import { CollectionsService } from './collections.js';
import { acct, LendingService } from './lending.js';
import { addPeriods } from './schedule.js';
import { MOTORCYCLE_PLACEHOLDER_TIERS } from './terms.js';

let db: TestDatabase;
let today = '2026-12-01';
const clock = () => new Date(`${today}T10:00:00+01:00`);
let lending: LendingService;
let arrears: ArrearsService;
let assets: AssetService;
let collections: CollectionsService;
const provider = new SandboxCollections('assets-test-secret');
let staffA: string;
let staffB: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const p = await db.pool.query(`INSERT INTO person (email) VALUES ('a@x.com'), ('b@x.com') RETURNING id`);
  staffA = p.rows[0].id;
  staffB = p.rows[1].id;
  // requireAsset defaults to true: these tests run handover the way production does.
  const l = new LendingService(db.pool, clock, { requireSignedContract: false });
  for (const [tier, config] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
    await l.publishTier('motorcycle_ride_to_own', tier, config, { actorId: null, isPlaceholder: true });
  }
});
afterAll(async () => db?.drop());
beforeEach(() => {
  today = '2026-12-01';
  lending = new LendingService(db.pool, clock, { requireSignedContract: false });
  arrears = new ArrearsService(db.pool, lending, new SandboxMessaging(), clock);
  assets = new AssetService(db.pool, clock);
  collections = new CollectionsService(db.pool, provider);
});

const chassis = () => `MD2A12BZ${String(++n).padStart(8, '0')}`;
const bike = (over: Partial<Parameters<AssetService['register']>[0]> = {}) =>
  assets.register(
    { kind: 'motorcycle', make: 'Bajaj', model: 'Boxer BM150', year: 2026, idKind: 'chassis', identifier: chassis(), costKobo: 120_000_000n, location: 'Mararaba yard', ...over },
    staffA,
  );

async function pay(accountNumber: string, amount: bigint) {
  const { body, headers } = provider.buildWebhook({ reference: `AS-${++n}`, accountNumber, amountKobo: amount.toString(), paidAt: clock().toISOString() });
  await collections.ingestWebhook(body, headers);
}

async function approved(product: 'motorcycle_ride_to_own' = 'motorcycle_ride_to_own') {
  const person = await db.pool.query(`INSERT INTO person (phone) VALUES ($1) RETURNING id`, [`+234807${String(++n).padStart(7, '0')}`]);
  const fa = await collections.openAccount(person.rows[0].id, product);
  const va = await collections.provisionVirtualAccount(fa.id, 'Rider');
  await lending.approve({ financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: staffA });
  return { ...fa, accountNumber: va.accountNumber };
}

async function handedOver() {
  const fa = await approved();
  const a = await bike();
  await assets.assign(a.id, fa.id, staffA);
  await pay(fa.accountNumber, 30_000_000n);
  await lending.activate(fa.id, staffB, '2026-12-01');
  return { fa, asset: a };
}

async function approve(kind: 'repossession' | 'close_recovered' | 'release' | 'asset_sale', financeAccountId: string, payload: Record<string, unknown> = {}) {
  await lending.assertRecoveryAllowed(kind, financeAccountId, payload);
  const req = await lending.requestApproval({ kind, financeAccountId, payload, reason: 'asset lifecycle test', requestedBy: staffA });
  return lending.decideApproval(req, staffB, 'approved', 'ok');
}

/** Handed over, never paid again, repossessed and closed after the cure deadline. */
async function closedAndInYard() {
  const { fa, asset } = await handedOver();
  for (let d = '2026-12-09'; d <= '2026-12-22'; d = addPeriods(d, 'daily', 1)) {
    today = d;
    await arrears.processAccount(fa.id, d);
  }
  await approve('repossession', fa.id, { location: 'Mararaba yard, bay 3', condition: 'scratched tank', photoRefs: [] });
  today = '2027-01-02';
  await approve('close_recovered', fa.id);
  return { fa, asset };
}

const assetOf = async (id: string) => (await assets.get(id)).asset;

describe('registering assets', () => {
  it('normalises identifiers and refuses duplicates however they are typed', async () => {
    const id = chassis();
    const a = await bike({ identifier: id.toLowerCase().replace(/(.{4})/g, '$1 ').trim(), plateNumber: 'abc-123 xy' });
    expect(a).toMatchObject({ identifier: id, plateNumber: 'ABC123XY', status: 'in_stock', location: 'Mararaba yard' });
    await expect(bike({ identifier: `${id.slice(0, 4)}-${id.slice(4)}` })).rejects.toMatchObject({ code: 'duplicate' });
    await expect(bike({ plateNumber: 'ABC 123 XY' })).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('checks IMEIs and matches identifier type to the kind of asset', async () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    const phone = { kind: 'phone' as const, make: 'Tecno', model: 'Spark 20', idKind: 'imei' as const, costKobo: 15_000_000n, location: 'Branch' };
    await expect(assets.register({ ...phone, identifier: '490154203237519' }, staffA)).rejects.toMatchObject({ code: 'invalid_identifier' });
    await expect(assets.register({ ...phone, idKind: 'serial', identifier: 'SN12345' }, staffA)).rejects.toMatchObject({ code: 'invalid_identifier' });
    await expect(bike({ idKind: 'serial' })).rejects.toMatchObject({ code: 'invalid_identifier' });
    expect((await assets.register({ ...phone, identifier: '49-015420-323751-8' }, staffA)).identifier).toBe('490154203237518');
    expect(normaliseId(' ab.c-d/e ')).toBe('ABCDE');
  });
});

describe('handover', () => {
  it('needs a registered asset of the right kind, assigned after approval', async () => {
    const fa = await approved();
    await pay(fa.accountNumber, 30_000_000n);
    await expect(lending.activate(fa.id, staffB)).rejects.toMatchObject({ code: 'no_asset' });

    const phone = await assets.register({ kind: 'phone', make: 'Tecno', model: 'Spark', idKind: 'imei', identifier: '356938035643809', costKobo: 1n, location: 'Branch' }, staffA);
    await expect(assets.assign(phone.id, fa.id, staffA)).rejects.toMatchObject({ code: 'wrong_kind' });

    const a = await bike();
    await assets.assign(a.id, fa.id, staffA);
    await expect(assets.assign((await bike()).id, fa.id, staffA)).rejects.toMatchObject({ code: 'account_has_asset' });
    const other = await approved();
    await expect(assets.assign(a.id, other.id, staffA)).rejects.toMatchObject({ code: 'invalid_status' });

    // the wrong bike was picked: return it to stock and assign another
    await assets.unassign(a.id, staffA, 'picked the wrong bike');
    expect(await assetOf(a.id)).toMatchObject({ status: 'in_stock', financeAccountId: null });
    const b = await bike();
    await assets.assign(b.id, fa.id, staffA);

    await lending.activate(fa.id, staffB, '2026-12-01');
    expect(await assetOf(b.id)).toMatchObject({ status: 'with_customer', reference: fa.reference });
    await expect(assets.unassign(b.id, staffA, 'too late')).rejects.toMatchObject({ code: 'invalid_status' });
    await expect(assets.writeOff(b.id, staffA, 'customer says stolen')).rejects.toMatchObject({ code: 'invalid_status' });
  });

  it('cannot assign before approval; only school fees finance no asset', async () => {
    const person = await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348070000999') RETURNING id`);
    const applied = await collections.openAccount(person.rows[0].id, 'motorcycle_ride_to_own');
    await expect(assets.assign((await bike()).id, applied.id, staffA)).rejects.toMatchObject({ code: 'invalid_status' });
    expect(PRODUCT_CODES_FINANCED.filter((p) => !productNeedsAsset(p))).toEqual(['school_fee_financing']);
  });

  it('two accounts racing for the same bike: exactly one gets it', async () => {
    const [x, y] = [await approved(), await approved()];
    const a = await bike();
    const r = await Promise.allSettled([assets.assign(a.id, x.id, staffA), assets.assign(a.id, y.id, staffA)]);
    expect(r.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('recovery and resale', () => {
  it('repossession moves the bike to the yard; release brings it back only when cleared', async () => {
    const { fa, asset } = await handedOver();
    for (let d = '2026-12-09'; d <= '2026-12-22'; d = addPeriods(d, 'daily', 1)) {
      today = d;
      await arrears.processAccount(fa.id, d);
    }
    await approve('repossession', fa.id, { location: 'Mararaba yard, bay 3', condition: 'good', photoRefs: [] });
    expect(await assetOf(asset.id)).toMatchObject({ status: 'recovered', location: 'Mararaba yard, bay 3' });

    await expect(lending.assertRecoveryAllowed('release', fa.id)).rejects.toMatchObject({ code: 'invalid_status' });
    const owed = (await lending.statement(fa.id, today)).arrears!.reactivationAmount;
    await pay(fa.accountNumber, owed);
    await lending.applyCredit(fa.id, 'cure', today);
    await approve('release', fa.id);
    expect(await assetOf(asset.id)).toMatchObject({ status: 'with_customer' });
    const events = (await assets.get(asset.id)).events.map((e: { kind: string }) => e.kind);
    expect(events).toEqual(['registered', 'assigned', 'handed_over', 'recovered', 'returned']);
  });

  it('closure lists the bike for sale; the sale pays fees, penalty, interest, then principal, and a shortfall stays owed', async () => {
    const { fa, asset } = await closedAndInYard();
    expect(await assetOf(asset.id)).toMatchObject({ status: 'for_sale' });
    const before = {
      penalty: await accountBalance(db.pool, acct.penalty(fa.reference)),
      interest: await accountBalance(db.pool, acct.interest(fa.reference)),
      principal: await accountBalance(db.pool, acct.principal(fa.reference)),
    };
    expect(before.penalty).toBeGreaterThan(0n);

    // nothing sells without a price, and never on one person's say-so
    await expect(lending.assertRecoveryAllowed('asset_sale', fa.id, { priceKobo: '0' })).rejects.toMatchObject({ code: 'invalid_status' });
    const req = await lending.requestApproval({ kind: 'asset_sale', financeAccountId: fa.id, payload: { priceKobo: '80000000', buyerName: 'Musa Ibrahim', buyerPhone: '+2348031112222' }, reason: 'best of 3 offers', requestedBy: staffA });
    await expect(lending.decideApproval(req, staffA, 'approved', 'self')).rejects.toMatchObject({ code: 'same_person' });
    const r = (await lending.decideApproval(req, staffB, 'approved', 'ok')).result as { surplusKobo: string; shortfallKobo: string };

    const price = 80_000_000n;
    const toPenalty = before.penalty;
    const toInterest = before.interest;
    const toPrincipal = price - toPenalty - toInterest;
    expect(await accountBalance(db.pool, acct.penalty(fa.reference))).toBe(0n);
    expect(await accountBalance(db.pool, acct.interest(fa.reference))).toBe(0n);
    expect(await accountBalance(db.pool, acct.principal(fa.reference))).toBe(before.principal - toPrincipal);
    expect(await accountBalance(db.pool, acct.resaleClearing)).toBe(price);
    expect(r).toMatchObject({ surplusKobo: '0', shortfallKobo: (before.principal - toPrincipal).toString() });
    expect(await bookNet(db.pool, 'financing')).toBe(0n);

    const sold = await assets.get(asset.id);
    expect(sold.asset).toMatchObject({ status: 'sold' });
    expect(sold.events.at(-1)).toMatchObject({ kind: 'sold', details: expect.objectContaining({ buyerName: 'Musa Ibrahim', priceKobo: '80000000' }) });

    // a sold asset is final, and cannot be sold twice
    await expect(lending.assertRecoveryAllowed('asset_sale', fa.id, { priceKobo: '1' })).rejects.toMatchObject({ code: 'invalid_status' });
    await expect(assets.move(asset.id, 'Somewhere', staffA, null)).rejects.toMatchObject({ code: 'invalid_status' });
    await expect(db.pool.query(`UPDATE asset SET location = 'x' WHERE id = $1`, [asset.id])).rejects.toThrow(/final/);
  });

  it('proceeds above what is owed are recorded as owed back to the borrower', async () => {
    const { fa } = await closedAndInYard();
    const owed = (
      await Promise.all(['fees', 'penalty', 'interest', 'principal'].map((k) => accountBalance(db.pool, `fin:receivable:${k}:${fa.reference}`)))
    ).reduce((a, b) => a + b, 0n);
    const price = owed + 5_000_000n;
    const r = (await approve('asset_sale', fa.id, { priceKobo: price.toString(), buyerName: 'B', buyerPhone: null })).result as { surplusKobo: string };
    expect(r.surplusKobo).toBe('5000000');
    expect(await accountBalance(db.pool, acct.surplus(fa.reference))).toBe(-5_000_000n);
    expect(await bookNet(db.pool, 'financing')).toBe(0n);
  });
});

describe('payoff', () => {
  it('a settled account marks the asset paid off; handing over papers completes the title transfer', async () => {
    const { fa, asset } = await handedOver();
    await expect(assets.titleTransferred(asset.id, staffA, 'too early')).rejects.toMatchObject({ code: 'invalid_status' });
    const s0 = await lending.statement(fa.id, '2026-12-01');
    await pay(fa.accountNumber, s0.schedule.reduce((a, i) => a + i.principal + i.interest, 0n));
    await lending.applyCredit(fa.id, 'final', s0.schedule.at(-1)!.dueDate);
    expect(await assetOf(asset.id)).toMatchObject({ status: 'paid_off' });
    await assets.titleTransferred(asset.id, staffA, 'Papers collected by customer');
    expect(await assetOf(asset.id)).toMatchObject({ status: 'title_transferred' });
    expect((await db.pool.query('SELECT status FROM finance_account WHERE id = $1', [fa.id])).rows[0].status).toBe('title_transferred');
  });
});

describe('records cannot be rewritten', () => {
  it('asset history is append-only and a unit’s identity never changes', async () => {
    const a = await bike();
    await expect(db.pool.query(`UPDATE asset_event SET note = 'x' WHERE asset_id = $1`, [a.id])).rejects.toThrow(/cannot be updated/);
    await expect(db.pool.query(`DELETE FROM asset_event WHERE asset_id = $1`, [a.id])).rejects.toThrow(/cannot be deleted/);
    await expect(db.pool.query(`UPDATE asset SET identifier = 'OTHER12345' WHERE id = $1`, [a.id])).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE asset SET cost_kobo = 1 WHERE id = $1`, [a.id])).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`DELETE FROM asset WHERE id = $1`, [a.id])).rejects.toThrow(/cannot be deleted/);
    await assets.writeOff(a.id, staffA, 'registered twice by mistake');
    expect(await assetOf(a.id)).toMatchObject({ status: 'written_off' });
  });
});
