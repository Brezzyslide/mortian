import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import pg from 'pg';
import { AssetError, AssetService, ASSET_KINDS, LendingError, LendingService } from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const STATUS: Record<AssetError['code'], number> = {
  not_found: HttpStatus.NOT_FOUND,
  invalid_identifier: HttpStatus.BAD_REQUEST,
  duplicate: HttpStatus.CONFLICT,
  invalid_status: HttpStatus.CONFLICT,
  wrong_kind: HttpStatus.CONFLICT,
  account_has_asset: HttpStatus.CONFLICT,
  no_asset: HttpStatus.CONFLICT,
};

/** Asset errors can come from asset actions or from inside lending steps (release, sale). */
@Catch(AssetError)
export class AssetErrorFilter implements ExceptionFilter {
  catch(err: AssetError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(STATUS[err.code] ?? 400).json({ error: err.code, message: err.message });
  }
}

/**
 * Safety net: a lending refusal that a controller did not map itself is a 409 (or 404), never a
 * 500. Controllers that map errors explicitly are unaffected.
 */
@Catch(LendingError)
export class LendingErrorFilter implements ExceptionFilter {
  catch(err: LendingError, host: ArgumentsHost): void {
    const status = err.code === 'not_found' || err.code === 'tier_not_found' ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
    host.switchToHttp().getResponse<Response>().status(status).json({ error: err.code, message: err.message });
  }
}

const Uuid = z.uuid();
const Text = (min: number, max: number) => z.string().trim().min(min).max(max);
const Register = z.object({
  kind: z.enum(ASSET_KINDS),
  make: Text(1, 60),
  model: Text(1, 60),
  year: z.number().int().min(1990).max(2100).nullable().optional(),
  idKind: z.enum(['chassis', 'imei', 'serial']),
  identifier: Text(5, 60),
  engineNumber: Text(3, 60).nullable().optional(),
  plateNumber: Text(3, 20).nullable().optional(),
  costKobo: z.string().regex(/^\d{1,18}$/),
  location: Text(2, 200),
});
const Assign = z.object({ reference: z.string().regex(/^FA-\d{6,}$/) });
const Note = z.object({ note: Text(5, 500) });
const Move = z.object({ location: Text(2, 200), note: Text(0, 500).optional() });
const ListQuery = z.object({
  status: z.enum(['in_stock', 'assigned', 'with_customer', 'recovered', 'for_sale', 'sold', 'paid_off', 'title_transferred', 'written_off']).optional(),
  q: z.string().max(60).optional(),
});
const SaleRequest = z.object({
  priceKobo: z.string().regex(/^[1-9]\d{0,17}$/),
  buyerName: Text(3, 120),
  buyerPhone: Text(7, 20).nullable().optional(),
  reason: Text(5, 500),
});

const READERS = ['underwriter', 'collections', 'dispatch_ops', 'finance', 'manager'] as const;

@Controller('admin')
export class AssetsController {
  constructor(
    @Inject(AssetService) private readonly assets: AssetService,
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  private async accountId(reference: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM finance_account WHERE reference = $1', [reference]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0].id;
  }

  @StaffRoles(...READERS)
  @Get('assets')
  async list(@Query() query: unknown) {
    const q = parseBody(ListQuery, query);
    return { assets: await this.assets.list(q) };
  }

  @StaffRoles(...READERS)
  @Get('assets/:id')
  async get(@Param('id') id: string) {
    return this.assets.get(parseBody(Uuid, id));
  }

  @StaffRoles('dispatch_ops', 'manager')
  @Post('assets')
  @HttpCode(201)
  async register(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Register, body);
    return this.assets.register({ ...b, costKobo: BigInt(b.costKobo) }, auth.sub);
  }

  @StaffRoles('underwriter', 'dispatch_ops', 'manager')
  @Post('assets/:id/assign')
  @HttpCode(204)
  async assign(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const { reference } = parseBody(Assign, body);
    await this.assets.assign(parseBody(Uuid, id), await this.accountId(reference), auth.sub);
  }

  @StaffRoles('underwriter', 'dispatch_ops', 'manager')
  @Post('assets/:id/unassign')
  @HttpCode(204)
  async unassign(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.assets.unassign(parseBody(Uuid, id), auth.sub, parseBody(Note, body).note);
  }

  @StaffRoles('dispatch_ops', 'collections', 'manager')
  @Post('assets/:id/move')
  @HttpCode(204)
  async move(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Move, body);
    await this.assets.move(parseBody(Uuid, id), b.location, auth.sub, b.note || null);
  }

  @StaffRoles('manager')
  @Post('assets/:id/title-transferred')
  @HttpCode(204)
  async title(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.assets.titleTransferred(parseBody(Uuid, id), auth.sub, parseBody(Note, body).note);
  }

  @StaffRoles('manager')
  @Post('assets/:id/write-off')
  @HttpCode(204)
  async writeOff(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.assets.writeOff(parseBody(Uuid, id), auth.sub, parseBody(Note, body).note);
  }

  /** The asset financed under an account (null when none is assigned yet). */
  @StaffRoles(...READERS)
  @Get('lending/accounts/:reference/asset')
  async forAccount(@Param('reference') reference: string) {
    return { asset: await this.assets.forAccount(await this.accountId(reference)) };
  }

  /**
   * Proposes selling a recovered asset of a closed account. A manager other than the requester
   * approves it under approvals; approval posts the proceeds to the ledger.
   */
  @StaffRoles('collections', 'manager')
  @Post('lending/accounts/:reference/asset-sale-requests')
  @HttpCode(201)
  async saleRequest(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(SaleRequest, body);
    const id = await this.accountId(reference);
    const payload = { priceKobo: b.priceKobo, buyerName: b.buyerName, buyerPhone: b.buyerPhone ?? null };
    await this.lending.assertRecoveryAllowed('asset_sale', id, payload);
    const requestId = await this.lending.requestApproval({ kind: 'asset_sale', financeAccountId: id, payload, reason: b.reason, requestedBy: auth.sub });
    return { requestId };
  }
}
