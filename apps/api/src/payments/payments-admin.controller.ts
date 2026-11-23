import { randomUUID } from 'node:crypto';
import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { SandboxCollections, type Collections } from '@project/adapters';
import { CollectionsService } from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { COLLECTIONS } from '../infra.module.js';

const AssignBody = z.object({
  financeAccountReference: z.string().regex(/^FA-\d{6,}$/),
  note: z.string().min(5).max(500),
});
const ResolveBody = z.object({ note: z.string().min(5).max(500) });
const SimulateBody = z.object({
  accountNumber: z.string().regex(/^\d{10}$/),
  amountKobo: z.string().regex(/^[1-9]\d{0,17}$/),
  reference: z.string().regex(/^[A-Za-z0-9_\-.]{1,100}$/).optional(),
});

@Controller('admin/payments')
export class PaymentsAdminController {
  constructor(
    @Inject(CollectionsService) private readonly service: CollectionsService,
    @Inject(COLLECTIONS) private readonly collections: Collections,
  ) {}

  @StaffRoles('finance')
  @Get('exceptions')
  async exceptions() {
    const items = await this.service.openProblems();
    return { items: items.map((p) => ({ ...p, amount: p.amount.toString(), paidAt: p.paidAt.toISOString() })) };
  }

  @StaffRoles('finance')
  @Post('exceptions/:eventId/assign')
  @HttpCode(200)
  async assign(@Param('eventId') eventId: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const { financeAccountReference, note } = parseBody(AssignBody, body);
    try {
      return { entryId: await this.service.assignUnmatched(eventId, financeAccountReference, auth.sub, note) };
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @StaffRoles('finance')
  @Post('exceptions/:eventId/resolve')
  @HttpCode(204)
  async resolve(@Param('eventId') eventId: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const { note } = parseBody(ResolveBody, body);
    try {
      await this.service.resolveProblem(eventId, auth.sub, note);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Sandbox only: simulates a customer paying into a virtual account. Builds a webhook signed
   * exactly as the provider would and runs it through the same ingestion path. 404 with a real provider.
   */
  @StaffRoles('manager', 'finance')
  @Post('sandbox/simulate')
  @HttpCode(200)
  async simulate(@Body() body: unknown) {
    if (!(this.collections instanceof SandboxCollections)) throw new NotFoundException();
    const b = parseBody(SimulateBody, body);
    const { body: raw, headers } = this.collections.buildWebhook({
      reference: b.reference ?? `SIM-${randomUUID()}`,
      accountNumber: b.accountNumber,
      amountKobo: b.amountKobo,
      paidAt: new Date().toISOString(),
    });
    return this.service.ingestWebhook(raw, headers);
  }
}
