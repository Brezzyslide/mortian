import { ArgumentsHost, Body, Catch, Controller, ExceptionFilter, ForbiddenException, Get, HttpCode, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { DispatchError, DispatchService, PLACEHOLDER_PRICING } from '@project/dispatch';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';

const STATUS: Partial<Record<DispatchError['code'], number>> = {
  not_found: HttpStatus.NOT_FOUND,
  not_a_rider: HttpStatus.NOT_FOUND,
  not_live: HttpStatus.SERVICE_UNAVAILABLE,
  no_pricing: HttpStatus.SERVICE_UNAVAILABLE,
  invalid_phone: HttpStatus.BAD_REQUEST,
  code_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  code_locked: HttpStatus.LOCKED,
  same_person: HttpStatus.FORBIDDEN,
  own_job: HttpStatus.FORBIDDEN,
};

@Catch(DispatchError)
export class DispatchErrorFilter implements ExceptionFilter {
  catch(err: DispatchError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(STATUS[err.code] ?? HttpStatus.CONFLICT).json({ error: err.code, message: err.message });
  }
}

const Place = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), address: z.string().trim().min(3).max(300) });
const At = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Quote = z.object({ pickup: Place, dropoff: Place });
const Book = z.object({
  quoteId: z.uuid(),
  paymentMethod: z.enum(['cash', 'in_app']),
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().min(7).max(20),
  packageNote: z.string().trim().max(300).nullable().optional(),
});
const Reason = z.object({ reason: z.string().trim().min(3).max(300) });
const Apply = z.union([
  z.object({ kind: z.literal('own_bike') }),
  z.object({ kind: z.literal('financed'), financeReference: z.string().regex(/^FA-\d{6,}$/) }),
]);
const Online = z.object({ online: z.boolean(), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional() });
const Code = z.object({ code: z.string().regex(/^\d{6}$/), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
const Decision = z.object({ decision: z.enum(['active', 'suspended']), note: z.string().trim().min(3).max(300) });
const Kobo = z.string().regex(/^\d{1,18}$/).transform((s) => BigInt(s));
const Pricing = z.object({
  baseFareKobo: Kobo,
  perKmKobo: Kobo,
  minFareKobo: Kobo,
  commissionBps: z.number().int().min(0).max(5000),
  cashDebtLimitKobo: Kobo,
  searchRadiusM: z.number().int().min(500).max(50_000),
});
const Ref = z.string().regex(/^DJ-\d{6,}$/);
const customer = (a: AccessClaims) => {
  if (a.kind !== 'customer') throw new ForbiddenException();
  return a.sub;
};
const asText = (p: Awaited<ReturnType<DispatchService['currentPricing']>>) =>
  p && { ...p, baseFareKobo: String(p.baseFareKobo), perKmKobo: String(p.perKmKobo), minFareKobo: String(p.minFareKobo), cashDebtLimitKobo: String(p.cashDebtLimitKobo) };

@Controller()
export class DispatchController {
  constructor(@Inject(DispatchService) private readonly svc: DispatchService) {}

  // ----- customers -----
  @Post('me/dispatch/quotes')
  @HttpCode(201)
  quote(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Quote, body);
    return this.svc.quote(customer(auth), b.pickup, b.dropoff);
  }

  @Post('me/dispatch/jobs')
  @HttpCode(201)
  book(@Body() body: unknown, @Auth() auth: AccessClaims) {
    return this.svc.book(customer(auth), parseBody(Book, body));
  }

  @Get('me/dispatch/jobs')
  async mine(@Auth() auth: AccessClaims) {
    return { jobs: await this.svc.customerJobs(customer(auth)) };
  }

  @Get('me/dispatch/jobs/:ref')
  one(@Param('ref') ref: string, @Auth() auth: AccessClaims) {
    return this.svc.customerView(customer(auth), parseBody(Ref, ref));
  }

  @Post('me/dispatch/jobs/:ref/cancel')
  @HttpCode(200)
  cancel(@Param('ref') ref: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    return this.svc.cancelByCustomer(customer(auth), parseBody(Ref, ref), parseBody(Reason, body).reason);
  }

  // ----- riders (customer sessions with a rider record) -----
  @Post('me/rider')
  @HttpCode(201)
  apply(@Body() body: unknown, @Auth() auth: AccessClaims) {
    return this.svc.applyAsRider(customer(auth), parseBody(Apply, body));
  }

  @Get('me/rider')
  me(@Auth() auth: AccessClaims) {
    return this.svc.rider(customer(auth));
  }

  @Post('rider/online')
  @HttpCode(204)
  async online(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Online, body);
    await this.svc.setOnline(customer(auth), b.online, b.lat !== undefined && b.lng !== undefined ? { lat: b.lat, lng: b.lng } : undefined);
  }

  @Post('rider/location')
  @HttpCode(204)
  async location(@Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.svc.updateLocation(customer(auth), parseBody(At, body));
  }

  @Get('rider/jobs/available')
  available(@Auth() auth: AccessClaims) {
    return this.svc.availableJobs(customer(auth));
  }

  @Get('rider/jobs/current')
  async current(@Auth() auth: AccessClaims) {
    return { job: await this.svc.currentJob(customer(auth)) };
  }

  @Post('rider/jobs/:ref/accept')
  @HttpCode(200)
  accept(@Param('ref') ref: string, @Auth() auth: AccessClaims) {
    return this.svc.accept(customer(auth), parseBody(Ref, ref));
  }

  @Post('rider/jobs/:ref/pickup')
  @HttpCode(200)
  pickup(@Param('ref') ref: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Code, body);
    return this.svc.pickup(customer(auth), parseBody(Ref, ref), b.code, b);
  }

  @Post('rider/jobs/:ref/deliver')
  @HttpCode(200)
  deliver(@Param('ref') ref: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Code, body);
    return this.svc.deliver(customer(auth), parseBody(Ref, ref), b.code, b);
  }

  @Get('rider/earnings')
  earnings(@Auth() auth: AccessClaims) {
    return this.svc.earnings(customer(auth));
  }

  // ----- staff -----
  @StaffRoles('dispatch_ops', 'manager')
  @Get('admin/dispatch/riders')
  async riders(@Query('status') status?: string) {
    return { riders: await this.svc.riders(status ? parseBody(z.enum(['pending', 'active', 'suspended']), status) : undefined) };
  }

  @StaffRoles('dispatch_ops', 'manager')
  @Post('admin/dispatch/riders/:personId/decision')
  @HttpCode(204)
  async decide(@Param('personId') personId: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Decision, body);
    await this.svc.decideRider(parseBody(z.uuid(), personId), auth.sub, b.decision, b.note);
  }

  @StaffRoles('dispatch_ops', 'manager', 'finance')
  @Get('admin/dispatch/jobs')
  async jobs(@Query('status') status?: string) {
    return { jobs: await this.svc.jobs(status ? parseBody(z.enum(['awaiting_payment', 'searching', 'accepted', 'picked_up', 'delivered', 'cancelled']), status) : undefined) };
  }

  @StaffRoles('dispatch_ops', 'manager', 'finance')
  @Get('admin/dispatch/jobs/:ref/events')
  async events(@Param('ref') ref: string) {
    return { events: await this.svc.jobEvents(parseBody(Ref, ref)) };
  }

  @StaffRoles('dispatch_ops', 'manager')
  @Post('admin/dispatch/jobs/:ref/cancel')
  @HttpCode(200)
  staffCancel(@Param('ref') ref: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    return this.svc.cancelByStaff(parseBody(Ref, ref), auth.sub, parseBody(Reason, body).reason);
  }

  @StaffRoles('dispatch_ops', 'manager', 'finance')
  @Get('admin/dispatch/pricing')
  async pricing() {
    return { pricing: asText(await this.svc.currentPricing()) };
  }

  @StaffRoles('manager')
  @Post('admin/dispatch/pricing')
  @HttpCode(201)
  async setPricing(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const id = await this.svc.setPricing(parseBody(Pricing, body), auth.sub);
    return { id };
  }

  @StaffRoles('super_admin')
  @Post('admin/dispatch/pricing/seed-placeholder')
  @HttpCode(201)
  async seed(@Auth() auth: AccessClaims) {
    if (await this.svc.currentPricing()) return { created: false };
    await this.svc.setPricing(PLACEHOLDER_PRICING, auth.sub, true);
    return { created: true };
  }
}
