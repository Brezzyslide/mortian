import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { Messaging } from '@project/adapters';
import { recordAudit } from './audit.js';
import {
  base32Decode,
  base32Encode,
  decrypt,
  encrypt,
  hashPassword,
  hmacSha256,
  matchTotp,
  randomToken,
  safeEqualHex,
  sha256,
  verifyPassword,
} from './crypto.js';
import { inTransaction, type PoolLike, type Queryable } from './db.js';
import { AuthError } from './errors.js';
import { maskPhone, normalizeNigerianMobile } from './phone.js';

export const CUSTOMER_ROLES = ['customer', 'rider', 'merchant'] as const;
export const STAFF_ROLES = ['underwriter', 'collections', 'dispatch_ops', 'finance', 'manager', 'super_admin'] as const;
export type Role = (typeof CUSTOMER_ROLES)[number] | (typeof STAFF_ROLES)[number];
export type SessionKind = 'customer' | 'staff';

export interface IdentityConfig {
  /** Secret mixed into OTP hashes so a database leak does not expose codes. ≥ 32 bytes. */
  readonly otpPepper: Buffer;
  /** AES-256 key for TOTP secrets at rest. Exactly 32 bytes. */
  readonly fieldKey: Buffer;
  /** HMAC key for access tokens. ≥ 32 bytes. */
  readonly jwtSecret: Uint8Array;
  readonly issuer: string;
  readonly otpTtlSeconds?: number;
  readonly otpMaxAttempts?: number;
  readonly otpRequestsPerWindow?: number;
  readonly otpWindowSeconds?: number;
  readonly accessTtlSeconds?: number;
  readonly customerRefreshTtlDays?: number;
  readonly staffRefreshTtlHours?: number;
  readonly staffMaxFailures?: number;
  readonly staffLockMinutes?: number;
  readonly mfaChallengeTtlSeconds?: number;
}

export interface RequestContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly accessExpiresAt: Date;
  readonly refreshToken: string;
  readonly refreshExpiresAt: Date;
}

export interface AccessClaims {
  readonly sub: string;
  readonly sid: string;
  readonly kind: SessionKind;
  readonly mfa: boolean;
  readonly roles: Role[];
}

const DUMMY_PASSWORD_HASH =
  'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export class IdentityService {
  private readonly c: Required<IdentityConfig>;

  constructor(
    private readonly pool: PoolLike,
    private readonly messaging: Messaging,
    config: IdentityConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (config.fieldKey.length !== 32) throw new Error('fieldKey must be 32 bytes');
    if (config.otpPepper.length < 32) throw new Error('otpPepper must be at least 32 bytes');
    if (config.jwtSecret.length < 32) throw new Error('jwtSecret must be at least 32 bytes');
    this.c = {
      otpTtlSeconds: 300,
      otpMaxAttempts: 5,
      otpRequestsPerWindow: 3,
      otpWindowSeconds: 900,
      accessTtlSeconds: 900,
      customerRefreshTtlDays: 30,
      staffRefreshTtlHours: 12,
      staffMaxFailures: 5,
      staffLockMinutes: 15,
      mfaChallengeTtlSeconds: 300,
      ...config,
    };
  }

  // ===================== Phone + OTP (customers, riders, merchants) =====================

  async requestLoginOtp(
    phoneInput: string,
    ctx: RequestContext = {},
  ): Promise<{ challengeId: string; expiresAt: Date; maskedPhone: string }> {
    const phone = normalizeNigerianMobile(phoneInput);
    if (!phone) throw new AuthError('invalid_phone');
    const now = this.clock();

    const recent = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM otp_challenge WHERE phone = $1 AND created_at > $2`,
      [phone, new Date(now.getTime() - this.c.otpWindowSeconds * 1000)],
    );
    if (recent.rows[0]!.n >= this.c.otpRequestsPerWindow) {
      await recordAudit(this.pool, {
        actorKind: 'anonymous',
        action: 'auth.otp.rate_limited',
        subjectType: 'phone',
        subjectId: maskPhone(phone),
        ...ctx,
      });
      throw new AuthError('rate_limited');
    }

    const challengeId = randomUUID();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = new Date(now.getTime() + this.c.otpTtlSeconds * 1000);

    await this.pool.query(
      `INSERT INTO otp_challenge (id, phone, code_hash, purpose, expires_at, max_attempts, created_at, ip)
       VALUES ($1, $2, $3, 'login', $4, $5, $6, $7)`,
      [challengeId, phone, this.otpHash(challengeId, code), expiresAt, this.c.otpMaxAttempts, now, ctx.ip ?? null],
    );
    await this.messaging.send('sms', phone, 'auth_otp_login', {
      code,
      minutes: String(Math.round(this.c.otpTtlSeconds / 60)),
    });
    await recordAudit(this.pool, {
      actorKind: 'anonymous',
      action: 'auth.otp.requested',
      subjectType: 'otp_challenge',
      subjectId: challengeId,
      details: { phone: maskPhone(phone) },
      ...ctx,
    });
    return { challengeId, expiresAt, maskedPhone: maskPhone(phone) };
  }

  async verifyLoginOtp(
    challengeId: string,
    code: string,
    ctx: RequestContext = {},
  ): Promise<{ personId: string; isNewPerson: boolean; tokens: TokenPair }> {
    const now = this.clock();
    const outcome = await inTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        phone: string;
        code_hash: string;
        expires_at: Date;
        attempts: number;
        max_attempts: number;
        consumed_at: Date | null;
      }>(
        `SELECT phone, code_hash, expires_at, attempts, max_attempts, consumed_at
           FROM otp_challenge WHERE id = $1 FOR UPDATE`,
        [challengeId],
      );
      const ch = rows[0];
      if (!ch || ch.consumed_at) return { error: 'otp_invalid' as const };
      if (ch.attempts >= ch.max_attempts) return { error: 'otp_locked' as const };
      if (ch.expires_at <= now) return { error: 'otp_expired' as const };

      if (!/^\d{6}$/.test(code) || !safeEqualHex(this.otpHash(challengeId, code), ch.code_hash)) {
        await tx.query('UPDATE otp_challenge SET attempts = attempts + 1 WHERE id = $1', [challengeId]);
        await recordAudit(tx, {
          actorKind: 'anonymous',
          action: 'auth.otp.failed',
          subjectType: 'otp_challenge',
          subjectId: challengeId,
          details: { attempt: ch.attempts + 1 },
          ...ctx,
        });
        return { error: ch.attempts + 1 >= ch.max_attempts ? ('otp_locked' as const) : ('otp_invalid' as const) };
      }

      await tx.query('UPDATE otp_challenge SET consumed_at = $2 WHERE id = $1', [challengeId, now]);

      const created = await tx.query<{ id: string }>(
        `INSERT INTO person (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING RETURNING id`,
        [ch.phone],
      );
      let personId: string;
      const isNewPerson = created.rows.length > 0;
      if (isNewPerson) {
        personId = created.rows[0]!.id;
        await tx.query(`INSERT INTO person_role (person_id, role) VALUES ($1, 'customer')`, [personId]);
      } else {
        const existing = await tx.query<{ id: string; status: string }>(
          'SELECT id, status FROM person WHERE phone = $1',
          [ch.phone],
        );
        personId = existing.rows[0]!.id;
        if (existing.rows[0]!.status !== 'active') return { error: 'account_inactive' as const };
      }

      const tokens = await this.issueSession(tx, personId, 'customer', false, ctx);
      await recordAudit(tx, {
        actorId: personId,
        actorKind: 'person',
        action: isNewPerson ? 'auth.person.registered' : 'auth.login.customer',
        subjectType: 'person',
        subjectId: personId,
        ...ctx,
      });
      return { personId, isNewPerson, tokens };
    });

    if ('error' in outcome) throw new AuthError(outcome.error);
    return outcome;
  }

  // ===================== Sessions =====================

  async refresh(refreshToken: string, ctx: RequestContext = {}): Promise<TokenPair> {
    const now = this.clock();
    const outcome = await inTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        person_id: string;
        family_id: string;
        kind: SessionKind;
        mfa_verified: boolean;
        expires_at: Date;
        rotated_at: Date | null;
        revoked_at: Date | null;
        status: string;
      }>(
        `SELECT s.id, s.person_id, s.family_id, s.kind, s.mfa_verified, s.expires_at, s.rotated_at, s.revoked_at, p.status
           FROM auth_session s JOIN person p ON p.id = s.person_id
          WHERE s.refresh_token_hash = $1
          FOR UPDATE OF s`,
        [sha256(refreshToken)],
      );
      const s = rows[0];
      if (!s) return { error: 'session_invalid' as const };

      if (s.rotated_at || s.revoked_at) {
        // A refresh token was presented after it was already used: treat as stolen and kill the family.
        await tx.query(
          `UPDATE auth_session SET revoked_at = $2, revoke_reason = 'refresh_token_reuse'
            WHERE family_id = $1 AND revoked_at IS NULL`,
          [s.family_id, now],
        );
        await recordAudit(tx, {
          actorId: s.person_id,
          actorKind: 'person',
          action: 'auth.session.reuse_detected',
          subjectType: 'session_family',
          subjectId: s.family_id,
          ...ctx,
        });
        return { error: 'session_reused' as const };
      }
      if (s.expires_at <= now || s.status !== 'active') return { error: 'session_invalid' as const };

      await tx.query('UPDATE auth_session SET rotated_at = $2 WHERE id = $1', [s.id, now]);
      return { tokens: await this.issueSession(tx, s.person_id, s.kind, s.mfa_verified, ctx, s.family_id) };
    });
    if ('error' in outcome) throw new AuthError(outcome.error);
    return outcome.tokens;
  }

  async logout(refreshToken: string, ctx: RequestContext = {}): Promise<void> {
    const { rows } = await this.pool.query<{ family_id: string; person_id: string }>(
      'SELECT family_id, person_id FROM auth_session WHERE refresh_token_hash = $1',
      [sha256(refreshToken)],
    );
    const s = rows[0];
    if (!s) return;
    await this.revokeFamily(s.family_id, 'logout');
    await recordAudit(this.pool, {
      actorId: s.person_id,
      actorKind: 'person',
      action: 'auth.logout',
      subjectType: 'session_family',
      subjectId: s.family_id,
      ...ctx,
    });
  }

  /** Revokes every session of a person, e.g. after a role change or suspension. */
  async revokeAllSessions(personId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_session SET revoked_at = $2, revoke_reason = $3 WHERE person_id = $1 AND revoked_at IS NULL`,
      [personId, this.clock(), reason],
    );
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.c.jwtSecret, {
        issuer: this.c.issuer,
        algorithms: ['HS256'],
        currentDate: this.clock(),
      });
      return {
        sub: payload.sub!,
        sid: payload['sid'] as string,
        kind: payload['kind'] as SessionKind,
        mfa: payload['mfa'] as boolean,
        roles: payload['roles'] as Role[],
      };
    } catch {
      throw new AuthError('session_invalid');
    }
  }

  /** True while the session (and its person) is usable. Guards call this on every request. */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ ok: boolean }>(
      `SELECT (s.revoked_at IS NULL AND s.expires_at > $2 AND p.status = 'active') AS ok
         FROM auth_session s JOIN person p ON p.id = s.person_id WHERE s.id = $1`,
      [sessionId, this.clock()],
    );
    return rows[0]?.ok === true;
  }

  // ===================== Staff: email + password + TOTP =====================

  async createStaffMember(input: {
    email: string;
    fullName: string;
    password: string;
    roles: readonly (typeof STAFF_ROLES)[number][];
    grantedBy: string | null;
  }): Promise<string> {
    assertStrongPassword(input.password);
    if (input.roles.length === 0) throw new Error('Staff member needs at least one role');
    for (const r of input.roles) {
      if (!(STAFF_ROLES as readonly string[]).includes(r)) throw new Error(`Not a staff role: ${r}`);
    }
    const passwordHash = await hashPassword(input.password);
    return inTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO person (email, full_name) VALUES ($1, $2) RETURNING id`,
        [input.email.trim().toLowerCase(), input.fullName],
      );
      const personId = rows[0]!.id;
      await tx.query(`INSERT INTO staff_credential (person_id, password_hash) VALUES ($1, $2)`, [
        personId,
        passwordHash,
      ]);
      await tx.query(
        `INSERT INTO person_role (person_id, role, granted_by) SELECT $1, unnest($2::text[]), $3`,
        [personId, input.roles, input.grantedBy],
      );
      await recordAudit(tx, {
        actorId: input.grantedBy,
        actorKind: input.grantedBy ? 'person' : 'system',
        action: 'staff.created',
        subjectType: 'person',
        subjectId: personId,
        details: { roles: input.roles },
      });
      return personId;
    });
  }

  /**
   * Step 1 of staff login. Always ends in an MFA challenge; on first login it also returns
   * the TOTP secret to enrol in an authenticator app. No session is issued until step 2.
   */
  async staffLogin(
    email: string,
    password: string,
    ctx: RequestContext = {},
  ): Promise<{
    challengeId: string;
    enrolmentRequired: boolean;
    enrolment?: { secret: string; otpauthUri: string };
  }> {
    const now = this.clock();
    const normalized = email.trim().toLowerCase();
    const { rows } = await this.pool.query<{
      person_id: string;
      status: string;
      password_hash: string;
      totp_secret_enc: string | null;
      totp_enabled_at: Date | null;
      failed_attempts: number;
      locked_until: Date | null;
    }>(
      `SELECT p.id AS person_id, p.status, c.password_hash, c.totp_secret_enc, c.totp_enabled_at,
              c.failed_attempts, c.locked_until
         FROM person p JOIN staff_credential c ON c.person_id = p.id
        WHERE p.email = $1`,
      [normalized],
    );
    const s = rows[0];

    if (!s) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH); // equalise timing for unknown emails
      await recordAudit(this.pool, { actorKind: 'anonymous', action: 'auth.staff.failed', ...ctx });
      throw new AuthError('invalid_credentials');
    }
    if (s.locked_until && s.locked_until > now) throw new AuthError('account_locked');

    if (!(await verifyPassword(password, s.password_hash))) {
      const failures = s.failed_attempts + 1;
      const lock = failures >= this.c.staffMaxFailures;
      await this.pool.query(
        `UPDATE staff_credential SET failed_attempts = $2, locked_until = $3 WHERE person_id = $1`,
        [s.person_id, lock ? 0 : failures, lock ? new Date(now.getTime() + this.c.staffLockMinutes * 60_000) : null],
      );
      await recordAudit(this.pool, {
        actorId: s.person_id,
        actorKind: 'person',
        action: lock ? 'auth.staff.locked' : 'auth.staff.failed',
        subjectType: 'person',
        subjectId: s.person_id,
        ...ctx,
      });
      throw new AuthError(lock ? 'account_locked' : 'invalid_credentials');
    }
    if (s.status !== 'active') throw new AuthError('account_inactive');

    await this.pool.query(`UPDATE staff_credential SET failed_attempts = 0, locked_until = NULL WHERE person_id = $1`, [
      s.person_id,
    ]);

    let enrolment: { secret: string; otpauthUri: string } | undefined;
    if (!s.totp_enabled_at) {
      const secret = base32Encode(randomBytes(20));
      await this.pool.query(`UPDATE staff_credential SET totp_secret_enc = $2 WHERE person_id = $1`, [
        s.person_id,
        encrypt(this.c.fieldKey, secret),
      ]);
      const label = encodeURIComponent(`${this.c.issuer}:${normalized}`);
      enrolment = {
        secret,
        otpauthUri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(this.c.issuer)}&algorithm=SHA1&digits=6&period=30`,
      };
    }

    const challengeId = randomUUID();
    await this.pool.query(`INSERT INTO staff_mfa_challenge (id, person_id, expires_at, created_at) VALUES ($1, $2, $3, $4)`, [
      challengeId,
      s.person_id,
      new Date(now.getTime() + this.c.mfaChallengeTtlSeconds * 1000),
      now,
    ]);
    return { challengeId, enrolmentRequired: !s.totp_enabled_at, ...(enrolment ? { enrolment } : {}) };
  }

  /** Step 2 of staff login: TOTP code. Confirms enrolment on first use. */
  async staffVerifyMfa(challengeId: string, code: string, ctx: RequestContext = {}): Promise<TokenPair> {
    const now = this.clock();
    const outcome = await inTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{
        person_id: string;
        expires_at: Date;
        attempts: number;
        consumed_at: Date | null;
        totp_secret_enc: string | null;
        totp_enabled_at: Date | null;
        totp_last_step: string | null;
      }>(
        `SELECT m.person_id, m.expires_at, m.attempts, m.consumed_at,
                c.totp_secret_enc, c.totp_enabled_at, c.totp_last_step::text
           FROM staff_mfa_challenge m JOIN staff_credential c ON c.person_id = m.person_id
          WHERE m.id = $1 FOR UPDATE OF m, c`,
        [challengeId],
      );
      const m = rows[0];
      if (!m || m.consumed_at || m.attempts >= 5 || !m.totp_secret_enc) return { error: 'mfa_invalid' as const };
      if (m.expires_at <= now) return { error: 'mfa_expired' as const };

      const secret = base32Decode(decrypt(this.c.fieldKey, m.totp_secret_enc));
      const step = matchTotp(secret, code, now);
      const lastStep = m.totp_last_step === null ? -1 : Number(m.totp_last_step);
      if (step === null || step <= lastStep) {
        await tx.query('UPDATE staff_mfa_challenge SET attempts = attempts + 1 WHERE id = $1', [challengeId]);
        await recordAudit(tx, {
          actorId: m.person_id,
          actorKind: 'person',
          action: step === null ? 'auth.staff.mfa_failed' : 'auth.staff.mfa_replay',
          subjectType: 'person',
          subjectId: m.person_id,
          ...ctx,
        });
        return { error: 'mfa_invalid' as const };
      }

      await tx.query('UPDATE staff_mfa_challenge SET consumed_at = $2 WHERE id = $1', [challengeId, now]);
      await tx.query(
        `UPDATE staff_credential SET totp_last_step = $2, totp_enabled_at = coalesce(totp_enabled_at, $3)
          WHERE person_id = $1`,
        [m.person_id, step, now],
      );
      const tokens = await this.issueSession(tx, m.person_id, 'staff', true, ctx);
      await recordAudit(tx, {
        actorId: m.person_id,
        actorKind: 'person',
        action: m.totp_enabled_at ? 'auth.login.staff' : 'auth.staff.mfa_enrolled',
        subjectType: 'person',
        subjectId: m.person_id,
        ...ctx,
      });
      return { tokens };
    });
    if ('error' in outcome) throw new AuthError(outcome.error);
    return outcome.tokens;
  }

  // ===================== internals =====================

  private otpHash(challengeId: string, code: string): string {
    return hmacSha256(this.c.otpPepper, `${challengeId}:${code}`);
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_session SET revoked_at = $2, revoke_reason = $3 WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, this.clock(), reason],
    );
  }

  private async issueSession(
    tx: Queryable,
    personId: string,
    kind: SessionKind,
    mfaVerified: boolean,
    ctx: RequestContext,
    familyId: string = randomUUID(),
  ): Promise<TokenPair> {
    const now = this.clock();
    const refreshToken = randomToken();
    const refreshExpiresAt =
      kind === 'staff'
        ? new Date(now.getTime() + this.c.staffRefreshTtlHours * 3_600_000)
        : new Date(now.getTime() + this.c.customerRefreshTtlDays * 86_400_000);
    const sessionId = randomUUID();

    await tx.query(
      `INSERT INTO auth_session
         (id, person_id, family_id, refresh_token_hash, kind, mfa_verified, issued_at, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [sessionId, personId, familyId, sha256(refreshToken), kind, mfaVerified, now, refreshExpiresAt, ctx.ip ?? null, ctx.userAgent ?? null],
    );

    const roleRows = await tx.query<{ role: Role }>('SELECT role FROM person_role WHERE person_id = $1 ORDER BY role', [
      personId,
    ]);
    // A customer-kind session never carries staff roles, even if the person also holds one.
    const roles = roleRows.rows
      .map((r) => r.role)
      .filter((r) => kind === 'staff' || (CUSTOMER_ROLES as readonly string[]).includes(r));

    const accessExpiresAt = new Date(now.getTime() + this.c.accessTtlSeconds * 1000);
    const accessToken = await new SignJWT({ sid: sessionId, kind, mfa: mfaVerified, roles })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(personId)
      .setIssuer(this.c.issuer)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(accessExpiresAt.getTime() / 1000))
      .sign(this.c.jwtSecret);

    return { accessToken, accessExpiresAt, refreshToken, refreshExpiresAt };
  }
}

const COMMON_PASSWORDS = new Set(['password1234', '123456789012', 'qwertyuiop12', 'changeme1234']);

export function assertStrongPassword(pw: string): void {
  if (pw.length < 12 || COMMON_PASSWORDS.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) {
    throw new AuthError('weak_password', 'Password must be at least 12 characters and not a common password');
  }
}
