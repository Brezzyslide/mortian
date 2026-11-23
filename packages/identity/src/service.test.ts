import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, totpStep } from './crypto.js';
import { AuthError } from './errors.js';
import { IdentityService } from './service.js';

let db: TestDatabase;
let messaging: SandboxMessaging;
let now: Date;
let svc: IdentityService;

const config = {
  otpPepper: randomBytes(32),
  fieldKey: randomBytes(32),
  jwtSecret: randomBytes(32),
  issuer: 'PROJECT_NAME',
};

beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db?.drop());
beforeEach(() => {
  messaging = new SandboxMessaging();
  now = new Date('2026-11-23T09:00:00Z');
  svc = new IdentityService(db.pool, messaging, config, () => now);
});

const advance = (seconds: number) => {
  now = new Date(now.getTime() + seconds * 1000);
};
let phoneSeq = 1000000;
const nextPhone = () => `0803${(phoneSeq++).toString().padStart(7, '0')}`;
const e164 = (local: string) => `+234${local.slice(1)}`;
const codeFor = (local: string) => messaging.lastTo(e164(local))!.vars['code']!;

async function expectAuthError(p: Promise<unknown>, code: AuthError['code']) {
  await expect(p).rejects.toSatisfy((e: unknown) => e instanceof AuthError && e.code === code);
}

describe('phone OTP login', () => {
  it('registers a new person as customer and issues tokens', async () => {
    const phone = nextPhone();
    const { challengeId, maskedPhone } = await svc.requestLoginOtp(phone);
    expect(maskedPhone).toMatch(/\*\*\*/);
    const res = await svc.verifyLoginOtp(challengeId, codeFor(phone));
    expect(res.isNewPerson).toBe(true);
    const claims = await svc.verifyAccessToken(res.tokens.accessToken);
    expect(claims).toMatchObject({ sub: res.personId, kind: 'customer', mfa: false, roles: ['customer'] });
  });

  it('logs an existing person back in without creating a duplicate', async () => {
    const phone = nextPhone();
    const a = await svc.requestLoginOtp(phone);
    const first = await svc.verifyLoginOtp(a.challengeId, codeFor(phone));
    const b = await svc.requestLoginOtp(phone);
    const second = await svc.verifyLoginOtp(b.challengeId, codeFor(phone));
    expect(second.isNewPerson).toBe(false);
    expect(second.personId).toBe(first.personId);
  });

  it('never stores the OTP code in plain text', async () => {
    const phone = nextPhone();
    const { challengeId } = await svc.requestLoginOtp(phone);
    const { rows } = await db.pool.query('SELECT code_hash FROM otp_challenge WHERE id = $1', [challengeId]);
    expect(rows[0].code_hash).not.toContain(codeFor(phone));
    expect(rows[0].code_hash).toHaveLength(64);
  });

  it('rejects a wrong code and locks the challenge after 5 attempts, even for the right code', async () => {
    const phone = nextPhone();
    const { challengeId } = await svc.requestLoginOtp(phone);
    const right = codeFor(phone);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) await expectAuthError(svc.verifyLoginOtp(challengeId, wrong), 'otp_invalid');
    await expectAuthError(svc.verifyLoginOtp(challengeId, wrong), 'otp_locked');
    await expectAuthError(svc.verifyLoginOtp(challengeId, right), 'otp_locked');
  });

  it('rejects an expired code', async () => {
    const phone = nextPhone();
    const { challengeId } = await svc.requestLoginOtp(phone);
    advance(301);
    await expectAuthError(svc.verifyLoginOtp(challengeId, codeFor(phone)), 'otp_expired');
  });

  it('rejects reuse of a consumed code', async () => {
    const phone = nextPhone();
    const { challengeId } = await svc.requestLoginOtp(phone);
    await svc.verifyLoginOtp(challengeId, codeFor(phone));
    await expectAuthError(svc.verifyLoginOtp(challengeId, codeFor(phone)), 'otp_invalid');
  });

  it('rate-limits to 3 codes per phone per 15 minutes', async () => {
    const phone = nextPhone();
    for (let i = 0; i < 3; i++) await svc.requestLoginOtp(phone);
    await expectAuthError(svc.requestLoginOtp(phone), 'rate_limited');
    advance(901);
    await expect(svc.requestLoginOtp(phone)).resolves.toBeDefined();
  });

  it('rejects non-Nigerian or malformed numbers', async () => {
    await expectAuthError(svc.requestLoginOtp('+447911123456'), 'invalid_phone');
  });

  it('blocks suspended people', async () => {
    const phone = nextPhone();
    const a = await svc.requestLoginOtp(phone);
    const { personId } = await svc.verifyLoginOtp(a.challengeId, codeFor(phone));
    await db.pool.query(`UPDATE person SET status = 'suspended' WHERE id = $1`, [personId]);
    const b = await svc.requestLoginOtp(phone);
    await expectAuthError(svc.verifyLoginOtp(b.challengeId, codeFor(phone)), 'account_inactive');
  });
});

describe('sessions', () => {
  async function login() {
    const phone = nextPhone();
    const { challengeId } = await svc.requestLoginOtp(phone);
    return svc.verifyLoginOtp(challengeId, codeFor(phone));
  }

  it('rotates the refresh token on every use', async () => {
    const { tokens } = await login();
    const next = await svc.refresh(tokens.refreshToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    await expect(svc.refresh(next.refreshToken)).resolves.toBeDefined();
  });

  it('detects refresh-token reuse and revokes the whole family', async () => {
    const { tokens } = await login();
    const stolenCopy = tokens.refreshToken;
    const legit = await svc.refresh(tokens.refreshToken);
    await expectAuthError(svc.refresh(stolenCopy), 'session_reused');
    // the legitimate holder is logged out too
    await expectAuthError(svc.refresh(legit.refreshToken), 'session_reused');
    const claims = await svc.verifyAccessToken(legit.accessToken);
    expect(await svc.isSessionActive(claims.sid)).toBe(false);
  });

  it('expires access tokens after 15 minutes', async () => {
    const { tokens } = await login();
    advance(901);
    await expectAuthError(svc.verifyAccessToken(tokens.accessToken), 'session_invalid');
  });

  it('rejects a token signed with another key', async () => {
    const { tokens } = await login();
    const other = new IdentityService(db.pool, messaging, { ...config, jwtSecret: randomBytes(32) }, () => now);
    await expectAuthError(other.verifyAccessToken(tokens.accessToken), 'session_invalid');
  });

  it('logout revokes the session', async () => {
    const { tokens } = await login();
    const sid = (await svc.verifyAccessToken(tokens.accessToken)).sid;
    await svc.logout(tokens.refreshToken);
    expect(await svc.isSessionActive(sid)).toBe(false);
    await expectAuthError(svc.refresh(tokens.refreshToken), 'session_reused');
  });

  it('stores only hashes of refresh tokens', async () => {
    const { tokens } = await login();
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM auth_session WHERE refresh_token_hash = $1', [
      tokens.refreshToken,
    ]);
    expect(rows[0].n).toBe(0);
  });
});

describe('staff login with TOTP', () => {
  let emailSeq = 0;
  const password = 'a-long-staff-passphrase';

  async function newStaff(roles: ('underwriter' | 'manager')[] = ['underwriter']) {
    const email = `staff${++emailSeq}@example.com`;
    const personId = await svc.createStaffMember({ email, fullName: 'Staff', password, roles, grantedBy: null });
    return { email, personId };
  }

  async function enrol(email: string) {
    const step1 = await svc.staffLogin(email, password);
    expect(step1.enrolmentRequired).toBe(true);
    const secret = base32Decode(step1.enrolment!.secret);
    const tokens = await svc.staffVerifyMfa(step1.challengeId, hotp(secret, totpStep(now)));
    return { secret, tokens };
  }

  it('requires TOTP enrolment on first login, then issues an MFA-verified staff session', async () => {
    const { email } = await newStaff(['underwriter', 'manager']);
    const { tokens } = await enrol(email);
    const claims = await svc.verifyAccessToken(tokens.accessToken);
    expect(claims).toMatchObject({ kind: 'staff', mfa: true, roles: ['manager', 'underwriter'] });
  });

  it('does not return the TOTP secret again once enrolled', async () => {
    const { email } = await newStaff();
    await enrol(email);
    const again = await svc.staffLogin(email, password);
    expect(again.enrolmentRequired).toBe(false);
    expect(again.enrolment).toBeUndefined();
  });

  it('rejects a replayed TOTP code', async () => {
    const { email } = await newStaff();
    const { secret } = await enrol(email);
    const step = await svc.staffLogin(email, password);
    await expectAuthError(svc.staffVerifyMfa(step.challengeId, hotp(secret, totpStep(now))), 'mfa_invalid');
    advance(30);
    await expect(svc.staffVerifyMfa(step.challengeId, hotp(secret, totpStep(now)))).resolves.toBeDefined();
  });

  it('gives the same error for unknown email and wrong password', async () => {
    const { email } = await newStaff();
    await expectAuthError(svc.staffLogin('nobody@example.com', password), 'invalid_credentials');
    await expectAuthError(svc.staffLogin(email, 'wrong-password-here'), 'invalid_credentials');
  });

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    const { email } = await newStaff();
    for (let i = 0; i < 4; i++) await expectAuthError(svc.staffLogin(email, 'wrong-password-here'), 'invalid_credentials');
    await expectAuthError(svc.staffLogin(email, 'wrong-password-here'), 'account_locked');
    await expectAuthError(svc.staffLogin(email, password), 'account_locked');
    advance(15 * 60 + 1);
    await expect(svc.staffLogin(email, password)).resolves.toBeDefined();
  });

  it('stores the TOTP secret encrypted', async () => {
    const { email, personId } = await newStaff();
    const step1 = await svc.staffLogin(email, password);
    const { rows } = await db.pool.query('SELECT totp_secret_enc FROM staff_credential WHERE person_id = $1', [personId]);
    expect(rows[0].totp_secret_enc).not.toContain(step1.enrolment!.secret);
  });

  it('rejects weak passwords', async () => {
    await expect(
      svc.createStaffMember({ email: 'weak@example.com', fullName: 'W', password: 'short', roles: ['finance'], grantedBy: null }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('never puts staff roles in a customer session', async () => {
    const { personId } = await newStaff(['manager']);
    const phone = nextPhone();
    await db.pool.query('UPDATE person SET phone = $2 WHERE id = $1', [personId, e164(phone)]);
    const { challengeId } = await svc.requestLoginOtp(phone);
    const { tokens } = await svc.verifyLoginOtp(challengeId, codeFor(phone));
    const claims = await svc.verifyAccessToken(tokens.accessToken);
    expect(claims.kind).toBe('customer');
    expect(claims.roles).not.toContain('manager');
  });
});

describe('audit log', () => {
  it('records auth events and is append-only', async () => {
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE action LIKE 'auth.%'`);
    expect(rows[0].n).toBeGreaterThan(0);
    await expect(db.pool.query('DELETE FROM audit_event')).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE audit_event SET action = 'x'`)).rejects.toThrow(/immutable/);
  });

  it('never records OTP codes', async () => {
    const { rows } = await db.pool.query(`SELECT details::text AS d FROM audit_event`);
    for (const r of rows) expect(r.d).not.toMatch(/"code"/);
  });
});
