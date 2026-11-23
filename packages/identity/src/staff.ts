import { recordAudit } from './audit.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { inTransaction, type PoolLike, type Queryable } from './db.js';
import { AuthError } from './errors.js';
import { assertStrongPassword, STAFF_ROLES } from './service.js';

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Stored in place of a password hash until the person sets one. verifyPassword never accepts it. */
const NO_PASSWORD = 'unset';
const SETUP_TTL_HOURS = 72;

export interface StaffMember {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: string;
  readonly roles: StaffRole[];
  readonly passwordSet: boolean;
  readonly authenticatorEnrolled: boolean;
  readonly lockedUntil: Date | null;
  readonly pendingSetup: { purpose: 'invite' | 'reset'; expiresAt: Date } | null;
}

export interface SetupLink {
  /** Shown once to the super admin, who hands it over out of band. Never stored in plain text. */
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Staff lifecycle, run by a super admin from the console: invite, roles, suspend, reset access.
 * Every change revokes the person's sessions so it takes effect on their next request, and is audited.
 */
export class StaffAdminService {
  constructor(
    private readonly pool: PoolLike,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(): Promise<StaffMember[]> {
    const { rows } = await this.pool.query<{
      id: string;
      email: string;
      full_name: string | null;
      status: string;
      roles: StaffRole[];
      password_hash: string;
      totp_enabled_at: Date | null;
      locked_until: Date | null;
      setup_purpose: 'invite' | 'reset' | null;
      setup_expires: Date | null;
    }>(
      `SELECT p.id, p.email, p.full_name, p.status, c.password_hash, c.totp_enabled_at, c.locked_until,
              coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles,
              t.purpose AS setup_purpose, t.expires_at AS setup_expires
         FROM person p
         JOIN staff_credential c ON c.person_id = p.id
         LEFT JOIN person_role r ON r.person_id = p.id
         LEFT JOIN staff_setup_token t ON t.person_id = p.id AND t.used_at IS NULL AND t.revoked_at IS NULL
        GROUP BY p.id, c.person_id, t.id
        ORDER BY p.email`,
    );
    const now = this.clock();
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      status: r.status,
      roles: r.roles,
      passwordSet: r.password_hash !== NO_PASSWORD,
      authenticatorEnrolled: r.totp_enabled_at !== null,
      lockedUntil: r.locked_until && r.locked_until > now ? r.locked_until : null,
      pendingSetup: r.setup_purpose && r.setup_expires ? { purpose: r.setup_purpose, expiresAt: r.setup_expires } : null,
    }));
  }

  /** Creates a staff member with no password and returns a one-time setup link. */
  async invite(input: { email: string; fullName: string; roles: StaffRole[]; by: string }): Promise<{ id: string } & SetupLink> {
    assertStaffRoles(input.roles);
    return inTransaction(this.pool, async (tx) => {
      const email = input.email.trim().toLowerCase();
      const exists = await tx.query('SELECT 1 FROM person WHERE email = $1', [email]);
      if (exists.rows.length) throw new AuthError('email_taken');
      const { rows } = await tx.query<{ id: string }>(`INSERT INTO person (email, full_name) VALUES ($1, $2) RETURNING id`, [
        email,
        input.fullName,
      ]);
      const id = rows[0]!.id;
      await tx.query(`INSERT INTO staff_credential (person_id, password_hash) VALUES ($1, $2)`, [id, NO_PASSWORD]);
      await tx.query(`INSERT INTO person_role (person_id, role, granted_by) SELECT $1, unnest($2::text[]), $3`, [
        id,
        input.roles,
        input.by,
      ]);
      const link = await this.issueLink(tx, id, 'invite', input.by);
      await recordAudit(tx, {
        actorId: input.by,
        actorKind: 'person',
        action: 'staff.invited',
        subjectType: 'person',
        subjectId: id,
        details: { roles: input.roles },
      });
      return { id, ...link };
    });
  }

  /** Replaces a staff member's roles. The last active super admin cannot lose that role. */
  async setRoles(personId: string, roles: StaffRole[], by: string): Promise<void> {
    assertStaffRoles(roles);
    await inTransaction(this.pool, async (tx) => {
      await this.lockStaff(tx, personId);
      if (!roles.includes('super_admin')) await this.assertNotLastSuperAdmin(tx, personId);
      const before = (await tx.query<{ role: string }>('SELECT role FROM person_role WHERE person_id = $1 ORDER BY role', [personId])).rows.map(
        (r) => r.role,
      );
      await tx.query('DELETE FROM person_role WHERE person_id = $1', [personId]);
      await tx.query(`INSERT INTO person_role (person_id, role, granted_by) SELECT $1, unnest($2::text[]), $3`, [personId, roles, by]);
      await revokeSessions(tx, personId, 'roles_changed', this.clock());
      await recordAudit(tx, {
        actorId: by,
        actorKind: 'person',
        action: 'staff.roles_changed',
        subjectType: 'person',
        subjectId: personId,
        details: { before, after: [...roles].sort() },
      });
    });
  }

  async setStatus(personId: string, status: 'active' | 'suspended', by: string): Promise<void> {
    if (personId === by) throw new AuthError('self_action', 'You cannot suspend or reactivate yourself');
    await inTransaction(this.pool, async (tx) => {
      await this.lockStaff(tx, personId);
      if (status === 'suspended') await this.assertNotLastSuperAdmin(tx, personId);
      await tx.query('UPDATE person SET status = $2 WHERE id = $1', [personId, status]);
      if (status === 'suspended') await revokeSessions(tx, personId, 'suspended', this.clock());
      await recordAudit(tx, {
        actorId: by,
        actorKind: 'person',
        action: status === 'suspended' ? 'staff.suspended' : 'staff.reactivated',
        subjectType: 'person',
        subjectId: personId,
      });
    });
  }

  /**
   * Forgotten password or lost authenticator: clears both, signs the person out everywhere and
   * returns a one-time link to set a new password. They enrol a new authenticator at next sign-in.
   */
  async resetAccess(personId: string, by: string): Promise<SetupLink> {
    if (personId === by) throw new AuthError('self_action', 'Ask another super admin to reset your access');
    return inTransaction(this.pool, async (tx) => {
      await this.lockStaff(tx, personId);
      await tx.query(
        `UPDATE staff_credential
            SET password_hash = $2, totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL,
                failed_attempts = 0, locked_until = NULL
          WHERE person_id = $1`,
        [personId, NO_PASSWORD],
      );
      await revokeSessions(tx, personId, 'access_reset', this.clock());
      const link = await this.issueLink(tx, personId, 'reset', by);
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'staff.access_reset', subjectType: 'person', subjectId: personId });
      return link;
    });
  }

  /** Re-issues an expired or lost invite link. Any earlier unused link stops working. */
  async reissueLink(personId: string, by: string): Promise<SetupLink> {
    return inTransaction(this.pool, async (tx) => {
      await this.lockStaff(tx, personId);
      const c = await tx.query<{ password_hash: string }>('SELECT password_hash FROM staff_credential WHERE person_id = $1', [personId]);
      if (c.rows[0]!.password_hash !== NO_PASSWORD) {
        throw new AuthError('setup_invalid', 'This person has a password: use reset access instead');
      }
      const link = await this.issueLink(tx, personId, 'invite', by);
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'staff.link_reissued', subjectType: 'person', subjectId: personId });
      return link;
    });
  }

  /** Public: the person sets their password with the link. Single use, expires after 72 hours. */
  async completeSetup(token: string, password: string): Promise<{ email: string }> {
    assertStrongPassword(password);
    const hash = await hashPassword(password);
    const now = this.clock();
    const outcome = await inTransaction(this.pool, async (tx) => {
      const { rows } = await tx.query<{ id: string; person_id: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null; email: string; status: string }>(
        `SELECT t.id, t.person_id, t.expires_at, t.used_at, t.revoked_at, p.email, p.status
           FROM staff_setup_token t JOIN person p ON p.id = t.person_id
          WHERE t.token_hash = $1 FOR UPDATE OF t`,
        [sha256(token)],
      );
      const t = rows[0];
      if (!t || t.used_at || t.revoked_at || t.expires_at <= now || t.status !== 'active') return null;
      await tx.query('UPDATE staff_setup_token SET used_at = $2 WHERE id = $1', [t.id, now]);
      await tx.query(
        `UPDATE staff_credential SET password_hash = $2, password_set_at = $3, failed_attempts = 0, locked_until = NULL
          WHERE person_id = $1`,
        [t.person_id, hash, now],
      );
      await revokeSessions(tx, t.person_id, 'password_set', now);
      await recordAudit(tx, { actorId: t.person_id, actorKind: 'person', action: 'staff.setup_completed', subjectType: 'person', subjectId: t.person_id });
      return { email: t.email };
    });
    if (!outcome) throw new AuthError('setup_invalid');
    return outcome;
  }

  /** Signed-in staff change their own password. Every other session is signed out. */
  async changePassword(personId: string, current: string, next: string, keepSessionId: string): Promise<void> {
    assertStrongPassword(next);
    const { rows } = await this.pool.query<{ password_hash: string }>('SELECT password_hash FROM staff_credential WHERE person_id = $1', [
      personId,
    ]);
    if (!rows[0]) throw new AuthError('not_staff');
    if (!(await verifyPassword(current, rows[0].password_hash))) throw new AuthError('invalid_credentials');
    if (current === next) throw new AuthError('weak_password', 'Choose a password you have not used here before');
    const hash = await hashPassword(next);
    await inTransaction(this.pool, async (tx) => {
      await tx.query('UPDATE staff_credential SET password_hash = $2, password_set_at = $3 WHERE person_id = $1', [personId, hash, this.clock()]);
      await tx.query(
        `UPDATE auth_session SET revoked_at = $3, revoke_reason = 'password_changed'
          WHERE person_id = $1 AND revoked_at IS NULL
            AND family_id <> (SELECT family_id FROM auth_session WHERE id = $2)`,
        [personId, keepSessionId, this.clock()],
      );
      await recordAudit(tx, { actorId: personId, actorKind: 'person', action: 'staff.password_changed', subjectType: 'person', subjectId: personId });
    });
  }

  // ---------------- internals ----------------

  private async issueLink(tx: Queryable, personId: string, purpose: 'invite' | 'reset', by: string): Promise<SetupLink> {
    const now = this.clock();
    await tx.query(
      `UPDATE staff_setup_token SET revoked_at = $2 WHERE person_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [personId, now],
    );
    const token = randomToken(32);
    const expiresAt = new Date(now.getTime() + SETUP_TTL_HOURS * 3_600_000);
    await tx.query(
      `INSERT INTO staff_setup_token (person_id, token_hash, purpose, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [personId, sha256(token), purpose, by, now, expiresAt],
    );
    return { token, expiresAt };
  }

  private async lockStaff(tx: Queryable, personId: string): Promise<void> {
    const r = await tx.query('SELECT 1 FROM staff_credential WHERE person_id = $1 FOR UPDATE', [personId]);
    if (!r.rows.length) throw new AuthError('not_staff');
  }

  private async assertNotLastSuperAdmin(tx: Queryable, personId: string): Promise<void> {
    // Serialise super-admin changes so two concurrent demotions cannot both pass this check.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('staff:super_admin'))`);
    const { rows } = await tx.query<{ me: boolean; others: number }>(
      `SELECT EXISTS (SELECT 1 FROM person_role WHERE person_id = $1 AND role = 'super_admin') AS me,
              (SELECT count(*)::int FROM person_role r JOIN person p ON p.id = r.person_id
                WHERE r.role = 'super_admin' AND p.status = 'active' AND r.person_id <> $1) AS others`,
      [personId],
    );
    if (rows[0]!.me && rows[0]!.others === 0) throw new AuthError('last_super_admin');
  }
}

function assertStaffRoles(roles: readonly string[]): asserts roles is StaffRole[] {
  if (roles.length === 0 || roles.some((r) => !(STAFF_ROLES as readonly string[]).includes(r)) || new Set(roles).size !== roles.length) {
    throw new AuthError('not_staff', 'Give at least one valid staff role, each once');
  }
}

async function revokeSessions(tx: Queryable, personId: string, reason: string, at: Date): Promise<void> {
  await tx.query(`UPDATE auth_session SET revoked_at = $2, revoke_reason = $3 WHERE person_id = $1 AND revoked_at IS NULL`, [
    personId,
    at,
    reason,
  ]);
}
