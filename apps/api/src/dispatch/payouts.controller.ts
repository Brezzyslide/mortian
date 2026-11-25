import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, ForbiddenException, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Query } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { SandboxPayouts, type Payouts } from '@project/adapters';
import { PayoutError, PayoutService, PLACEHOLDER_PAYOUT_SETTINGS } from '@project/dispatch';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PAYOUTS } from '../infra.module.js';

const STATUS: Partial<Record<PayoutError['code'], number>> = {
  not_a_rider: HttpStatus.NOT_FOUND,
  not_found: HttpStatus.NOT_FOUND,
  not_configured: HttpStatus.SERVICE_UNAVAILABLE,
  account_not_found: HttpStatus.UNPROCESSABLE_ENTITY,
  same_person: HttpStatus.FORBIDDEN,
};

@Catch(PayoutError)
export class PayoutErrorFilter implements ExceptionFilter {
  catch(err: PayoutError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(STATUS[err.code] ?? HttpStatus.CONFLICT).json({ error: err.code, message: err.message });
  }
}

const BankAccount = z.object({ bankCode: z.string().regex(/^[0-9A-Za-z]{3,10}$/), accountNumber: z.string().regex(/^\d{10}$/) });
const Withdraw = z.object({ amountKobo: z.string().regex(/^[1-9]\d{0,17}$/).optional() });
const LoanShare = z.object({ bps: z.number().int().min(0).max(10_000) });
const Review = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().trim().min(3).max(300) });
const Kobo = z.string().regex(/^\d{1,18}$/).transform((s) => BigInt(s));
const Settings = z.object({
  weeklyWeekday: z.number().int().min(1).max(7),
  minPayoutKobo: Kobo,
  instantEnabled: z.boolean(),
  instantFeePaidByRider: z.boolean(),
  instantDailyLimitKobo: Kobo,
  maxLoanShareBps: z.number().int().min(0).max(10_000),
  coolingOffHours: z.number().int().min(0).max(168),
});
const customer = (a: AccessClaims) => {
  if (a.kind !== 'customer') throw new ForbiddenException();
  return a.sub;
};

@Controller()
export class PayoutsController {
  constructor(
    @Inject(PayoutService) private readonly svc: PayoutService,
    @Inject(PAYOUTS) private readonly provider: Payouts,
  ) {}

  // ----- riders -----
  @Get('rider/payouts')
  summary(@Auth() auth: AccessClaims) {
    return this.svc.summary(customer(auth));
  }

  @Get('rider/banks')
  async banks(@Auth() auth: AccessClaims) {
    customer(auth);
    return { banks: await this.svc.banks() };
  }

  @Post('rider/bank-account')
  @HttpCode(200)
  link(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(BankAccount, body);
    return this.svc.linkBankAccount(customer(auth), b.bankCode, b.accountNumber);
  }

  @Post('rider/payouts')
  @HttpCode(201)
  async withdraw(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Withdraw, body);
    return { payouts: await this.svc.requestInstant(customer(auth), b.amountKobo ? BigInt(b.amountKobo) : undefined) };
  }

  @Post('rider/loan-share')
  @HttpCode(204)
  async loanShare(@Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.svc.setLoanShare(customer(auth), parseBody(LoanShare, body).bps);
  }

  // ----- finance -----
  @StaffRoles('finance', 'manager')
  @Get('admin/payouts')
  async list(@Query('status') status?: string) {
    return { payouts: await this.svc.list(status ? parseBody(z.enum(['pending', 'sent', 'succeeded', 'failed']), status) : undefined) };
  }

  @StaffRoles('finance', 'manager')
  @Get('admin/payouts/bank-accounts/review')
  async forReview() {
    return { accounts: await this.svc.accountsForReview() };
  }

  @StaffRoles('finance', 'manager')
  @Post('admin/payouts/bank-accounts/:id/review')
  @HttpCode(204)
  async review(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Review, body);
    await this.svc.reviewBankAccount(parseBody(z.uuid(), id), auth.sub, b.decision, b.note);
  }

  @StaffRoles('finance', 'manager')
  @Get('admin/payouts/settings')
  async settings() {
    const s = await this.svc.settings();
    return { settings: s && { ...s, minPayoutKobo: String(s.minPayoutKobo), instantDailyLimitKobo: String(s.instantDailyLimitKobo) } };
  }

  @StaffRoles('manager')
  @Post('admin/payouts/settings')
  @HttpCode(201)
  async setSettings(@Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.svc.setSettings(parseBody(Settings, body), auth.sub);
    return { saved: true };
  }

  @StaffRoles('super_admin')
  @Post('admin/payouts/settings/seed-placeholder')
  @HttpCode(201)
  async seed(@Auth() auth: AccessClaims) {
    if (await this.svc.settings()) return { created: false };
    await this.svc.setSettings(PLACEHOLDER_PAYOUT_SETTINGS, auth.sub, true);
    return { created: true };
  }

  /** Runs the weekly payout now (normally the daily job does it on the set weekday). */
  @StaffRoles('finance', 'manager')
  @Post('admin/payouts/run-weekly')
  @HttpCode(200)
  runWeekly(@Body() body: unknown) {
    const { day } = parseBody(z.object({ day: z.iso.date().optional() }), body ?? {});
    return this.svc.runWeekly(day);
  }

  /**
   * Staging only: plays the provider's transfer outcome for a payout, so the flow can be tested
   * end to end without a real provider. Refused unless the sandbox adapter is in use.
   */
  @StaffRoles('finance')
  @Post('admin/payouts/sandbox/:reference/outcome')
  @HttpCode(200)
  async simulate(@Param('reference') reference: string, @Body() body: unknown) {
    if (!(this.provider instanceof SandboxPayouts)) throw new NotFoundException();
    const { status } = parseBody(z.object({ status: z.enum(['succeeded', 'failed']) }), body);
    const w = this.provider.buildWebhook({ reference: parseBody(z.string().regex(/^PO-\d{6,}$/), reference), status, eventId: `sim-${Date.now()}` });
    return this.svc.transferOutcome(w.body, w.headers);
  }
}
