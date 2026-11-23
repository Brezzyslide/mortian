import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
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
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-lending-secret-1',
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
  await customer('rider', '08061234567');
  await customer('other', '08067654321');
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});

describe('motorcycle ride-to-own over HTTP', () => {
  let reference: string;
  let accountNumber: string;

  it('refuses applications while the product is not live', async () => {
    await http
      .post('/v1/me/applications')
      .set(bearer('rider'))
      .send({ productCode: 'motorcycle_ride_to_own' })
      .expect(403);
  });

  it('super admin seeds placeholder tiers and switches the product live', async () => {
    const seed = await http.post('/v1/admin/lending/tiers/seed-placeholders').set(bearer('root')).expect(200);
    expect(seed.body.created).toEqual(['A', 'B', 'C']);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(bearer('mgr')).send({ live: true }).expect(403);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(bearer('root')).send({ live: true }).expect(200);
  });

  it('rider applies and gets a repayment account', async () => {
    const r = await http.post('/v1/me/applications').set(bearer('rider')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    reference = r.body.reference;
    accountNumber = r.body.repaymentAccount.accountNumber;
    expect(accountNumber).toMatch(/^99\d{8}$/);
  });

  it('the underwriting queue lists the new application; managers see product switches', async () => {
    const q = await http.get('/v1/admin/lending/accounts?status=applied').set(bearer('uw')).expect(200);
    expect(q.body.accounts.map((a: { reference: string }) => a.reference)).toContain(reference);
    await http.get('/v1/admin/lending/accounts?status=bogus').set(bearer('uw')).expect(400);
    const p = await http.get('/v1/admin/lending/products').set(bearer('mgr')).expect(200);
    expect(p.body.products.find((x: { productCode: string }) => x.productCode === 'motorcycle_ride_to_own').live).toBe(true);
  });

  it('only underwriters approve; approval within bounds is immediate', async () => {
    const body = { tier: 'B', assetPriceKobo: '150000000' };
    await http.post(`/v1/admin/lending/accounts/${reference}/approve`).set(bearer('fin')).send(body).expect(403);
    const r = await http.post(`/v1/admin/lending/accounts/${reference}/approve`).set(bearer('uw')).send(body).expect(200);
    expect(r.body.status).toBe('approved');
    expect(r.body.terms.depositBps).toBe(2000);
  });

  it('activation waits for the deposit, then succeeds', async () => {
    await http.post(`/v1/admin/lending/accounts/${reference}/activate`).set(bearer('mgr')).send({}).expect(409);
    await http
      .post('/v1/admin/payments/sandbox/simulate')
      .set(bearer('fin'))
      .send({ accountNumber, amountKobo: '30000000' })
      .expect(200);
    const r = await http.post(`/v1/admin/lending/accounts/${reference}/activate`).set(bearer('mgr')).send({}).expect(200);
    expect(r.body).toMatchObject({ instalments: 52, deposit: '30000000', financed: '120000000' });
  });

  it('rider sees their statement as integer-kobo strings; another customer gets 404', async () => {
    const s = await http.get(`/v1/me/accounts/${reference}`).set(bearer('rider')).expect(200);
    expect(s.body).toMatchObject({
      status: 'active',
      isPlaceholderTerms: true,
      outstanding: { principal: '120000000' },
      missed: { instalments: 0, amount: '0' },
      repaymentAccount: { accountNumber },
    });
    expect(s.body.schedule).toHaveLength(52);
    await http.get(`/v1/me/accounts/${reference}`).set(bearer('other')).expect(404);
    const list = await http.get('/v1/me/accounts').set(bearer('rider')).expect(200);
    expect(list.body.accounts[0].reference).toBe(reference);
  });
});

describe('two-person approval over HTTP', () => {
  it('out-of-bounds terms go to a manager; the underwriter cannot confirm their own', async () => {
    const app1 = await http.post('/v1/me/applications').set(bearer('other')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    const ref = app1.body.reference;
    const body = { tier: 'B', assetPriceKobo: '150000000', adjustments: { tenorPeriods: 90 } };

    await http.post(`/v1/admin/lending/accounts/${ref}/approve`).set(bearer('uw')).send(body).expect(400);
    const p = await http
      .post(`/v1/admin/lending/accounts/${ref}/approve`)
      .set(bearer('uw'))
      .send({ ...body, reason: 'Verified long-term rider income' })
      .expect(200);
    expect(p.body.status).toBe('pending_second_approval');

    const pending = await http.get('/v1/admin/lending/approvals').set(bearer('mgr')).expect(200);
    expect(pending.body.pending.map((x: { id: string }) => x.id)).toContain(p.body.requestId);

    const d = await http
      .post(`/v1/admin/lending/approvals/${p.body.requestId}/decide`)
      .set(bearer('mgr'))
      .send({ decision: 'approved', note: 'Income documents checked' })
      .expect(200);
    expect(d.body.result.outOfBounds).toEqual(['tenorPeriods']);
  });
});
