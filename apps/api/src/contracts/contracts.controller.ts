import {
  BadRequestException,
  Body,
  Catch,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import pg from 'pg';
import type { DocumentStore } from '@project/adapters';
import { ContractError, ContractsService } from '@project/contracts';
import type { AccessClaims } from '@project/identity';
import { Auth, Public, StaffRoles } from '../auth/decorators.js';
import { parseBody, requestContext } from '../http.js';
import { DOCUMENTS, PG_POOL } from '../infra.module.js';

const STATUS: Partial<Record<ContractError['code'], HttpStatus>> = {
  not_found: HttpStatus.NOT_FOUND,
  link_invalid: HttpStatus.GONE,
  invalid_status: HttpStatus.CONFLICT,
  not_your_turn: HttpStatus.CONFLICT,
  otp_rate_limited: HttpStatus.TOO_MANY_REQUESTS,
  otp_locked: HttpStatus.UNAUTHORIZED,
  otp_invalid: HttpStatus.UNAUTHORIZED,
  otp_required: HttpStatus.UNAUTHORIZED,
  document_changed: HttpStatus.CONFLICT,
  same_device_as_borrower: HttpStatus.FORBIDDEN,
  not_configured: HttpStatus.SERVICE_UNAVAILABLE,
};

@Catch(ContractError)
export class ContractErrorFilter implements ExceptionFilter {
  catch(err: ContractError, host: ArgumentsHost): void {
    const status = STATUS[err.code] ?? HttpStatus.BAD_REQUEST;
    const body = err.message !== err.code ? { error: err.code, message: err.message } : { error: err.code };
    host.switchToHttp().getResponse<Response>().status(status).json(body);
  }
}

const Product = z.enum(['motorcycle_ride_to_own', 'phone_financing', 'school_fee_financing', 'business_equipment_finance', 'purchase_and_deliver']);
const TemplateBody = z.object({ title: z.string().min(3).max(200), body: z.string().min(20).max(100_000) });
const Approve = z.object({ legalReviewNote: z.string().min(5).max(1000) });
const Guarantor = z.object({ fullName: z.string().min(2).max(120), phone: z.string().min(7).max(20), relationship: z.string().min(2).max(60) });
const Reason = z.object({ reason: z.string().min(5).max(500) });

/** Staff side: templates, guarantors, issuing, countersigning, archive downloads. */
@Controller('admin/contracts')
export class ContractsAdminController {
  constructor(
    @Inject(ContractsService) private readonly contracts: ContractsService,
    @Inject(DOCUMENTS) private readonly documents: DocumentStore,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  private async accountId(reference: string) {
    const { rows } = await this.pool.query<{ id: string }>('SELECT id FROM finance_account WHERE reference = $1', [reference]);
    if (!rows[0]) throw new NotFoundException();
    return rows[0].id;
  }

  @StaffRoles('underwriter', 'manager')
  @Get('templates/:product')
  async templates(@Param('product') product: string) {
    return { templates: await this.contracts.templates(parseBody(Product, product)) };
  }

  @StaffRoles('manager')
  @Post('templates/:product')
  @HttpCode(201)
  async createTemplate(@Param('product') product: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(TemplateBody, body);
    return this.contracts.createTemplate(parseBody(Product, product), b.title, b.body, auth.sub);
  }

  /** A different manager approves, recording who reviewed the wording legally. */
  @StaffRoles('manager')
  @Post('templates/:id/approve')
  @HttpCode(204)
  async approveTemplate(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.contracts.approveTemplate(id, auth.sub, parseBody(Approve, body).legalReviewNote);
  }

  @StaffRoles('super_admin')
  @Post('seed-placeholder-template')
  @HttpCode(200)
  async seed(@Auth() auth: AccessClaims) {
    return { created: await this.contracts.seedPlaceholderTemplate(auth.sub) };
  }

  @StaffRoles('underwriter', 'collections', 'manager')
  @Get('accounts/:reference/guarantors')
  async guarantors(@Param('reference') reference: string) {
    return { guarantors: await this.contracts.guarantors(await this.accountId(reference)) };
  }

  @StaffRoles('underwriter')
  @Post('accounts/:reference/guarantors')
  @HttpCode(201)
  async addGuarantor(@Param('reference') reference: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    return { id: await this.contracts.addGuarantor(await this.accountId(reference), parseBody(Guarantor, body), auth.sub) };
  }

  @StaffRoles('underwriter')
  @Delete('guarantors/:id')
  @HttpCode(204)
  async removeGuarantor(@Param('id') id: string, @Auth() auth: AccessClaims) {
    await this.contracts.removeGuarantor(id, auth.sub);
  }

  @StaffRoles('underwriter', 'collections', 'finance', 'manager')
  @Get('accounts/:reference')
  async forAccount(@Param('reference') reference: string) {
    return { contracts: await this.contracts.forAccount(await this.accountId(reference)) };
  }

  @StaffRoles('underwriter')
  @Post('accounts/:reference/issue')
  @HttpCode(201)
  async issue(@Param('reference') reference: string, @Auth() auth: AccessClaims) {
    try {
      return await this.contracts.issue(await this.accountId(reference), auth.sub);
    } catch (err) {
      if ((err as { constraint?: string }).constraint === 'contract_one_live') {
        throw new ConflictException({ error: 'contract_in_progress', message: 'Revoke the contract in progress first' });
      }
      throw err;
    }
  }

  @StaffRoles('manager')
  @Post(':id/countersign')
  @HttpCode(200)
  async countersign(@Param('id') id: string, @Auth() auth: AccessClaims, @Req() req: Request) {
    const name = (await this.pool.query<{ full_name: string | null; email: string }>('SELECT full_name, email FROM person WHERE id = $1', [auth.sub])).rows[0]!;
    return this.contracts.countersign(id, auth.sub, name.full_name ?? name.email, requestContext(req));
  }

  @StaffRoles('manager')
  @Post(':id/revoke')
  @HttpCode(204)
  async revoke(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.contracts.revoke(id, auth.sub, parseBody(Reason, body).reason);
  }

  @StaffRoles('underwriter', 'manager')
  @Post(':id/resend-link')
  @HttpCode(204)
  async resend(@Param('id') id: string, @Auth() auth: AccessClaims) {
    await this.contracts.resendLink(id, auth.sub);
  }

  /** Downloads the archived agreement text, its PDF, or the execution certificate. */
  @StaffRoles('underwriter', 'collections', 'finance', 'manager')
  @Get(':id/archive/:which')
  async archive(@Param('id') id: string, @Param('which') which: string, @Res() res: Response) {
    const KIND = {
      agreement: { col: 'archive_document_key', type: 'text/plain; charset=utf-8', ext: 'txt' },
      certificate: { col: 'archive_certificate_key', type: 'application/json', ext: 'json' },
      pdf: { col: 'archive_pdf_key', type: 'application/pdf', ext: 'pdf' },
    } as const;
    const kind = KIND[which as keyof typeof KIND];
    if (!kind || !/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException();
    const { rows } = await this.pool.query<{ key: string | null }>(`SELECT ${kind.col} AS key FROM contract WHERE id = $1`, [id]);
    const key = rows[0]?.key;
    if (!key) throw new NotFoundException();
    const body = await this.documents.get(key);
    res.setHeader('content-type', kind.type);
    res.setHeader('content-disposition', `attachment; filename="${which}-${id}.${kind.ext}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(body);
  }
}

const Token = z.string().min(20).max(100);
const DeviceId = z.string().regex(/^[A-Za-z0-9_-]{16,100}$/);
const Complete = z.object({
  token: Token,
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  acknowledged: z.array(z.string().max(60)).max(20),
  typedName: z.string().max(120),
  intentToSign: z.boolean(),
  deviceId: DeviceId,
  signaturePngBase64: z.string().max(400_000).optional(),
});

/**
 * Public signing API used by the signing page. The token always travels in the request body,
 * never in a URL, so it does not reach access logs. Rate-limited by the WAF on /v1/sign/*.
 */
@Controller('sign')
export class SigningController {
  constructor(@Inject(ContractsService) private readonly contracts: ContractsService) {}

  @Public()
  @Post('view')
  @HttpCode(200)
  async view(@Body() body: unknown, @Req() req: Request) {
    const b = parseBody(z.object({ token: Token }), body);
    return this.contracts.view(b.token, requestContext(req));
  }

  @Public()
  @Post('otp')
  @HttpCode(200)
  async otp(@Body() body: unknown) {
    return this.contracts.requestOtp(parseBody(z.object({ token: Token }), body).token);
  }

  @Public()
  @Post('verify')
  @HttpCode(204)
  async verify(@Body() body: unknown) {
    const b = parseBody(z.object({ token: Token, code: z.string().regex(/^\d{6}$/) }), body);
    await this.contracts.verifyOtp(b.token, b.code);
  }

  @Public()
  @Post('complete')
  @HttpCode(200)
  async complete(@Body() body: unknown, @Req() req: Request) {
    const b = parseBody(Complete, body);
    let png: Buffer | null = null;
    if (b.signaturePngBase64) {
      png = Buffer.from(b.signaturePngBase64, 'base64');
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new BadRequestException('signature must be a PNG');
    }
    return this.contracts.sign(
      b.token,
      { documentSha256: b.documentSha256, acknowledged: b.acknowledged, typedName: b.typedName, intentToSign: b.intentToSign, signaturePng: png },
      { ...requestContext(req), deviceId: b.deviceId },
    );
  }

  @Public()
  @Post('decline')
  @HttpCode(204)
  async decline(@Body() body: unknown, @Req() req: Request) {
    const b = parseBody(z.object({ token: Token, reason: z.string().min(3).max(500) }), body);
    await this.contracts.decline(b.token, b.reason, requestContext(req));
  }
}
