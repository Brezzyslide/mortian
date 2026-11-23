import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import pg from 'pg';
import { PRODUCT_INFO } from '@project/domain';
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

const ProfileBody = z.object({
  fullName: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[\p{L}\p{M}][\p{L}\p{M}' .-]*$/u, 'letters, spaces, apostrophes, dots and hyphens only')
    .refine((n) => n.includes(' '), 'first and last name'),
});

/** Statuses after which the name on record is on a contract and can only be changed by staff. */
const NAME_LOCKED = `status NOT IN ('applied', 'declined', 'withdrawn')`;

/** The borrower's own view. A person only ever sees accounts they hold. */
@Controller('me')
export class MeAccountsController {
  constructor(
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(CollectionsService) private readonly collections: CollectionsService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  /** Products a customer can apply for right now. */
  @Get('products')
  async products(@Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    const { rows } = await this.pool.query<{ product_code: keyof typeof PRODUCT_INFO }>(
      `SELECT product_code FROM product_setting WHERE live AND product_code <> 'dispatch' ORDER BY product_code`,
    );
    return { products: rows.filter((r) => r.product_code in PRODUCT_INFO).map((r) => ({ productCode: r.product_code, ...PRODUCT_INFO[r.product_code] })) };
  }

  /**
   * Sets the customer's full name. Allowed until an application is approved: from then on the
   * name is on terms and contracts, so a change goes through staff.
   */
  @Post('profile')
  @HttpCode(200)
  async profile(@Body() body: unknown, @Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    const { fullName } = parseBody(ProfileBody, body);
    const name = fullName.replace(/\s+/g, ' ');
    // Name change and its audit record in one statement: both happen or neither does.
    const r = await this.pool.query(
      `WITH u AS (
         UPDATE person SET full_name = $2
          WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM finance_account WHERE person_id = $1 AND ${NAME_LOCKED})
         RETURNING id)
       INSERT INTO audit_event (actor_id, actor_kind, action, subject_type, subject_id)
       SELECT id, 'person', 'customer.name_set', 'person', id::text FROM u`,
      [auth.sub, name],
    );
    if (r.rowCount === 0) throw new ConflictException({ error: 'name_locked', message: 'Your name is on an approved agreement. Contact us to change it.' });
    return { fullName: name };
  }

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
    const fullName = person.rows[0]?.full_name;
    if (!fullName) throw new ConflictException({ error: 'profile_incomplete', message: 'Add your full name before applying.' });
    // One open application per product; a person-level advisory lock closes the double-tap race.
    const client = await this.pool.connect();
    let fa: { id: string; reference: string };
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('apply:' || $1))`, [auth.sub]);
      const open = await client.query(`SELECT reference FROM finance_account WHERE person_id = $1 AND product_code = $2 AND status = 'applied'`, [
        auth.sub,
        productCode,
      ]);
      if (open.rows[0]) {
        await client.query('ROLLBACK');
        throw new ConflictException({ error: 'application_open', reference: open.rows[0].reference });
      }
      fa = await this.collections.openAccount(auth.sub, productCode, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    const va = await this.collections.provisionVirtualAccount(fa.id, fullName);
    return {
      reference: fa.reference,
      status: 'applied',
      repaymentAccount: { accountNumber: va.accountNumber, bankName: va.bankName },
    };
  }

  /** Withdraws an application that has not been approved yet. */
  @Post('applications/:reference/withdraw')
  @HttpCode(200)
  async withdraw(@Param('reference') reference: string, @Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    const r = await this.pool.query(
      `WITH u AS (
         UPDATE finance_account SET status = 'withdrawn'
          WHERE reference = $1 AND person_id = $2 AND status = 'applied'
         RETURNING reference, person_id)
       INSERT INTO audit_event (actor_id, actor_kind, action, subject_type, subject_id)
       SELECT person_id, 'person', 'application.withdrawn', 'finance_account', reference FROM u`,
      [reference, auth.sub],
    );
    if (r.rowCount === 0) {
      const exists = await this.pool.query('SELECT 1 FROM finance_account WHERE reference = $1 AND person_id = $2', [reference, auth.sub]);
      if (!exists.rows[0]) throw new NotFoundException();
      throw new ConflictException({ error: 'not_withdrawable', message: 'This application has already been approved. Contact us to cancel it.' });
    }
    return { reference, status: 'withdrawn' };
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
        productName: PRODUCT_INFO[r.product_code as keyof typeof PRODUCT_INFO]?.name ?? r.product_code,
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
