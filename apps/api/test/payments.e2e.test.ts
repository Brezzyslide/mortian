import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { CollectionsService } from '@project/finance';
import { base32Decode, hotp, IdentityService, totpStep } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

const secret = 'e2e-webhook-secret-2';
const collections = new SandboxCollections(secret);
let db: TestDatabase;
let app: INestApplication;
let http: ReturnType<typeof request>;
let financeToken: string;

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_JWT_SECRET: randomBytes(32).toString('base64'),
  AUTH_OTP_PEPPER: randomBytes(32).toString('base64'),
  AUTH_FIELD_KEY: randomBytes(32).toString('base64'),
  COLLECTIONS_WEBHOOK_SECRET: secret,
});

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging: new SandboxMessaging(), collections });
  await app.init();
  http = request(app.getHttpServer());

  const identity = app.get(IdentityService);
  await identity.createStaffMember({
    email: 'fin@example.com',
    fullName: 'Finance',
    password: 'finance-pass-12345',
    roles: ['finance'],
    grantedBy: null,
  });
  const s1 = await http.post('/v1/auth/staff/login').send({ email: 'fin@example.com', password: 'finance-pass-12345' });
  const s2 = await http
    .post('/v1/auth/staff/mfa')
    .send({ challengeId: s1.body.challengeId, code: hotp(base32Decode(s1.body.enrolment.secret), totpStep(new Date())) });
  financeToken = s2.body.accessToken;
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});

async function account() {
  const svc = app.get(CollectionsService);
  const { rows } = await db.pool.query(
    `INSERT INTO person (phone) VALUES ('+23480' || lpad((floor(random() * 1e8))::text, 8, '0')) RETURNING id`,
  );
  const fa = await svc.openAccount(rows[0].id, 'motorcycle_ride_to_own');
  await db.pool.query(`UPDATE finance_account SET status = 'active' WHERE id = $1`, [fa.id]);
  const va = await svc.provisionVirtualAccount(fa.id, 'Rider');
  return { ...fa, accountNumber: va.accountNumber };
}

function send(body: Buffer, headers: Record<string, string>) {
  let req = http.post('/v1/webhooks/collections/sandbox');
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  return req.send(body.toString());
}

describe('collections webhook endpoint', () => {
  it('accepts a signed payment, and a redelivery is acknowledged as a duplicate', async () => {
    const fa = await account();
    const { body, headers } = collections.buildWebhook({
      reference: 'HTTP-1',
      accountNumber: fa.accountNumber,
      amountKobo: '1500000',
      paidAt: '2026-11-23T08:00:00Z',
    });
    expect((await send(body, headers).expect(200)).body).toEqual({ received: true, outcome: 'posted' });
    expect((await send(body, headers).expect(200)).body).toEqual({ received: true, outcome: 'duplicate' });
    expect(await app.get(CollectionsService).suspenseBalance(fa.reference)).toBe(1500000n);
  });

  it('verifies the signature over the exact raw bytes: re-serialised JSON fails', async () => {
    const fa = await account();
    const { body, headers } = collections.buildWebhook({
      reference: 'HTTP-2',
      accountNumber: fa.accountNumber,
      amountKobo: '100',
      paidAt: '2026-11-23T08:00:00Z',
    });
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    await send(reformatted, headers).expect(401);
  });

  it('rejects an unsigned request and an unknown provider path', async () => {
    await http.post('/v1/webhooks/collections/sandbox').set('content-type', 'application/json').send('{}').expect(401);
    await http.post('/v1/webhooks/collections/paystack').set('content-type', 'application/json').send('{}').expect(404);
  });
});

describe('finance exceptions and sandbox simulator', () => {
  it('a simulated payment to an unknown account appears in exceptions and can be assigned', async () => {
    const fa = await account();
    const auth = { Authorization: `Bearer ${financeToken}` };

    const sim = await http
      .post('/v1/admin/payments/sandbox/simulate')
      .set(auth)
      .send({ accountNumber: '9900000001', amountKobo: '25000' })
      .expect(200);
    expect(sim.body.outcome).toBe('unmatched');

    const ex = await http.get('/v1/admin/payments/exceptions').set(auth).expect(200);
    const item = ex.body.items.find((i: { eventId: string }) => i.eventId === sim.body.eventId);
    expect(item).toMatchObject({ amount: '25000', problem: 'unknown_account_number' });

    await http
      .post(`/v1/admin/payments/exceptions/${sim.body.eventId}/assign`)
      .set(auth)
      .send({ financeAccountReference: fa.reference, note: 'Customer sent receipt' })
      .expect(200);
    expect(await app.get(CollectionsService).suspenseBalance(fa.reference)).toBe(25000n);
  });

  it('exceptions are finance-only', async () => {
    await http.get('/v1/admin/payments/exceptions').expect(401);
  });
});
