import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCollections, SandboxMessaging, SandboxPayouts } from '@project/adapters';
import { dsp } from '@project/dispatch';
import { kobo } from '@project/domain';
import { postEntry } from '@project/ledger';
import { PAYOUTS } from '../src/infra.module.js';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, IdentityService, totpStep, type STAFF_ROLES } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

const messaging = new SandboxMessaging();
let db: TestDatabase;
let app: INestApplication;
let http: ReturnType<typeof request>;
const tokens: Record<string, string> = {};

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_JWT_SECRET: randomBytes(32).toString('base64'),
  AUTH_OTP_PEPPER: randomBytes(32).toString('base64'),
  AUTH_FIELD_KEY: randomBytes(32).toString('base64'),
  REQUIRE_SIGNED_CONTRACT: 'false', // these suites cover lending, not signing (see contracts.e2e)
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-payouts-secret-1',
});

const bearer = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

async function staff(name: string, roles: (typeof STAFF_ROLES)[number][]) {
  const email = `${name}@example.com`;
  const password = `${name}-password-123`;
  await app.get(IdentityService).createStaffMember({ email, fullName: name, password, roles, grantedBy: null });
  const s1 = await http.post('/v1/auth/staff/login').send({ email, password });
  const s2 = await http
    .post('/v1/auth/staff/mfa')
    .send({ challengeId: s1.body.challengeId, code: hotp(base32Decode(s1.body.enrolment.secret), totpStep(new Date())) });
  tokens[name] = s2.body.accessToken;
}

async function customer(name: string, local: string) {
  const r1 = await http.post('/v1/auth/otp/request').send({ phone: local });
  const code = messaging.lastTo(`+234${local.slice(1)}`)!.vars['code'];
  const r2 = await http.post('/v1/auth/otp/verify').send({ challengeId: r1.body.challengeId, code });
  tokens[name] = r2.body.accessToken;
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging, collections: new SandboxCollections(config.COLLECTIONS_WEBHOOK_SECRET) });
  await app.init();
  http = request(app.getHttpServer());
  await staff('root', ['super_admin']);
  await staff('uw', ['underwriter']);
  await staff('mgr', ['manager']);
  await staff('fin', ['finance']);
  await staff('ops', ['dispatch_ops']);
  await staff('col', ['collections']);
  await customer('rider', '08061234567');
  await customer('other', '08067654321');
  await customer('sender', '08069990001');
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});


const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('licence photo')]);

describe('rider payouts over HTTP', () => {
  let riderRef: string;
  let payoutRef: string;

  it('setup: an active rider with ₦20,000 earned, and payout rules seeded', async () => {
    await http.post('/v1/me/profile').set(bearer('rider')).send({ fullName: 'Bola Rider' }).expect(200);
    await http.post('/v1/me/rider').set(bearer('rider')).send({ kind: 'own_bike' }).expect(201);
    const doc = await http.post('/v1/me/documents?kind=drivers_licence').set(bearer('rider')).set('content-type', 'image/jpeg').send(jpeg).expect(201);
    await http.post(`/v1/admin/documents/${doc.body.id}/review`).set(bearer('uw')).send({ decision: 'accepted' }).expect(200);
    const pending = await http.get('/v1/admin/dispatch/riders?status=pending').set(bearer('ops')).expect(200);
    await http.post(`/v1/admin/dispatch/riders/${pending.body.riders[0].personId}/decision`).set(bearer('ops')).send({ decision: 'active', note: 'licence checked' }).expect(204);
    riderRef = (await http.get('/v1/me/rider').set(bearer('rider')).expect(200)).body.reference;
    await postEntry(db.pool, {
      idempotencyKey: `e2e-earn:${riderRef}`, source: 'system', actorId: 'test', occurredAt: new Date(), description: 'deliveries',
      lines: [{ account: dsp.prepaid('DJ-E2E'), side: 'debit', amount: kobo(2_000_000n) }, { account: dsp.rider(riderRef), side: 'credit', amount: kobo(2_000_000n) }],
    });
    expect((await http.get('/v1/rider/payouts').set(bearer('rider')).expect(200)).body.settings).toBeNull();
    await http.post('/v1/admin/payouts/settings/seed-placeholder').set(bearer('fin')).expect(403);
    await http.post('/v1/admin/payouts/settings/seed-placeholder').set(bearer('root')).expect(201);
  });

  it('the rider links a bank account in their own name and withdraws, paying the transfer fee', async () => {
    const banks = await http.get('/v1/rider/banks').set(bearer('rider')).expect(200);
    expect(banks.body.banks[0]).toMatchObject({ code: '999' });
    const provider = app.get(PAYOUTS) as SandboxPayouts;
    provider.openAccount('999', '0123456789', 'RIDER BOLA');
    const bad = await http.post('/v1/rider/bank-account').set(bearer('rider')).send({ bankCode: '999', accountNumber: '9999999999' }).expect(422);
    expect(bad.body.error).toBe('account_not_found');
    const a = await http.post('/v1/rider/bank-account').set(bearer('rider')).send({ bankCode: '999', accountNumber: '0123456789' }).expect(200);
    expect(a.body).toMatchObject({ nameCheck: 'matched', ready: true, accountNumberMasked: '******6789' });
    expect(a.body).not.toHaveProperty('accountNumber');

    const s = await http.get('/v1/rider/payouts').set(bearer('rider')).expect(200);
    expect(s.body).toMatchObject({ availableKobo: '2000000', instantFeeForAllKobo: '7500', canSetLoanShare: false });
    const w = await http.post('/v1/rider/payouts').set(bearer('rider')).send({}).expect(201);
    payoutRef = w.body.payouts[0].reference;
    expect(w.body.payouts[0]).toMatchObject({ kind: 'earnings', netKobo: '1992500', status: 'sent' });
    expect((await http.post('/v1/rider/payouts').set(bearer('rider')).send({ amountKobo: '100000' }).expect(409)).body.error).toBe('insufficient_balance');
    expect((await http.post('/v1/rider/loan-share').set(bearer('rider')).send({ bps: 1000 }).expect(409)).body.error).toBe('loan_share_not_allowed');
  });

  it('the provider’s signed webhook completes it; finance sees every payout', async () => {
    const provider = app.get(PAYOUTS) as SandboxPayouts;
    const hook = provider.buildWebhook({ reference: payoutRef, status: 'succeeded', eventId: 'evt-po-1' });
    const send = (body: string) => {
      let r = http.post('/v1/webhooks/payouts/sandbox');
      for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
      return r.send(body);
    };
    expect((await send(hook.body.toString()).expect(200)).body).toEqual({ received: true, outcome: 'succeeded' });
    expect((await send(hook.body.toString()).expect(200)).body).toEqual({ received: true, outcome: 'duplicate' });
    await send(hook.body.toString().replace('succeeded', 'failed')).expect(401);
    const list = await http.get('/v1/admin/payouts?status=succeeded').set(bearer('fin')).expect(200);
    expect(list.body.payouts[0]).toMatchObject({ reference: payoutRef, riderReference: riderRef, destination: '******6789', providerFeeKobo: '7500' }) // ₦25 + ₦50 stamp duty on ₦19,925;
    await http.get('/v1/admin/payouts').set(bearer('rider')).expect(403);
    await http.get('/v1/admin/payouts').set(bearer('ops')).expect(403);
  });

  it('an account in someone else’s name waits for finance, and a change texts the rider', async () => {
    const provider = app.get(PAYOUTS) as SandboxPayouts;
    provider.openAccount('998', '5555555555', 'MUSA IBRAHIM');
    const a = await http.post('/v1/rider/bank-account').set(bearer('rider')).send({ bankCode: '998', accountNumber: '5555555555' }).expect(200);
    expect(a.body).toMatchObject({ nameCheck: 'needs_review', ready: false });
    expect(messaging.sent.find((m) => m.templateId === 'payout_account_changed')).toMatchObject({ vars: { last4: '5555' } });
    const q = await http.get('/v1/admin/payouts/bank-accounts/review').set(bearer('fin')).expect(200);
    expect(q.body.accounts[0]).toMatchObject({ verifiedName: 'Bola Rider', accountName: 'MUSA IBRAHIM' });
    await http.post(`/v1/admin/payouts/bank-accounts/${q.body.accounts[0].id}/review`).set(bearer('fin')).send({ decision: 'rejected', note: 'Not the rider’s own account' }).expect(204);
    expect((await http.get('/v1/rider/payouts').set(bearer('rider')).expect(200)).body.bankAccount).toMatchObject({ nameCheck: 'rejected', reviewNote: 'Not the rider’s own account' });
  });
});
