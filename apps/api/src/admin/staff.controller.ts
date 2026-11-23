import { Body, Controller, ForbiddenException, Get, HttpCode, Inject, Param, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { STAFF_ROLES, StaffAdminService, type AccessClaims } from '@project/identity';
import { Auth, Public, StaffRoles } from '../auth/decorators.js';
import { parseBody } from '../http.js';

const Role = z.enum(STAFF_ROLES);
const Invite = z.object({ email: z.email().max(254), fullName: z.string().min(2).max(120), roles: z.array(Role).min(1) });
const Roles = z.object({ roles: z.array(Role).min(1) });
const Id = z.uuid();
const Setup = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(256) });
const ChangePassword = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });

const link = (l: { token: string; expiresAt: Date }) => ({ setupToken: l.token, expiresAt: l.expiresAt.toISOString() });

/** Staff lifecycle for super admins. Setup tokens are returned once, to hand over out of band. */
@Controller('admin/staff')
export class StaffController {
  constructor(@Inject(StaffAdminService) private readonly staff: StaffAdminService) {}

  @StaffRoles('super_admin')
  @Get()
  async list() {
    return { staff: await this.staff.list() };
  }

  @StaffRoles('super_admin')
  @Post()
  @HttpCode(201)
  async invite(@Body() body: unknown, @Auth() auth: AccessClaims) {
    const b = parseBody(Invite, body);
    const r = await this.staff.invite({ ...b, by: auth.sub });
    return { id: r.id, ...link(r) };
  }

  @StaffRoles('super_admin')
  @Put(':id/roles')
  @HttpCode(204)
  async roles(@Param('id') id: string, @Body() body: unknown, @Auth() auth: AccessClaims) {
    await this.staff.setRoles(parseBody(Id, id), parseBody(Roles, body).roles, auth.sub);
  }

  @StaffRoles('super_admin')
  @Post(':id/suspend')
  @HttpCode(204)
  async suspend(@Param('id') id: string, @Auth() auth: AccessClaims) {
    await this.staff.setStatus(parseBody(Id, id), 'suspended', auth.sub);
  }

  @StaffRoles('super_admin')
  @Post(':id/reactivate')
  @HttpCode(204)
  async reactivate(@Param('id') id: string, @Auth() auth: AccessClaims) {
    await this.staff.setStatus(parseBody(Id, id), 'active', auth.sub);
  }

  @StaffRoles('super_admin')
  @Post(':id/reset-access')
  @HttpCode(200)
  async resetAccess(@Param('id') id: string, @Auth() auth: AccessClaims) {
    return link(await this.staff.resetAccess(parseBody(Id, id), auth.sub));
  }

  @StaffRoles('super_admin')
  @Post(':id/reissue-link')
  @HttpCode(200)
  async reissue(@Param('id') id: string, @Auth() auth: AccessClaims) {
    return link(await this.staff.reissueLink(parseBody(Id, id), auth.sub));
  }
}

@Controller()
export class StaffSelfController {
  constructor(@Inject(StaffAdminService) private readonly staff: StaffAdminService) {}

  /** Public: set a password with a one-time setup link. Rate-limited by the WAF like all /auth routes. */
  @Public()
  @Post('auth/staff/setup')
  @HttpCode(200)
  async setup(@Body() body: unknown) {
    const b = parseBody(Setup, body);
    return this.staff.completeSetup(b.token, b.password);
  }

  @Post('me/password')
  @HttpCode(204)
  async changePassword(@Body() body: unknown, @Auth() auth: AccessClaims, @Req() _req: Request) {
    if (auth.kind !== 'staff') throw new ForbiddenException();
    const b = parseBody(ChangePassword, body);
    await this.staff.changePassword(auth.sub, b.currentPassword, b.newPassword, auth.sid);
  }
}
