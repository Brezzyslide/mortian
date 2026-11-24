import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCheckout, SandboxCollections, SandboxMessaging } from '@project/adapters';
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
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-dispatch-secret-1',
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


const MARARABA = { lat: 9.0333, lng: 7.5833, address: 'Mararaba main market' };
const KARU = { lat: 9.0167, lng: 7.5667, address: 'Karu site, plot 12' };
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('licence photo')]);

describe('dispatch over HTTP', () => {
  let ref: string;
  let pickupCode: string;
  let deliveryCode: string;

  it('is closed until switched live and priced', async () => {
    const closed = await http.post('/v1/me/dispatch/quotes').set(bearer('sender')).send({ pickup: MARARABA, dropoff: KARU }).expect(503);
    expect(closed.body.error).toBe('not_live');
    await http.post('/v1/admin/lending/products/dispatch/live').set(bearer('root')).send({ live: true }).expect(200);
    expect((await http.post('/v1/me/dispatch/quotes').set(bearer('sender')).send({ pickup: MARARABA, dropoff: KARU }).expect(503)).body.error).toBe('no_pricing');
    await http.post('/v1/admin/dispatch/pricing/seed-placeholder').set(bearer('mgr')).expect(403);
    await http.post('/v1/admin/dispatch/pricing/seed-placeholder').set(bearer('root')).expect(201);
    expect((await http.get('/v1/admin/dispatch/pricing').set(bearer('ops')).expect(200)).body.pricing).toMatchObject({ commissionBps: 2000, isPlaceholder: true });
  });

  it('a customer books and pays in the app; the signed payment webhook releases the job', async () => {
    const q = await http.post('/v1/me/dispatch/quotes').set(bearer('sender')).send({ pickup: MARARABA, dropoff: KARU }).expect(201);
    await http.post('/v1/me/dispatch/quotes').set(bearer('uw')).send({ pickup: MARARABA, dropoff: KARU }).expect(403);
    const b = await http
      .post('/v1/me/dispatch/jobs')
      .set(bearer('sender'))
      .send({ quoteId: q.body.quoteId, paymentMethod: 'in_app', recipientName: 'Ada Recipient', recipientPhone: '0803 555 0101', packageNote: 'Documents in an envelope' })
      .expect(201);
    ref = b.body.reference;
    expect(b.body).toMatchObject({ status: 'awaiting_payment', fareKobo: q.body.fareKobo, payUrl: expect.stringContaining(ref) });
    pickupCode = b.body.pickupCode;
    deliveryCode = b.body.deliveryCode;
    await http.get(`/v1/me/dispatch/jobs/${ref}`).set(bearer('other')).expect(404);

    const hook = new SandboxCheckout(config.COLLECTIONS_WEBHOOK_SECRET).buildWebhook({ reference: ref, amountKobo: q.body.fareKobo, paidAt: new Date().toISOString(), eventId: 'evt-http-1' });
    const send = () => {
      let r = http.post('/v1/webhooks/checkout/sandbox');
      for (const [k, v] of Object.entries(hook.headers)) r = r.set(k, v);
      return r.send(hook.body.toString());
    };
    expect((await send().expect(200)).body).toEqual({ received: true, outcome: 'paid' });
    expect((await send().expect(200)).body).toEqual({ received: true, outcome: 'duplicate' });
    let forged = http.post('/v1/webhooks/checkout/sandbox');
    for (const [k, v] of Object.entries(hook.headers)) forged = forged.set(k, v);
    await forged.send(hook.body.toString().replace('evt-http-1', 'evt-http-2')).expect(401);
    expect((await http.get(`/v1/me/dispatch/jobs/${ref}`).set(bearer('sender')).expect(200)).body.status).toBe('searching');
  });

  it('a rider is activated only after their licence is accepted, then takes, picks up and delivers the job', async () => {
    await http.get('/v1/rider/jobs/available').set(bearer('rider')).expect(404);
    await http.post('/v1/me/rider').set(bearer('rider')).send({ kind: 'own_bike' }).expect(201);
    const pending = await http.get('/v1/admin/dispatch/riders?status=pending').set(bearer('ops')).expect(200);
    const me = pending.body.riders[0];
    expect(me).toMatchObject({ status: 'pending', licenceAccepted: false });
    expect((await http.post(`/v1/admin/dispatch/riders/${me.personId}/decision`).set(bearer('ops')).send({ decision: 'active', note: 'looks fine' }).expect(409)).body.error).toBe('licence_not_accepted');

    const doc = await http.post('/v1/me/documents?kind=drivers_licence').set(bearer('rider')).set('content-type', 'image/jpeg').send(jpeg).expect(201);
    await http.post(`/v1/admin/documents/${doc.body.id}/review`).set(bearer('uw')).send({ decision: 'accepted' }).expect(200);
    await http.post(`/v1/admin/dispatch/riders/${me.personId}/decision`).set(bearer('fin')).send({ decision: 'active', note: 'looks fine' }).expect(403);
    await http.post(`/v1/admin/dispatch/riders/${me.personId}/decision`).set(bearer('ops')).send({ decision: 'active', note: 'Licence checked' }).expect(204);

    await http.post('/v1/rider/online').set(bearer('rider')).send({ online: true, lat: 9.035, lng: 7.585 }).expect(204);
    const avail = await http.get('/v1/rider/jobs/available').set(bearer('rider')).expect(200);
    const seen = avail.body.jobs.find((j: { reference: string }) => j.reference === ref);
    expect(seen).toMatchObject({ paymentMethod: 'in_app', pickupAddress: MARARABA.address });
    expect(seen).not.toHaveProperty('recipientPhone');

    await http.post(`/v1/rider/jobs/${ref}/accept`).set(bearer('rider')).expect(200);
    const current = await http.get('/v1/rider/jobs/current').set(bearer('rider')).expect(200);
    expect(current.body.job).toMatchObject({ reference: ref, status: 'accepted', recipientPhone: null, packageNote: 'Documents in an envelope' });

    const wrong = await http.post(`/v1/rider/jobs/${ref}/pickup`).set(bearer('rider')).send({ code: '000000', lat: MARARABA.lat, lng: MARARABA.lng }).expect(422);
    expect(wrong.body.error).toBe('code_invalid');
    await http.post(`/v1/rider/jobs/${ref}/pickup`).set(bearer('rider')).send({ code: pickupCode, lat: MARARABA.lat, lng: MARARABA.lng }).expect(200);
    expect(messaging.sent.find((m) => m.templateId === 'dispatch_delivery_code')).toMatchObject({ to: '+2348035550101', vars: { code: deliveryCode } });
    const done = await http.post(`/v1/rider/jobs/${ref}/deliver`).set(bearer('rider')).send({ code: deliveryCode, lat: KARU.lat, lng: KARU.lng }).expect(200);
    expect(done.body).toMatchObject({ status: 'delivered', collectCashKobo: '0', flaggedFarFromDropoff: false });

    const e = await http.get('/v1/rider/earnings').set(bearer('rider')).expect(200);
    expect(e.body.balanceKobo).toBe(done.body.earningKobo);
    expect(e.body.entries[0]).toMatchObject({ side: 'credit', amountKobo: done.body.earningKobo });
  });

  it('operations see every job and its history; the customer cannot cancel a delivered job', async () => {
    const list = await http.get('/v1/admin/dispatch/jobs?status=delivered').set(bearer('ops')).expect(200);
    expect(list.body.jobs.map((j: { reference: string }) => j.reference)).toContain(ref);
    const ev = await http.get(`/v1/admin/dispatch/jobs/${ref}/events`).set(bearer('fin')).expect(200);
    expect(ev.body.events.map((x: { kind: string }) => x.kind)).toEqual(['booked', 'paid', 'accepted', 'picked_up', 'delivered']);
    await http.get('/v1/admin/dispatch/jobs').set(bearer('rider')).expect(403);
    expect((await http.post(`/v1/me/dispatch/jobs/${ref}/cancel`).set(bearer('sender')).send({ reason: 'too late' }).expect(409)).body.error).toBe('invalid_status');
  });
});
