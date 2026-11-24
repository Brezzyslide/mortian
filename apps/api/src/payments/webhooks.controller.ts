import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { InvalidWebhookPayloadError, InvalidWebhookSignatureError, type Checkout, type Collections } from '@project/adapters';
import { DispatchService } from '@project/dispatch';
import { CollectionsService, LendingService } from '@project/finance';
import { applyAfterPayment } from './apply-after-payment.js';
import { Public } from '../auth/decorators.js';
import { CHECKOUT, COLLECTIONS } from '../infra.module.js';

@Controller('webhooks')
export class WebhooksController {
  private readonly log = new Logger('Webhooks');

  constructor(
    @Inject(COLLECTIONS) private readonly collections: Collections,
    @Inject(CollectionsService) private readonly service: CollectionsService,
    @Inject(LendingService) private readonly lending: LendingService,
    @Inject(CHECKOUT) private readonly checkout: Checkout,
    @Inject(DispatchService) private readonly dispatch: DispatchService,
  ) {}

  /** One-off payments (delivery fares). Same rules as collections: verify, then exactly once. */
  @Public()
  @Post('checkout/:provider')
  @HttpCode(200)
  async receiveCheckout(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    if (provider !== this.checkout.info.provider) throw new NotFoundException();
    if (!req.rawBody) throw new BadRequestException();
    try {
      const r = await this.dispatch.paymentReceived(req.rawBody, req.headers);
      return { received: true, outcome: r.outcome };
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        this.log.warn(`Rejected ${provider} checkout webhook with bad signature from ${req.ip}`);
        throw new UnauthorizedException();
      }
      if (err instanceof InvalidWebhookPayloadError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  /**
   * Provider → platform. Signature is verified over the exact raw bytes before anything is stored.
   * Returns 200 for every accepted delivery (including duplicates and unmatched money) so the
   * provider stops retrying; 401 for a bad signature; 400 for a malformed body.
   */
  @Public()
  @Post('collections/:provider')
  @HttpCode(200)
  async receiveCollections(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    if (provider !== this.collections.info.provider) throw new NotFoundException();
    if (!req.rawBody) throw new BadRequestException();
    try {
      const r = await this.service.ingestWebhook(req.rawBody, req.headers);
      await applyAfterPayment(this.lending, r);
      return { received: true, outcome: r.outcome };
    } catch (err) {
      if (err instanceof InvalidWebhookSignatureError) {
        this.log.warn(`Rejected ${provider} webhook with bad signature from ${req.ip}`);
        throw new UnauthorizedException();
      }
      if (err instanceof InvalidWebhookPayloadError) throw new BadRequestException(err.message);
      throw err;
    }
  }
}
