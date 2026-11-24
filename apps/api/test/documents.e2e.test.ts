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
  COLLECTIONS_WEBHOOK_SECRET: 'e2e-docs-secret-1',
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
  await staff('col', ['collections']);
  await customer('rider', '08061234567');
  await customer('other', '08067654321');
});
afterAll(async () => {
  await app?.close();
  await db?.drop().catch(() => undefined);
});


const jpeg = (tag: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo ${tag}`)]);

describe('customer documents over HTTP', () => {
  let docId: string;

  it('a customer uploads a photo of their ID as the raw request body', async () => {
    const r = await http.post('/v1/me/documents?kind=national_id').set(bearer('rider')).set('content-type', 'image/jpeg').send(jpeg('nin')).expect(201);
    docId = r.body.id;
    expect(r.body).toMatchObject({ kind: 'national_id', contentType: 'image/jpeg', status: 'submitted' });
    expect(r.body).not.toHaveProperty('storageKey');
    const mine = await http.get('/v1/me/documents').set(bearer('rider')).expect(200);
    expect(mine.body.documents.map((d: { id: string }) => d.id)).toEqual([docId]);
    expect((await http.get('/v1/me/documents').set(bearer('other')).expect(200)).body.documents).toEqual([]);
  });

  it('refuses the wrong kind, the wrong type, disguised files, oversized files and staff sessions', async () => {
    await http.post('/v1/me/documents?kind=selfie').set(bearer('rider')).set('content-type', 'image/jpeg').send(jpeg('x')).expect(400);
    await http.post('/v1/me/documents?kind=passport').set(bearer('rider')).send({ file: 'base64...' }).expect(415);
    // an HTML file sent as image/jpeg is judged by its bytes
    const fake = await http.post('/v1/me/documents?kind=passport').set(bearer('rider')).set('content-type', 'image/jpeg').send(Buffer.from('<html><script>x</script>')).expect(415);
    expect(fake.body.error).toBe('unsupported_type');
    await http.post('/v1/me/documents?kind=passport').set(bearer('rider')).set('content-type', 'application/pdf').send(Buffer.alloc(9 * 1024 * 1024, 0x25)).expect(413);
    await http.post('/v1/me/documents?kind=passport').set(bearer('uw')).set('content-type', 'image/jpeg').send(jpeg('staff')).expect(403);
    const dup = await http.post('/v1/me/documents?kind=national_id').set(bearer('rider')).set('content-type', 'image/jpeg').send(jpeg('nin')).expect(409);
    expect(dup.body.error).toBe('duplicate');
  });

  it('underwriters see and review the documents on the application; finance and collections cannot open them', async () => {
    await http.post('/v1/admin/lending/tiers/seed-placeholders').set(bearer('root')).expect(200);
    await http.post('/v1/admin/lending/products/motorcycle_ride_to_own/live').set(bearer('root')).send({ live: true }).expect(200);
    await http.post('/v1/me/profile').set(bearer('rider')).send({ fullName: 'Bola Rider' }).expect(200);
    const a = await http.post('/v1/me/applications').set(bearer('rider')).send({ productCode: 'motorcycle_ride_to_own' }).expect(201);
    const list = await http.get(`/v1/admin/lending/accounts/${a.body.reference}/documents`).set(bearer('uw')).expect(200);
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual([docId]);
    await http.get(`/v1/admin/lending/accounts/${a.body.reference}/documents`).set(bearer('fin')).expect(403);
    await http.get(`/v1/admin/documents/${docId}/file`).set(bearer('col')).expect(403);
    await http.get(`/v1/admin/documents/${docId}/file`).set(bearer('rider')).expect(403);

    const f = await http.get(`/v1/admin/documents/${docId}/file`).set(bearer('uw')).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(f.headers['content-type']).toBe('image/jpeg');
    expect(f.headers['cache-control']).toBe('no-store');
    expect(f.headers['content-security-policy']).toContain('sandbox');
    expect((f.body as Buffer).equals(jpeg('nin'))).toBe(true);

    const bad = await http.post(`/v1/admin/documents/${docId}/review`).set(bearer('uw')).send({ decision: 'rejected', note: 'no' }).expect(400);
    expect(bad.body.error).toBe('empty');
    await http.post(`/v1/admin/documents/${docId}/review`).set(bearer('uw')).send({ decision: 'rejected', note: 'Photo is blurred, retake in daylight' }).expect(200);
    await http.post(`/v1/admin/documents/${docId}/review`).set(bearer('mgr')).send({ decision: 'accepted' }).expect(409);
    const mine = await http.get('/v1/me/documents').set(bearer('rider')).expect(200);
    expect(mine.body.documents[0]).toMatchObject({ status: 'rejected', reviewNote: 'Photo is blurred, retake in daylight' });
  });

  it('after approval the customer sees the price, deposit, instalments and how much deposit is left', async () => {
    const accounts = await http.get('/v1/me/accounts').set(bearer('rider')).expect(200);
    const ref = accounts.body.accounts[0].reference;
    expect((await http.get(`/v1/me/accounts/${ref}`).set(bearer('rider')).expect(200)).body.terms).toBeNull();
    await http.post(`/v1/admin/lending/accounts/${ref}/approve`).set(bearer('uw')).send({ tier: 'B', assetPriceKobo: '150000000' }).expect(200);
    const s = await http.get(`/v1/me/accounts/${ref}`).set(bearer('rider')).expect(200);
    expect(s.body.terms).toMatchObject({ assetPrice: '150000000', deposit: '30000000', instalments: 52, frequency: 'weekly' });
    expect(s.body.deposit).toEqual({ required: '30000000', paid: '0', remaining: '30000000' });
  });
});
