import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { AccessClaims, Role } from '@project/identity';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLES = 'auth:roles';

/** Route needs no access token. Everything else is authenticated by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * Route needs a staff session with MFA and at least one of these roles.
 * super_admin always passes.
 */
export const StaffRoles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

export const Auth = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessClaims => {
  return ctx.switchToHttp().getRequest().auth;
});
