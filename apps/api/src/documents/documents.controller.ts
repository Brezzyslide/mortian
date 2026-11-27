import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import pg from 'pg';
import { CustomerDocumentService, DOCUMENT_KINDS, DocumentError } from '@project/finance';
import type { AccessClaims } from '@project/identity';
import { Auth, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';
import { PG_POOL } from '../infra.module.js';

const STATUS: Record<DocumentError['code'], number> = {
  not_found: HttpStatus.NOT_FOUND,
  unsupported_type: HttpStatus.UNSUPPORTED_MEDIA_TYPE,
  too_large: HttpStatus.PAYLOAD_TOO_LARGE,
  empty: HttpStatus.BAD_REQUEST,
  duplicate: HttpStatus.CONFLICT,
  too_many_pending: HttpStatus.TOO_MANY_REQUESTS,
  already_reviewed: HttpStatus.CONFLICT,
  own_document: HttpStatus.FORBIDDEN,
};

@Catch(DocumentError)
export class DocumentErrorFilter implements ExceptionFilter {
  catch(err: DocumentError, host: ArgumentsHost): void {
    host.switchToHttp().getResponse<Response>().status(STATUS[err.code] ?? 400).json({ error: err.code, message: err.message });
  }
}

const Kind = z.object({ kind: z.enum(DOCUMENT_KINDS) });
const Review = z.object({ decision: z.enum(['accepted', 'rejected']), note: z.string().trim().max(500).nullable().optional() });

@Controller()
export class DocumentsController {
  constructor(
    @Inject(CustomerDocumentService) private readonly docs: CustomerDocumentService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  /** The raw file is the body (image/jpeg, image/png or application/pdf, up to 8 MB). */
  @Post('me/documents')
  @HttpCode(201)
  async upload(@Query() query: unknown, @Body() body: unknown, @Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    const { kind } = parseBody(Kind, query);
    if (!Buffer.isBuffer(body)) throw new UnsupportedMediaTypeException({ error: 'unsupported_type', message: 'Send the file as image/jpeg, image/png or application/pdf' });
    return this.docs.upload(auth.sub, kind, body);
  }

  @Get('me/documents')
  async mine(@Auth() auth: AccessClaims) {
    if (auth.kind !== 'customer') throw new ForbiddenException();
    return { documents: await this.docs.forPerson(auth.sub) };
  }

  /** The documents of the account holder, for underwriting. */
  @StaffRoles('underwriter', 'manager')
  @Get('admin/lending/accounts/:reference/documents')
  async forAccount(@Param('reference') reference: string) {
    const { rows } = await this.pool.query<{ person_id: string }>('SELECT person_id FROM finance_account WHERE reference = $1', [reference]);
    if (!rows[0]) throw new NotFoundException();
    return { documents: await this.docs.forPerson(rows[0].person_id, { includeReplaced: true }) };
  }

  /** Streams the file. Every view is audited; nothing is cached. */
  @StaffRoles('underwriter', 'manager')
  @Get('admin/documents/:id/file')
  async file(@Param('id') id: string, @Auth() auth: AccessClaims, @Res() res: Response) {
    const f = await this.docs.file(parseBody(z.uuid(), id), auth.sub);
    res.setHeader('content-type', f.contentType);
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-disposition', `inline; filename="${f.kind}-${id}.${f.contentType === 'application/pdf' ? 'pdf' : f.contentType === 'image/png' ? 'png' : 'jpg'}"`);
    // A PDF opened directly must not run anything on our origin.
    res.setHeader('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    res.send(f.body);
  }

  @StaffRoles('underwriter', 'manager')
  @Post('admin/documents/:id/review')
  @HttpCode(200)
  async review(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Review, body);
    return this.docs.review(parseBody(z.uuid(), id), auth.sub, b.decision, b.note ?? null);
  }
}
