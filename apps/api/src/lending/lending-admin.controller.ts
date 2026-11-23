import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { kobo } from '@project/domain';
import {
  LendingError,
  LendingService,
  MOTORCYCLE_PLACEHOLDER_TIERS,
  NUMERIC_TERMS,
  type FinanceProductCode,
  type TierConfig,
} from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const PRODUCTS = [
  'motorcycle_ride_to_own',
  'phone_financing',
  'school_fee_financing',
  'business_equipment_finance',
  'purchase_and_deliver',
] as const;
const Product = z.enum(PRODUCTS);
const KoboString = z.string().regex(/^[1-9]\d{0,17}$/);
const Adjustments = z
  .object(Object.fromEntries(NUMERIC_TERMS.map((k) => [k, z.number().int().optional()])) as Record<string, z.ZodOptional<z.ZodNumber>>)
  .strict();

const ApproveBody = z.object({
  tier: z.string().regex(/^[A-Z]$/),
  assetPriceKobo: KoboString,
  adjustments: Adjustments.optional(),
  reason: z.string().min(5).max(500).optional(),
});
const ActivateBody = z.object({ startDate: z.iso.date().optional() });
const FeeBody = z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/), amountKobo: KoboString });
const WaiverBody = z.object({ reason: z.string().min(5).max(500) });
const DecideBody = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().min(2).max(500) });
const TierBody = z.object({ config: z.unknown(), note: z.string().max(500).optional() });
const LiveBody = z.object({ live: z.boolean() });
const DueBody = z.object({ asOf: z.iso.date().optional() });

/** Maps domain errors to HTTP so the console can show a precise reason. */
function http(err: unknown): never {
  if (err instanceof LendingError) {
    if (err.code === 'not_found' || err.code === 'tier_not_found') throw new NotFoundException(err.code);
    if (['invalid_status', 'deposit_not_paid', 'fee_not_open'].includes(err.code)) {
      throw new ConflictException({ error: err.code, message: err.message });
    }
    throw new BadRequestException({ error: err.code, message: err.message });
  }
  throw err;
}

@Controller('admin/lending')
export class LendingAdminController {
  constructor(
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  private async accountId(reference: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM finance_account WHERE reference = $1', [reference]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0].id;
  }

  // ----- products and tiers -----

  @StaffRoles('super_admin')
  @Post('products/:product/live')
  @HttpCode(200)
  async setLive(@Param('product') product: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const p = parseBody(z.enum([...PRODUCTS, 'dispatch']), product);
    const { live } = parseBody(LiveBody, body);
    await this.pool.query(
      'UPDATE product_setting SET live = $2, updated_by = $3, updated_at = now() WHERE product_code = $1',
      [p, live, auth.sub],
    );
    await this.pool.query(
      `INSERT INTO audit_event (actor_id, actor_kind, action, subject_type, subject_id, details)
       VALUES ($1, 'person', 'product.live_changed', 'product', $2, $3)`,
      [auth.sub, p, JSON.stringify({ live })],
    );
    return { product: p, live };
  }

  @StaffRoles('underwriter', 'manager')
  @Get('tiers/:product')
  async tiers(@Param('product') product: string) {
    return { tiers: await this.lending.currentTiers(parseBody(Product, product)) };
  }

  @StaffRoles('manager')
  @Post('tiers/:product/:tier')
  @HttpCode(201)
  async publish(@Param('product') product: string, @Param('tier') tier: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(TierBody, body);
    if (!/^[A-Z]$/.test(tier)) throw new BadRequestException('tier must be a single capital letter');
    return this.lending
      .publishTier(parseBody(Product, product), tier, b.config as TierConfig, {
        actorId: auth.sub,
        isPlaceholder: false,
        ...(b.note ? { note: b.note } : {}),
      })
      .catch(http);
  }

  /** Loads the clearly-labelled placeholder motorcycle tiers where no tier exists yet. */
  @StaffRoles('super_admin')
  @Post('tiers/seed-placeholders')
  @HttpCode(200)
  async seed(@Auth() auth: AccessClaims) {
    const existing = new Set((await this.lending.currentTiers('motorcycle_ride_to_own')).map((t) => t.tier));
    const created: string[] = [];
    for (const [tier, config] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
      if (existing.has(tier)) continue;
      await this.lending.publishTier('motorcycle_ride_to_own', tier, config, { actorId: auth.sub, isPlaceholder: true });
      created.push(tier);
    }
    return { created };
  }

  // ----- accounts -----

  @StaffRoles('underwriter', 'collections', 'finance', 'manager')
  @Get('accounts/:reference')
  async account(@Param('reference') reference: string) {
    return this.lending.statement(await this.accountId(reference)).catch(http);
  }

  /**
   * Approves on a tier. Inside the tier bounds: approved immediately (200).
   * Outside: creates a pending request for a manager to confirm from their own session (202).
   */
  @StaffRoles('underwriter')
  @Post('accounts/:reference/approve')
  @HttpCode(200)
  async approve(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(ApproveBody, body);
    const financeAccountId = await this.accountId(reference);
    try {
      const r = await this.lending.approve({
        financeAccountId,
        tier: b.tier,
        assetPriceKobo: b.assetPriceKobo,
        ...(b.adjustments ? { adjustments: b.adjustments } : {}),
        underwriterId: auth.sub,
      });
      return { status: 'approved', ...r };
    } catch (err) {
      if (err instanceof LendingError && err.code === 'needs_second_approver') {
        if (!b.reason) throw new BadRequestException({ error: 'reason_required', message: err.message });
        const requestId = await this.lending.requestApproval({
          kind: 'terms_out_of_bounds',
          financeAccountId,
          payload: { tier: b.tier, assetPriceKobo: b.assetPriceKobo, adjustments: b.adjustments ?? {} },
          reason: b.reason,
          requestedBy: auth.sub,
        });
        return { status: 'pending_second_approval', requestId, message: err.message };
      }
      http(err);
    }
  }

  @StaffRoles('manager')
  @Post('accounts/:reference/activate')
  @HttpCode(200)
  async activate(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const { startDate } = parseBody(ActivateBody, body);
    return this.lending.activate(await this.accountId(reference), auth.sub, startDate).catch(http);
  }

  @StaffRoles('finance', 'manager')
  @Post('accounts/:reference/fees')
  @HttpCode(201)
  async fee(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(FeeBody, body);
    const id = await this.lending.chargeFee(await this.accountId(reference), b.code, kobo(BigInt(b.amountKobo)), auth.sub);
    return { feeChargeId: id };
  }

  @StaffRoles('collections', 'finance')
  @Post('fees/:feeChargeId/waiver-requests')
  @HttpCode(201)
  async waiverRequest(@Param('feeChargeId') feeChargeId: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const { reason } = parseBody(WaiverBody, body);
    const { rows } = await this.pool.query<{ finance_account_id: string }>(
      `SELECT finance_account_id FROM fee_charge WHERE id = $1 AND status = 'open'`,
      [feeChargeId],
    );
    if (!rows[0]) throw new NotFoundException();
    const requestId = await this.lending.requestApproval({
      kind: 'fee_waiver',
      financeAccountId: rows[0].finance_account_id,
      payload: { feeChargeId },
      reason,
      requestedBy: auth.sub,
    });
    return { requestId };
  }

  // ----- approvals -----

  @StaffRoles('manager')
  @Get('approvals')
  async approvals() {
    return { pending: await this.lending.pendingApprovals() };
  }

  @StaffRoles('manager')
  @Post('approvals/:id/decide')
  @HttpCode(200)
  async decide(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(DecideBody, body);
    return this.lending.decideApproval(id, auth.sub, b.decision, b.note).catch(http);
  }

  // ----- jobs -----

  /** Run by the scheduler daily; callable by a super_admin to catch up a date. Safe to repeat. */
  @StaffRoles('super_admin')
  @Post('jobs/due-date')
  @HttpCode(200)
  async dueDate(@Body() body: unknown) {
    const { asOf } = parseBody(DueBody, body);
    return this.lending.runDueDate(asOf);
  }
}
