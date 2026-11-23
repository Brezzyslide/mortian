import { Controller, Get, Inject, NotFoundException, Query } from '@nestjs/common';
import pg from 'pg';
import { SandboxMessaging, type Messaging } from '@project/adapters';
import { StaffRoles } from '../auth/decorators.js';
import { MESSAGING, PG_POOL } from '../infra.module.js';

@Controller('admin')
export class AdminController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(MESSAGING) private readonly messaging: Messaging,
  ) {}

  /** Recent audit events, newest first. */
  @StaffRoles('manager')
  @Get('audit')
  async audit(@Query('limit') limitRaw?: string, @Query('subjectId') subjectId?: string) {
    const limit = Math.min(Math.max(Number(limitRaw) || 50, 1), 200);
    const { rows } = await this.pool.query(
      `SELECT id::text, occurred_at, actor_id, actor_kind, action, subject_type, subject_id, details
         FROM audit_event
        WHERE ($2::text IS NULL OR subject_id = $2)
        ORDER BY id DESC LIMIT $1`,
      [limit, subjectId ?? null],
    );
    return { events: rows };
  }

  /**
   * Sandbox only: messages the platform would have sent, so staging testers can use OTPs
   * without an SMS provider. Returns 404 whenever a real messaging provider is configured.
   */
  @StaffRoles('manager')
  @Get('sandbox/messages')
  sandboxMessages(@Query('to') to?: string) {
    if (!(this.messaging instanceof SandboxMessaging)) throw new NotFoundException();
    const list = this.messaging.sent.filter((m) => !to || m.to === to).slice(-50).reverse();
    return { mode: 'sandbox', messages: list };
  }
}
