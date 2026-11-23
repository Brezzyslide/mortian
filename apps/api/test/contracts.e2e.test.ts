import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { MemoryDocumentStore, SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, IdentityService, totpStep, type STAFF_ROLES } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

const messaging = new SandboxMessaging();
const documents = new MemoryDocumentStore();
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
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-contracts-secret',
  SIGNING_BASE_URL: 'https://app.test/sign/',
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

const linkFor = (to: string) =>
  [...messaging.sent].reverse().find((m) => m.to === to && m.templateId === 'contract_sign_link')!.vars['url']!.split('#')[1]!;
const otpFor = (to: string) => [...messaging.sent].reverse().find((m) => m.to === to && m.templateId === 'contract_sign_otp')!.vars['code']!;

async function signOverHttp(to: string, deviceId: string) {
  const token = linkFor(to);
  const v = (await http.post('/v1/sign/view').send({ token }).expect(200)).body;
  await http.post('/v1/sign/otp').send({ token }).expect(200);
  await http.post('/v1/sign/verify').send({ token, code: otpFor(to) }).expect(204);
  return http.post('/v1/sign/complete').send({
    token,
    documentSha256: v.documentSha256,
    acknowledged: v.keyTerms.map((t: { key: string }) => t.key),
    typedName: v.signerName,
    intentToSign: true,
    deviceId,
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging, documents, collections: new SandboxCollections('e2e-contracts-secret') });
  await app.init();
  http = request(app.getHttpServer());
  for (const [n, r] of [['root', ['super_admin']], ['uw', ['underwriter']], ['mgr', ['manager']], ['fin', ['finance']]] as const) await staff(n, [...r]);
  const r1 = await http.post('/v1/auth/otp/request').send({ phone: '08091112222' });
  const code = messaging.lastTo('+2348091112222')!.vars['code'];
  tokens['rider'] = (await http.post('/v1/auth/otp/verify').send({ challengeId: r1.body.challengeId, code })).body.accessToken;
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});

describe('contract signing over HTTP, application to handover', () => {
  let ref: string;
  let acct: string;
  let contractId: string;

  it('sets up an approved application with a guarantor', async () => {
    await http.post('/v1/admin/lending/tiers/seed-placeholders').set(as('root')).expect(200);
    await http.post('/v1/admin/contracts/seed-placeholder-template').set(as('root')).expect(200);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(as('root')).send({ live: true }).expect(200);
    const a = await http.post('/v1/me/applications').set(as('rider')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    ref = a.body.reference;
    acct = a.body.repaymentAccount.accountNumber;
    await http.post(`/v1/admin/lending/accounts/${ref}/approve`).set(as('uw')).send({ tier: 'B', assetPriceKobo: '150000000' }).expect(200);
    await http.post(`/v1/admin/contracts/accounts/${ref}/issue`).set(as('uw')).expect(400); // guarantor missing
    await http
      .post(`/v1/admin/contracts/accounts/${ref}/guarantors`)
      .set(as('uw'))
      .send({ fullName: 'Gbenga G', phone: '08093334444', relationship: 'uncle' })
      .expect(201);
  });

  it('handover is refused before the contract is signed, even with the deposit paid', async () => {
    await http.post('/v1/admin/payments/sandbox/simulate').set(as('fin')).send({ accountNumber: acct, amountKobo: '30000000' }).expect(200);
    const r = await http.post(`/v1/admin/lending/accounts/${ref}/activate`).set(as('mgr')).send({}).expect(409);
    expect(r.body.message).toMatch(/fully signed/);
  });

  it('borrower and guarantor sign on their own phones; the manager countersigns', async () => {
    contractId = (await http.post(`/v1/admin/contracts/accounts/${ref}/issue`).set(as('uw')).expect(201)).body.contractId;
    expect((await signOverHttp('+2348091112222', 'device-borrower-0001')).status).toBe(200);
    const same = await signOverHttp('+2348093334444', 'device-borrower-0001');
    expect(same.status).toBe(403);
    expect(same.body.error).toBe('same_device_as_borrower');
    expect((await signOverHttp('+2348093334444', 'device-guarantor-0001')).status).toBe(200);

    await http.post(`/v1/admin/contracts/${contractId}/countersign`).set(as('uw')).expect(403); // underwriter is not a manager
    const done = await http.post(`/v1/admin/contracts/${contractId}/countersign`).set(as('mgr')).expect(200);
    expect(done.body.certificateSha256).toMatch(/^[0-9a-f]{64}$/);

    const list = await http.get(`/v1/admin/contracts/accounts/${ref}`).set(as('mgr')).expect(200);
    expect(list.body.contracts[0]).toMatchObject({ status: 'fully_executed', isPlaceholder: true });
    // Same device is refused; same network (both from localhost here) is only flagged for review.
    expect(list.body.contracts[0].flags).toEqual(expect.arrayContaining(['flag_same_device_as_borrower', 'flag_same_network_as_borrower']));
    const doc = await http.get(`/v1/admin/contracts/${contractId}/archive/agreement`).set(as('mgr')).expect(200);
    expect(doc.text).toContain('HIRE PURCHASE AGREEMENT');
  });

  it('a used link is gone, and handover now succeeds', async () => {
    await http.post('/v1/sign/view').send({ token: linkFor('+2348091112222') }).expect(410);
    const r = await http.post(`/v1/admin/lending/accounts/${ref}/activate`).set(as('mgr')).send({}).expect(200);
    expect(r.body.instalments).toBe(52);
  });

  it('signing endpoints reject malformed tokens without leaking anything', async () => {
    await http.post('/v1/sign/view').send({ token: 'x'.repeat(40) }).expect(410);
    await http.post('/v1/sign/view').send({}).expect(400);
  });
});
