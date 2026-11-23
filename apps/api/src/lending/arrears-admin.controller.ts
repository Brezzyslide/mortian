import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { ArrearsService, LendingError, LendingService } from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const Repossession = z.object({
  reason: z.string().min(5).max(500),
  location: z.string().min(2).max(200),
  condition: z.string().min(2).max(500),
  photoRefs: z.array(z.string().max(500)).max(20).default([]),
});
const Release = z.object({ reason: z.string().min(5).max(500), handoverNote: z.string().max(500).optional() });
const Close = z.object({ reason: z.string().min(5).max(500) });
const Due = z.object({ asOf: z.iso.date().optional(), maxCatchUpDays: z.number().int().min(1).max(366).optional() });

function http(err: unknown): never {
  if (err instanceof LendingError) {
    if (err.code === 'not_found') throw new NotFoundException();
    throw new ConflictException({ error: err.code, message: err.message });
  }
  const pgErr = err as { constraint?: string };
  if (pgErr?.constraint === 'approval_request_one_pending') {
    throw new ConflictException({ error: 'request_already_pending' });
  }
  throw err;
}

@Controller('admin/lending')
export class ArrearsAdminController {
  constructor(
    @Inject(ArrearsService) private readonly arrears: ArrearsService,
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  private async accountId(reference: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM finance_account WHERE reference = $1', [reference]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0].id;
  }

  /** Collections worklist: every account with something overdue, most overdue first. */
  @StaffRoles('collections', 'manager')
  @Get('arrears')
  async list(@Query('status') status?: string) {
    const allowed = ['in_arrears', 'repossession_review', 'repossessed'];
    if (status && !allowed.includes(status)) throw new BadRequestException(`status must be one of ${allowed.join(', ')}`);
    const { rows } = await this.pool.query<{ id: string; reference: string; status: string; phone: string | null }>(
      `SELECT f.id, f.reference, f.status, p.phone FROM finance_account f JOIN person p ON p.id = f.person_id
        WHERE f.status = ANY($1)`,
      [status ? [status] : allowed],
    );
    const items = [];
    for (const r of rows) {
      const s = await this.lending.statement(r.id);
      items.push({
        reference: r.reference,
        status: r.status,
        phone: r.phone,
        daysOverdue: s.missed.daysOverdue,
        missedInstalments: s.missed.instalments,
        missedAmount: s.missed.amount,
        reactivationAmount: s.arrears?.reactivationAmount ?? 0n,
        cureDeadline: s.arrears?.cureDeadline ?? null,
        cureDeadlinePassed: s.arrears?.cureDeadlinePassed ?? false,
      });
    }
    items.sort((a, b) => b.daysOverdue - a.daysOverdue);
    return { items };
  }

  @StaffRoles('finance', 'manager')
  @Get('portfolio')
  async portfolio() {
    return this.arrears.portfolio();
  }

  @StaffRoles('collections')
  @Post('accounts/:reference/repossession-requests')
  @HttpCode(201)
  async repossess(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Repossession, body);
    const id = await this.accountId(reference);
    try {
      await this.lending.assertRecoveryAllowed('repossession', id);
      const requestId = await this.lending.requestApproval({
        kind: 'repossession',
        financeAccountId: id,
        payload: { location: b.location, condition: b.condition, photoRefs: b.photoRefs },
        reason: b.reason,
        requestedBy: auth.sub,
      });
      return { requestId };
    } catch (err) {
      http(err);
    }
  }

  @StaffRoles('collections')
  @Post('accounts/:reference/release-requests')
  @HttpCode(201)
  async release(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Release, body);
    const id = await this.accountId(reference);
    try {
      await this.lending.assertRecoveryAllowed('release', id);
      const requestId = await this.lending.requestApproval({
        kind: 'release',
        financeAccountId: id,
        payload: { handoverNote: b.handoverNote ?? null },
        reason: b.reason,
        requestedBy: auth.sub,
      });
      return { requestId };
    } catch (err) {
      http(err);
    }
  }

  @StaffRoles('collections', 'manager')
  @Post('accounts/:reference/close-requests')
  @HttpCode(201)
  async close(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Close, body);
    const id = await this.accountId(reference);
    try {
      await this.lending.assertRecoveryAllowed('close_recovered', id);
      const requestId = await this.lending.requestApproval({
        kind: 'close_recovered',
        financeAccountId: id,
        payload: {},
        reason: b.reason,
        requestedBy: auth.sub,
      });
      return { requestId };
    } catch (err) {
      http(err);
    }
  }

  /** Daily job: catches up every missed date in order, then today. Safe to repeat. */
  @StaffRoles('super_admin')
  @Post('jobs/daily')
  @HttpCode(200)
  async daily(@Body() body: unknown) {
    const b = parseBody(Due, body);
    try {
      return await this.arrears.runDaily(b.asOf, b.maxCatchUpDays);
    } catch (err) {
      throw new ConflictException({ error: 'job_refused', message: (err as Error).message });
    }
  }
}
