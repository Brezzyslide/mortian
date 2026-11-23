import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, IdentityService, totpStep } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

let db: TestDatabase;
let app: INestApplication;
let http: ReturnType<typeof request>;
const messaging = new SandboxMessaging();

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_JWT_SECRET: randomBytes(32).toString('base64'),
  AUTH_OTP_PEPPER: randomBytes(32).toString('base64'),
  AUTH_FIELD_KEY: randomBytes(32).toString('base64'),
});

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close(); // also ends db.pool via InfraModule shutdown
  await db?.drop().catch(() => undefined);
});

async function customerLogin(local: string) {
  const r1 = await http.post('/v1/auth/otp/request').send({ phone: local }).expect(202);
  const code = messaging.lastTo(`+234${local.slice(1)}`)!.vars['code'];
  const r2 = await http.post('/v1/auth/otp/verify').send({ challengeId: r1.body.challengeId, code }).expect(200);
  return r2.body as { accessToken: string; refreshToken: string; personId: string };
}

async function staffLogin(email: string, password: string) {
  const s1 = await http.post('/v1/auth/staff/login').send({ email, password }).expect(200);
  const secret = base32Decode(s1.body.enrolment.secret);
  const s2 = await http
    .post('/v1/auth/staff/mfa')
    .send({ challengeId: s1.body.challengeId, code: hotp(secret, totpStep(new Date())) })
    .expect(200);
  return s2.body as { accessToken: string };
}

describe('public routes', () => {
  it('health needs no token', async () => {
    await http.get('/v1/health').expect(200);
  });

  it('every other route needs a token', async () => {
    await http.get('/v1/me').expect(401);
    await http.get('/v1/me').set('Authorization', 'Bearer not-a-token').expect(401);
  });
});

describe('customer OTP flow over HTTP', () => {
  it('logs in, reads /me, refreshes, logs out', async () => {
    const t = await customerLogin('08051112222');
    const me = await http.get('/v1/me').set('Authorization', `Bearer ${t.accessToken}`).expect(200);
    expect(me.body).toMatchObject({ kind: 'customer', roles: ['customer'], phone: '+2348051112222' });

    const r = await http.post('/v1/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);
    await http.post('/v1/auth/logout').send({ refreshToken: r.body.refreshToken }).expect(204);

    // access token stops working immediately after logout, not after 15 minutes
    await http.get('/v1/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(401);
  });

  it('validates input and returns field errors', async () => {
    const r = await http.post('/v1/auth/otp/verify').send({ challengeId: 'x', code: '12' }).expect(400);
    expect(r.body.fields.map((f: { path: string }) => f.path).sort()).toEqual(['challengeId', 'code']);
  });

  it('returns 429 when OTP requests exceed the limit', async () => {
    for (let i = 0; i < 3; i++) await http.post('/v1/auth/otp/request').send({ phone: '08059998888' }).expect(202);
    await http.post('/v1/auth/otp/request').send({ phone: '08059998888' }).expect(429);
  });

  it('reports a reused refresh token as a plain invalid session', async () => {
    const t = await customerLogin('08053334444');
    await http.post('/v1/auth/refresh').send({ refreshToken: t.refreshToken }).expect(200);
    const reuse = await http.post('/v1/auth/refresh').send({ refreshToken: t.refreshToken }).expect(401);
    expect(reuse.body).toEqual({ error: 'session_invalid' });
  });
});

describe('staff routes', () => {
  const identity = () => app.get(IdentityService);

  it('a customer cannot reach admin routes', async () => {
    const t = await customerLogin('08057776666');
    await http.get('/v1/admin/audit').set('Authorization', `Bearer ${t.accessToken}`).expect(403);
  });

  it('a staff member without the role is refused; a manager is allowed', async () => {
    await identity().createStaffMember({
      email: 'uw@example.com',
      fullName: 'UW',
      password: 'underwriter-pass-123',
      roles: ['underwriter'],
      grantedBy: null,
    });
    await identity().createStaffMember({
      email: 'mgr@example.com',
      fullName: 'Mgr',
      password: 'manager-pass-1234',
      roles: ['manager'],
      grantedBy: null,
    });
    const uw = await staffLogin('uw@example.com', 'underwriter-pass-123');
    await http.get('/v1/admin/audit').set('Authorization', `Bearer ${uw.accessToken}`).expect(403);

    const mgr = await staffLogin('mgr@example.com', 'manager-pass-1234');
    const audit = await http.get('/v1/admin/audit?limit=5').set('Authorization', `Bearer ${mgr.accessToken}`).expect(200);
    expect(audit.body.events.length).toBeGreaterThan(0);
  });

  it('a wrong password and an unknown email look identical', async () => {
    const a = await http.post('/v1/auth/staff/login').send({ email: 'mgr@example.com', password: 'nope-nope-nope' }).expect(401);
    const b = await http.post('/v1/auth/staff/login').send({ email: 'ghost@example.com', password: 'nope-nope-nope' }).expect(401);
    expect(a.body).toEqual(b.body);
  });
});
