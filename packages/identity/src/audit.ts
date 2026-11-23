import type { Queryable } from './db.js';

export interface AuditInput {
  readonly actorId?: string | null;
  readonly actorKind: 'person' | 'system' | 'anonymous';
  readonly action: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** Never put secrets, OTP codes, passwords or full ID numbers in details. */
  readonly details?: Record<string, unknown>;
}

export async function recordAudit(db: Queryable, e: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_event (actor_id, actor_kind, action, subject_type, subject_id, ip, user_agent, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.actorId ?? null,
      e.actorKind,
      e.action,
      e.subjectType ?? null,
      e.subjectId ?? null,
      e.ip ?? null,
      e.userAgent ?? null,
      JSON.stringify(e.details ?? {}),
    ],
  );
}
