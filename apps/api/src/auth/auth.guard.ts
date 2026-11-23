import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IdentityService, type Role } from '@project/identity';
import { IS_PUBLIC, REQUIRED_ROLES } from './decorators.js';

/**
 * Global guard. Every route requires a valid access token on a live session unless marked @Public().
 * Routes marked @StaffRoles(...) additionally require a staff, MFA-verified session holding one of the roles.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException();

    const claims = await this.identity.verifyAccessToken(token).catch(() => null);
    // Checked on every request so logout, suspension and reuse detection take effect immediately,
    // not when the 15-minute access token expires.
    if (!claims || !(await this.identity.isSessionActive(claims.sid))) throw new UnauthorizedException();
    req.auth = claims;

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(REQUIRED_ROLES, targets);
    if (required) {
      const ok =
        claims.kind === 'staff' &&
        claims.mfa &&
        (claims.roles.includes('super_admin') || required.some((r) => claims.roles.includes(r)));
      if (!ok) throw new ForbiddenException();
    }
    return true;
  }
}
