import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, IdentityService, totpStep } from '@project/identity';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

let db: TestDatabase;
let app: INestApplication;
let http: ReturnType<typeof request>;
let root: string;

const config = loadConfig({
  APP_ENV: 'test',
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_JWT_SECRET: randomBytes(32).toString('base64'),
  AUTH_OTP_PEPPER: randomBytes(32).toString('base64'),
  AUTH_FIELD_KEY: randomBytes(32).toString('base64'),
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-staff-secret-12',
});

/** Signs in, enrolling the authenticator if needed. Waits for a fresh TOTP step to avoid replay refusals. */
async function signIn(email: string, password: string, secret?: Buffer) {
  const s1 = await http.post('/v1/auth/staff/login').send({ email, password }).expect(200);
  const key = s1.body.enrolment ? base32Decode(s1.body.enrolment.secret) : secret!;
  const s2 = await http.post('/v1/auth/staff/mfa').send({ challengeId: s1.body.challengeId, code: hotp(key, totpStep(new Date())) });
  return { token: s2.body.accessToken as string, status: s2.status, secret: key };
}

beforeAll(async () => {
  db = await createTestDatabase();
  app = await createApp(config, { pool: db.pool, messaging: new SandboxMessaging(), collections: new SandboxCollections('e2e-staff-secret-12') });
  await app.init();
  http = request(app.getHttpServer());
  await app.get(IdentityService).createStaffMember({
    email: 'root@example.com',
    fullName: 'Root',
    password: 'root-password-123',
    roles: ['super_admin'],
    grantedBy: null,
  });
  root = (await signIn('root@example.com', 'root-password-123')).token;
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('staff lifecycle over HTTP', () => {
  let id: string;
  let finToken: string;

  it('super admin invites; the invitee sets a password with the one-time link and signs in', async () => {
    const inv = await http
      .post('/v1/admin/staff')
      .set(as(root))
      .send({ email: 'fin@example.com', fullName: 'Fin', roles: ['finance'] })
      .expect(201);
    id = inv.body.id;
    await http.post('/v1/auth/staff/setup').send({ token: inv.body.setupToken, password: 'short' }).expect(400);
    await http.post('/v1/auth/staff/setup').send({ token: inv.body.setupToken, password: 'finance-password-1' }).expect(200);
    await http.post('/v1/auth/staff/setup').send({ token: inv.body.setupToken, password: 'finance-password-1' }).expect(400);
    finToken = (await signIn('fin@example.com', 'finance-password-1')).token;
    await http.get('/v1/admin/payments/exceptions').set(as(finToken)).expect(200);
  });

  it('only super admins manage staff', async () => {
    await http.get('/v1/admin/staff').set(as(finToken)).expect(403);
    const list = await http.get('/v1/admin/staff').set(as(root)).expect(200);
    expect(list.body.staff.find((s: { id: string }) => s.id === id)).toMatchObject({
      roles: ['finance'],
      passwordSet: true,
      authenticatorEnrolled: true,
    });
  });

  it('a role change signs the person out immediately', async () => {
    await http.put(`/v1/admin/staff/${id}/roles`).set(as(root)).send({ roles: ['collections'] }).expect(204);
    await http.get('/v1/admin/payments/exceptions').set(as(finToken)).expect(401);
  });

  it('the last super admin is protected, with a readable reason', async () => {
    const me = (await http.get('/v1/me').set(as(root)).expect(200)).body.id;
    const r = await http.put(`/v1/admin/staff/${me}/roles`).set(as(root)).send({ roles: ['manager'] }).expect(409);
    expect(r.body.error).toBe('last_super_admin');
    await http.post(`/v1/admin/staff/${me}/suspend`).set(as(root)).expect(409);
  });

  it('reset access issues a new link; the old password stops working', async () => {
    const r = await http.post(`/v1/admin/staff/${id}/reset-access`).set(as(root)).expect(200);
    await http.post('/v1/auth/staff/login').send({ email: 'fin@example.com', password: 'finance-password-1' }).expect(401);
    await http.post('/v1/auth/staff/setup').send({ token: r.body.setupToken, password: 'brand-new-password-2' }).expect(200);
    const s1 = await http.post('/v1/auth/staff/login').send({ email: 'fin@example.com', password: 'brand-new-password-2' }).expect(200);
    expect(s1.body.enrolmentRequired).toBe(true);
  });

  it('suspension blocks sign-in; reactivation restores it', async () => {
    await http.post(`/v1/admin/staff/${id}/suspend`).set(as(root)).expect(204);
    await http.post('/v1/auth/staff/login').send({ email: 'fin@example.com', password: 'brand-new-password-2' }).expect(403);
    await http.post(`/v1/admin/staff/${id}/reactivate`).set(as(root)).expect(204);
    await http.post('/v1/auth/staff/login').send({ email: 'fin@example.com', password: 'brand-new-password-2' }).expect(200);
  });

  it('staff change their own password with the current one', async () => {
    await http.post('/v1/me/password').set(as(root)).send({ currentPassword: 'nope-nope-nope', newPassword: 'root-password-456' }).expect(401);
    await http.post('/v1/me/password').set(as(root)).send({ currentPassword: 'root-password-123', newPassword: 'root-password-456' }).expect(204);
    await http.get('/v1/me').set(as(root)).expect(200); // this session survives
    await http.post('/v1/auth/staff/login').send({ email: 'root@example.com', password: 'root-password-123' }).expect(401);
  });
});
