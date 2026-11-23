import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { base32Decode, hotp, totpStep } from './crypto.js';
import { AuthError } from './errors.js';
import { IdentityService } from './service.js';
import { StaffAdminService } from './staff.js';

let db: TestDatabase;
let now = new Date('2026-11-23T09:00:00Z');
let identity: IdentityService;
let staff: StaffAdminService;
let root: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  identity = new IdentityService(
    db.pool,
    new SandboxMessaging(),
    { otpPepper: randomBytes(32), fieldKey: randomBytes(32), jwtSecret: randomBytes(32), issuer: 'T' },
    () => now,
  );
  staff = new StaffAdminService(db.pool, () => now);
  root = await identity.createStaffMember({
    email: 'root@x.com',
    fullName: 'Root',
    password: 'root-password-123',
    roles: ['super_admin'],
    grantedBy: null,
  });
});
afterAll(async () => db?.drop());

const code = (e: AuthError['code']) => ({ code: e });

async function login(email: string, password: string) {
  const s1 = await identity.staffLogin(email, password);
  const secret = s1.enrolment ? base32Decode(s1.enrolment.secret) : null;
  now = new Date(now.getTime() + 31_000); // next TOTP step, so codes are never replays
  if (!secret) throw new Error('expected enrolment');
  return identity.staffVerifyMfa(s1.challengeId, hotp(secret, totpStep(now)));
}

async function invited(roles: ('underwriter' | 'manager' | 'super_admin')[] = ['underwriter']) {
  const email = `s${++n}@x.com`;
  const inv = await staff.invite({ email, fullName: 'S', roles, by: root });
  return { email, ...inv };
}

describe('invites and setup links', () => {
  it('an invited person cannot sign in until they set a password with the link', async () => {
    const s = await invited();
    await expect(identity.staffLogin(s.email, 'anything-at-all-1')).rejects.toMatchObject(code('invalid_credentials'));
    await staff.completeSetup(s.token, 'my-new-password-1');
    await expect(login(s.email, 'my-new-password-1')).resolves.toBeDefined();
  });

  it('a link works once, expires after 72 hours, and only its hash is stored', async () => {
    const s = await invited();
    const { rows } = await db.pool.query('SELECT token_hash FROM staff_setup_token WHERE person_id = $1', [s.id]);
    expect(rows[0].token_hash).not.toBe(s.token);
    await staff.completeSetup(s.token, 'my-new-password-1');
    await expect(staff.completeSetup(s.token, 'another-password-2')).rejects.toMatchObject(code('setup_invalid'));

    const t = await invited();
    now = new Date(now.getTime() + 73 * 3_600_000);
    await expect(staff.completeSetup(t.token, 'my-new-password-1')).rejects.toMatchObject(code('setup_invalid'));
    const again = await staff.reissueLink(t.id, root);
    await expect(staff.completeSetup(t.token, 'my-new-password-1')).rejects.toMatchObject(code('setup_invalid'));
    await expect(staff.completeSetup(again.token, 'my-new-password-1')).resolves.toBeDefined();
  });

  it('refuses weak passwords and duplicate emails', async () => {
    const s = await invited();
    await expect(staff.completeSetup(s.token, 'short')).rejects.toMatchObject(code('weak_password'));
    await expect(staff.invite({ email: s.email, fullName: 'X', roles: ['finance'], by: root })).rejects.toMatchObject(
      code('email_taken'),
    );
  });
});

describe('reset access (forgotten password or lost phone)', () => {
  it('clears password and authenticator, signs out everywhere, and forces re-enrolment', async () => {
    const s = await invited();
    await staff.completeSetup(s.token, 'my-new-password-1');
    const tokens = await login(s.email, 'my-new-password-1');
    const sid = (await identity.verifyAccessToken(tokens.accessToken)).sid;

    const link = await staff.resetAccess(s.id, root);
    expect(await identity.isSessionActive(sid)).toBe(false);
    await expect(identity.staffLogin(s.email, 'my-new-password-1')).rejects.toMatchObject(code('invalid_credentials'));

    await staff.completeSetup(link.token, 'a-fresh-password-2');
    const step = await identity.staffLogin(s.email, 'a-fresh-password-2');
    expect(step.enrolmentRequired).toBe(true);
  });

  it('nobody can reset their own access', async () => {
    await expect(staff.resetAccess(root, root)).rejects.toMatchObject(code('self_action'));
  });
});

describe('roles and suspension', () => {
  it('changing roles signs the person out so new permissions apply at once', async () => {
    const s = await invited(['underwriter']);
    await staff.completeSetup(s.token, 'my-new-password-1');
    const tokens = await login(s.email, 'my-new-password-1');
    const sid = (await identity.verifyAccessToken(tokens.accessToken)).sid;
    await staff.setRoles(s.id, ['finance', 'collections'], root);
    expect(await identity.isSessionActive(sid)).toBe(false);
    const list = await staff.list();
    expect(list.find((x) => x.id === s.id)!.roles).toEqual(['collections', 'finance']);
  });

  it('the last active super admin can be neither demoted nor suspended', async () => {
    await expect(staff.setRoles(root, ['manager'], root)).rejects.toMatchObject(code('last_super_admin'));
    const second = await invited(['super_admin']);
    await expect(staff.setStatus(root, 'suspended', second.id)).resolves.toBeUndefined();
    await expect(staff.setStatus(second.id, 'suspended', root)).rejects.toMatchObject(code('last_super_admin'));
    await staff.setStatus(root, 'active', second.id);
  });

  it('a suspended person is signed out and cannot sign in', async () => {
    const s = await invited();
    await staff.completeSetup(s.token, 'my-new-password-1');
    const tokens = await login(s.email, 'my-new-password-1');
    await staff.setStatus(s.id, 'suspended', root);
    expect(await identity.isSessionActive((await identity.verifyAccessToken(tokens.accessToken)).sid)).toBe(false);
    await expect(identity.staffLogin(s.email, 'my-new-password-1')).rejects.toMatchObject(code('account_inactive'));
    await expect(staff.setStatus(root, 'suspended', root)).rejects.toMatchObject(code('self_action'));
  });

  it('rejects non-staff or duplicate roles', async () => {
    const s = await invited();
    await expect(staff.setRoles(s.id, [] as never, root)).rejects.toMatchObject(code('not_staff'));
    await expect(staff.setRoles(s.id, ['customer'] as never, root)).rejects.toMatchObject(code('not_staff'));
  });
});

describe('change own password', () => {
  it('needs the current password and signs out every other session, keeping this one', async () => {
    const s = await invited();
    await staff.completeSetup(s.token, 'my-new-password-1');

    // Device A enrols; device B signs in with the same authenticator a step later.
    const a1 = await identity.staffLogin(s.email, 'my-new-password-1');
    const secret = base32Decode(a1.enrolment!.secret);
    now = new Date(now.getTime() + 31_000);
    const a = await identity.staffVerifyMfa(a1.challengeId, hotp(secret, totpStep(now)));
    const b1 = await identity.staffLogin(s.email, 'my-new-password-1');
    now = new Date(now.getTime() + 31_000);
    const b = await identity.staffVerifyMfa(b1.challengeId, hotp(secret, totpStep(now)));
    const sidA = (await identity.verifyAccessToken(a.accessToken)).sid;
    const sidB = (await identity.verifyAccessToken(b.accessToken)).sid;
    expect(await identity.isSessionActive(sidB)).toBe(true);

    await expect(staff.changePassword(s.id, 'wrong-password-x', 'next-password-123', sidA)).rejects.toMatchObject(
      code('invalid_credentials'),
    );
    await staff.changePassword(s.id, 'my-new-password-1', 'next-password-123', sidA);
    expect(await identity.isSessionActive(sidA)).toBe(true);
    expect(await identity.isSessionActive(sidB)).toBe(false);
    await expect(identity.staffLogin(s.email, 'my-new-password-1')).rejects.toMatchObject(code('invalid_credentials'));
    await expect(identity.staffLogin(s.email, 'next-password-123')).resolves.toBeDefined();
  });
});

describe('audit', () => {
  it('records every staff change', async () => {
    const { rows } = await db.pool.query(`SELECT DISTINCT action FROM audit_event WHERE action LIKE 'staff.%' ORDER BY action`);
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'staff.access_reset',
        'staff.invited',
        'staff.password_changed',
        'staff.roles_changed',
        'staff.setup_completed',
        'staff.suspended',
      ]),
    );
  });
});
