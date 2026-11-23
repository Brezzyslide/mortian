import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { CollectionsService, LendingService } from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const ApplyBody = z.object({
  productCode: z.enum([
    'motorcycle_ride_to_own',
    'phone_financing',
    'school_fee_financing',
    'business_equipment_finance',
    'purchase_and_deliver',
  ]),
});

/** The borrower's own view. A person only ever sees accounts they hold. */
@Controller('me')
export class MeAccountsController {
  constructor(
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  @Post('applications')
  @HttpCode(201)
  async apply(@Body() body: unknown, @Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    const { productCode } = parseBody(ApplyBody, body);
    const live = await this.pool.query<{ live: boolean }>('SELECT live FROM product_setting WHERE product_code = $1', [
      productCode,
    ]);
    if (!live.rows[0]?.live) throw new ForbiddenException({ error: 'product_not_live' });

    const person = await this.pool.query<{ full_name: string | null }>('SELECT full_name FROM person WHERE id = $1', [auth.sub]);
    const fa = await this.collections.openAccount(auth.sub, productCode);
    const va = await this.collections.provisionVirtualAccount(fa.id, person.rows[0]?.full_name ?? 'Customer');
    return {
      reference: fa.reference,
      status: 'applied',
      repaymentAccount: { accountNumber: va.accountNumber, bankName: va.bankName },
    };
  }

  @Get('accounts')
  async accounts(@Auth() auth: AccessClaims) {
    const { rows } = await this.pool.query<{ id: string; reference: string; product_code: string; status: string }>(
      'SELECT id, reference, product_code, status FROM finance_account WHERE person_id = $1 ORDER BY created_at DESC',
      [auth.sub],
    );
    const items = [];
    for (const r of rows) {
      const s = await this.lending.statement(r.id);
      items.push({
        reference: r.reference,
        productCode: r.product_code,
        status: r.status,
        outstanding: s.outstanding.total,
        missed: s.missed,
        next: s.next,
        paidOffPercent: s.paidOffPercent,
      });
    }
    return { accounts: items };
  }

  /** Full statement: what is owed, what was missed and by how much, every instalment. */
  @Get('accounts/:reference')
  async account(@Param('reference') reference: string, @Auth() auth: AccessClaims) {
    const { rows } = await this.pool.query<{ id: string }>(
      'SELECT id FROM finance_account WHERE reference = $1 AND person_id = $2',
      [reference, auth.sub],
    );
    // Same 404 whether the account does not exist or belongs to someone else.
    if (!rows[0]) throw new NotFoundException();
    const statement = await this.lending.statement(rows[0].id);
    const va = await this.pool.query<{ account_number: string; bank_name: string }>(
      'SELECT account_number, bank_name FROM virtual_account WHERE finance_account_id = $1',
      [rows[0].id],
    );
    return {
      ...statement,
      repaymentAccount: va.rows[0] ? { accountNumber: va.rows[0].account_number, bankName: va.rows[0].bank_name } : null,
    };
  }
}
