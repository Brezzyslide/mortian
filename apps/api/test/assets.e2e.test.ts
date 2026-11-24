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
  REQUIRE_SIGNED_CONTRACT: 'false', // these suites cover lending, not signing (see contracts.e2e)
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-assets-secret-1',
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
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});


const BIKE = { kind: 'motorcycle', make: 'Bajaj', model: 'Boxer BM150', year: 2026, idKind: 'chassis', identifier: 'md2a12bz 7lc 000111', plateNumber: 'KUJ-123-AB', costKobo: '120000000', location: 'Mararaba yard' };

describe('asset register over HTTP', () => {
  let bikeId: string;
  let reference: string;

  it('operations register stock; finance cannot; bad input is refused with reasons', async () => {
    await http.post('/v1/admin/assets').set(bearer('fin')).send(BIKE).expect(403);
    const r = await http.post('/v1/admin/assets').set(bearer('ops')).send(BIKE).expect(201);
    bikeId = r.body.id;
    expect(r.body).toMatchObject({ identifier: 'MD2A12BZ7LC000111', plateNumber: 'KUJ123AB', status: 'in_stock', costKobo: '120000000' });
    const dup = await http.post('/v1/admin/assets').set(bearer('ops')).send({ ...BIKE, plateNumber: null }).expect(409);
    expect(dup.body.error).toBe('duplicate');
    const imei = await http.post('/v1/admin/assets').set(bearer('ops')).send({ kind: 'phone', make: 'Tecno', model: 'Spark', idKind: 'imei', identifier: '490154203237519', costKobo: '1', location: 'Branch' }).expect(400);
    expect(imei.body.error).toBe('invalid_identifier');
    await http.post('/v1/admin/assets').set(bearer('ops')).send({ ...BIKE, costKobo: '-1' }).expect(400);
    await http.get('/v1/admin/assets/not-a-uuid').set(bearer('ops')).expect(400);
  });

  it('staff find a unit by part of its chassis, plate or account reference', async () => {
    expect((await http.get('/v1/admin/assets?q=7lc-000').set(bearer('col')).expect(200)).body.assets).toHaveLength(1);
    expect((await http.get('/v1/admin/assets?q=kuj 123').set(bearer('uw')).expect(200)).body.assets).toHaveLength(1);
    expect((await http.get('/v1/admin/assets?status=sold').set(bearer('uw')).expect(200)).body.assets).toHaveLength(0);
    await http.get('/v1/admin/assets?status=lost').set(bearer('uw')).expect(400);
    await http.get('/v1/admin/assets').set(bearer('rider')).expect(403);
  });

  it('a bike is assigned to an approved account and handed over with it', async () => {
    await http.post('/v1/admin/lending/tiers/seed-placeholders').set(bearer('root')).expect(200);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(bearer('root')).send({ live: true }).expect(200);
    await http.post('/v1/me/profile').set(bearer('rider')).send({ fullName: 'Bola Rider' }).expect(200);
    const a = await http.post('/v1/me/applications').set(bearer('rider')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    reference = a.body.reference;
    const early = await http.post(`/v1/admin/assets/${bikeId}/assign`).set(bearer('uw')).send({ reference }).expect(409);
    expect(early.body.error).toBe('invalid_status');
    await http.post(`/v1/admin/lending/accounts/${reference}/approve`).set(bearer('uw')).send({ tier: 'B', assetPriceKobo: '150000000' }).expect(200);
    await http.post(`/v1/admin/assets/${bikeId}/assign`).set(bearer('fin')).send({ reference }).expect(403);
    await http.post(`/v1/admin/assets/${bikeId}/assign`).set(bearer('uw')).send({ reference }).expect(204);
    expect((await http.get(`/v1/admin/lending/accounts/${reference}/asset`).set(bearer('col')).expect(200)).body.asset).toMatchObject({ id: bikeId, status: 'assigned', reference });

    const { body: webhook, headers } = new SandboxCollections(config.COLLECTIONS_WEBHOOK_SECRET).buildWebhook({
      reference: 'E2E-ASSET-DEP', accountNumber: a.body.repaymentAccount.accountNumber, amountKobo: '30000000', paidAt: new Date().toISOString(),
    });
    let hook = http.post('/v1/webhooks/collections/sandbox');
    for (const [k, v] of Object.entries(headers)) hook = hook.set(k, v);
    await hook.send(webhook.toString()).expect(200);
    await http.post(`/v1/admin/lending/accounts/${reference}/activate`).set(bearer('mgr')).send({}).expect(200);
    const detail = await http.get(`/v1/admin/assets/${bikeId}`).set(bearer('ops')).expect(200);
    expect(detail.body.asset.status).toBe('with_customer');
    expect(detail.body.events.map((e: { kind: string }) => e.kind)).toEqual(['registered', 'assigned', 'handed_over']);
  });

  it('assets with a customer cannot be written off, moved out of history, or sold', async () => {
    const off = await http.post(`/v1/admin/assets/${bikeId}/write-off`).set(bearer('mgr')).send({ note: 'customer says it was stolen' }).expect(409);
    expect(off.body.error).toBe('invalid_status');
    await http.post(`/v1/admin/assets/${bikeId}/write-off`).set(bearer('ops')).send({ note: 'customer says it was stolen' }).expect(403);
    const sale = await http
      .post(`/v1/admin/lending/accounts/${reference}/asset-sale-requests`)
      .set(bearer('col'))
      .send({ priceKobo: '80000000', buyerName: 'Musa Ibrahim', reason: 'offer received' })
      .expect(409);
    expect(sale.body.error).toBe('invalid_status');
    await http.post(`/v1/admin/assets/${bikeId}/title-transferred`).set(bearer('mgr')).send({ note: 'papers handed over' }).expect(409);
    await http.post(`/v1/admin/assets/${bikeId}/move`).set(bearer('ops')).send({ location: 'Workshop' }).expect(204);
  });
});
