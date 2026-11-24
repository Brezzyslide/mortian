import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { addPeriods, lagosDate } from '@project/finance';
import { base32Decode, hotp, IdentityService, totpStep, type STAFF_ROLES } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

const messaging = new SandboxMessaging();
let db: TestDatabase;
let app: INestApplication;
let http: ReturnType<typeof request>;
const tokens: Record<string, string> = {};
const today = lagosDate(new Date());

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_JWT_SECRET: randomBytes(32).toString('base64'),
  AUTH_OTP_PEPPER: randomBytes(32).toString('base64'),
  AUTH_FIELD_KEY: randomBytes(32).toString('base64'),
  REQUIRE_SIGNED_CONTRACT: 'false', // these suites cover lending, not signing (see contracts.e2e)
  REQUIRE_ASSET_AT_HANDOVER: 'false', // asset register covered in assets.e2e
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-arrears-secret-1',
});
const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });

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

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging, collections: new SandboxCollections(config.COLLECTIONS_WEBHOOK_SECRET) });
  await app.init();
  http = request(app.getHttpServer());
  for (const [n, r] of [
    ['root', ['super_admin']],
    ['uw', ['underwriter']],
    ['mgr', ['manager']],
    ['fin', ['finance']],
    ['col', ['collections']],
  ] as const) {
    await staff(n, [...r]);
  }
  const r1 = await http.post('/v1/auth/otp/request').send({ phone: '08071112222' });
  const code = messaging.lastTo('+2348071112222')!.vars['code'];
  tokens['rider'] = (await http.post('/v1/auth/otp/verify').send({ challengeId: r1.body.challengeId, code })).body.accessToken;
  await http.post('/v1/me/profile').set({ Authorization: `Bearer ${tokens['rider']}` }).send({ fullName: 'Bola Rider' }).expect(200);
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});

describe('arrears to repossession to reactivation, over HTTP', () => {
  let ref: string;
  let acct: string;

  it('sets up an active loan that started 25 days ago with nothing paid since the deposit', async () => {
    await http.post('/v1/admin/lending/tiers/seed-placeholders').set(as('root')).expect(200);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(as('root')).send({ live: true }).expect(200);
    const a = await http.post('/v1/me/applications').set(as('rider')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    ref = a.body.reference;
    acct = a.body.repaymentAccount.accountNumber;
    await http.post(`/v1/admin/lending/accounts/${ref}/approve`).set(as('uw')).send({ tier: 'B', assetPriceKobo: '150000000' }).expect(200);
    await http.post('/v1/admin/payments/sandbox/simulate').set(as('fin')).send({ accountNumber: acct, amountKobo: '30000000' }).expect(200);
    await http
      .post(`/v1/admin/lending/accounts/${ref}/activate`)
      .set(as('mgr'))
      .send({ startDate: addPeriods(today, 'daily', -25) })
      .expect(200);
  });

  it('the daily job moves it to repossession review and texts the rider', async () => {
    const r = await http.post('/v1/admin/lending/jobs/daily').set(as('root')).send({}).expect(200);
    expect(r.body.dates).toEqual([today]);
    const sms = messaging.sent.find((m) => m.to === '+2348071112222' && m.templateId === 'arrears_repossession_review');
    const notices = await http.get(`/v1/admin/lending/accounts/${ref}/notices`).set(as('col')).expect(200);
    expect(notices.body.notices).toEqual(expect.arrayContaining([expect.objectContaining({ recipientRole: 'borrower', template: 'arrears_repossession_review' })]));
    await http.get(`/v1/admin/lending/accounts/${ref}/notices`).set(as('rider')).expect(403);
    expect(sms?.vars['missed']).toBe('3');
  });

  it('the rider sees how much they missed, the reactivation amount, the deadline and what to do', async () => {
    const s = await http.get(`/v1/me/accounts/${ref}`).set(as('rider')).expect(200);
    expect(s.body.status).toBe('repossession_review');
    expect(s.body.missed.instalments).toBe(3);
    expect(s.body.arrears.cureDeadline).toBe(addPeriods(today, 'daily', 10));
    expect(BigInt(s.body.arrears.reactivationAmount)).toBeGreaterThan(BigInt(s.body.missed.amount));
    expect(s.body.arrears.steps[0].text).toContain(acct);
  });

  it('collections sees it on the worklist; finance sees the portfolio', async () => {
    const w = await http.get('/v1/admin/lending/arrears').set(as('col')).expect(200);
    expect(w.body.items[0]).toMatchObject({ reference: ref, status: 'repossession_review', missedInstalments: 3 });
    const p = await http.get('/v1/admin/lending/portfolio').set(as('fin')).expect(200);
    expect(p.body.buckets['8-30'].accounts).toBe(1);
    await http.get('/v1/admin/lending/arrears').set(as('rider')).expect(403);
  });

  it('repossession: collections requests, the manager confirms, a duplicate request is refused', async () => {
    const body = { reason: 'Three weeks overdue, no contact', location: 'Mararaba', condition: 'Good', photoRefs: [] };
    const r = await http.post(`/v1/admin/lending/accounts/${ref}/repossession-requests`).set(as('col')).send(body).expect(201);
    await http.post(`/v1/admin/lending/accounts/${ref}/repossession-requests`).set(as('col')).send(body).expect(409);
    await http
      .post(`/v1/admin/lending/approvals/${r.body.requestId}/decide`)
      .set(as('mgr'))
      .send({ decision: 'approved', note: 'Proceed' })
      .expect(200);
    const s = await http.get(`/v1/me/accounts/${ref}`).set(as('rider')).expect(200);
    expect(s.body.status).toBe('repossessed');
    expect(s.body.arrears.steps.map((x: { code: string }) => x.code)).toContain('manager_release');
  });

  it('release is refused until paid, then confirmed by the manager', async () => {
    await http
      .post(`/v1/admin/lending/accounts/${ref}/release-requests`)
      .set(as('col'))
      .send({ reason: 'Rider promises payment' })
      .expect(409);

    const s = await http.get(`/v1/me/accounts/${ref}`).set(as('rider')).expect(200);
    await http
      .post('/v1/admin/payments/sandbox/simulate')
      .set(as('fin'))
      .send({ accountNumber: acct, amountKobo: s.body.arrears.reactivationAmount })
      .expect(200);

    const rel = await http
      .post(`/v1/admin/lending/accounts/${ref}/release-requests`)
      .set(as('col'))
      .send({ reason: 'Reactivation amount received in full' })
      .expect(201);
    await http
      .post(`/v1/admin/lending/approvals/${rel.body.requestId}/decide`)
      .set(as('mgr'))
      .send({ decision: 'approved', note: 'Hand bike back' })
      .expect(200);
    const after = await http.get(`/v1/me/accounts/${ref}`).set(as('rider')).expect(200);
    expect(after.body.status).toBe('active');
    expect(after.body.missed.instalments).toBe(0);
  });
});
