import { Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import pg from 'pg';
import { IdentityService, type AccessClaims, type TokenPair } from '@project/identity';
import { parseBody, requestContext } from '../http.js';
import { PG_POOL } from '../infra.module.js';
import { Auth, Public } from './decorators.js';

const OtpRequest = z.object({ phone: z.string().min(7).max(20) });
const OtpVerify = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) });
const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const StaffLogin = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });
const StaffMfa = z.object({ challengeId: z.uuid(), code: z.string().regex(/^\d{6}$/) });

const tokens = (t: TokenPair) => ({
  accessToken: t.accessToken,
  accessExpiresAt: t.accessExpiresAt.toISOString(),
  refreshToken: t.refreshToken,
  refreshExpiresAt: t.refreshExpiresAt.toISOString(),
});

@Controller()
export class AuthController {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  @Public()
  @Post('auth/otp/request')
  @HttpCode(202)
  async requestOtp(@Body() body: unknown, @Req() req: Request) {
    const { phone } = parseBody(OtpRequest, body);
    const r = await this.identity.requestLoginOtp(phone, requestContext(req));
    return { challengeId: r.challengeId, expiresAt: r.expiresAt.toISOString(), sentTo: r.maskedPhone };
  }

  @Public()
  @Post('auth/otp/verify')
  @HttpCode(200)
  async verifyOtp(@Body() body: unknown, @Req() req: Request) {
    const { challengeId, code } = parseBody(OtpVerify, body);
    const r = await this.identity.verifyLoginOtp(challengeId, code, requestContext(req));
    return { personId: r.personId, isNewPerson: r.isNewPerson, ...tokens(r.tokens) };
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown, @Req() req: Request) {
    const { refreshToken } = parseBody(RefreshBody, body);
    return tokens(await this.identity.refresh(refreshToken, requestContext(req)));
  }

  @Public()
  @Post('auth/logout')
  @HttpCode(204)
  async logout(@Body() body: unknown, @Req() req: Request) {
    const { refreshToken } = parseBody(RefreshBody, body);
    await this.identity.logout(refreshToken, requestContext(req));
  }

  @Public()
  @Post('auth/staff/login')
  @HttpCode(200)
  async staffLogin(@Body() body: unknown, @Req() req: Request) {
    const { email, password } = parseBody(StaffLogin, body);
    return this.identity.staffLogin(email, password, requestContext(req));
  }

  @Public()
  @Post('auth/staff/mfa')
  @HttpCode(200)
  async staffMfa(@Body() body: unknown, @Req() req: Request) {
    const { challengeId, code } = parseBody(StaffMfa, body);
    return tokens(await this.identity.staffVerifyMfa(challengeId, code, requestContext(req)));
  }

  @Get('me')
  async me(@Auth() auth: AccessClaims) {
    const { rows } = await this.pool.query<{ phone: string | null; email: string | null; full_name: string | null }>(
      'SELECT phone, email, full_name FROM person WHERE id = $1',
      [auth.sub],
    );
    const p = rows[0]!;
    return { id: auth.sub, kind: auth.kind, roles: auth.roles, phone: p.phone, email: p.email, fullName: p.full_name };
  }
}
