import {
  BadRequestException,
  Catch,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { AuthError } from '@project/identity';

/** Parses a request body with zod; 400 with field paths on failure. */
export function parseBody<S extends z.ZodType>(schema: S, body: unknown): z.infer<S> {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new BadRequestException({
      error: 'invalid_request',
      fields: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function requestContext(req: Request) {
  return { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null };
}

/**
 * Maps AuthError codes to HTTP. Several codes deliberately collapse to the same public
 * response so callers cannot tell an unknown account from a wrong password.
 */
const AUTH_HTTP: Record<AuthError['code'], [HttpStatus, string]> = {
  invalid_phone: [HttpStatus.BAD_REQUEST, 'invalid_phone'],
  weak_password: [HttpStatus.BAD_REQUEST, 'weak_password'],
  rate_limited: [HttpStatus.TOO_MANY_REQUESTS, 'rate_limited'],
  otp_invalid: [HttpStatus.UNAUTHORIZED, 'otp_invalid'],
  otp_expired: [HttpStatus.UNAUTHORIZED, 'otp_expired'],
  otp_locked: [HttpStatus.UNAUTHORIZED, 'otp_locked'],
  invalid_credentials: [HttpStatus.UNAUTHORIZED, 'invalid_credentials'],
  account_locked: [HttpStatus.LOCKED, 'account_locked'],
  account_inactive: [HttpStatus.FORBIDDEN, 'account_inactive'],
  mfa_invalid: [HttpStatus.UNAUTHORIZED, 'mfa_invalid'],
  mfa_expired: [HttpStatus.UNAUTHORIZED, 'mfa_expired'],
  session_invalid: [HttpStatus.UNAUTHORIZED, 'session_invalid'],
  session_reused: [HttpStatus.UNAUTHORIZED, 'session_invalid'],
  setup_invalid: [HttpStatus.BAD_REQUEST, 'setup_invalid'],
  last_super_admin: [HttpStatus.CONFLICT, 'last_super_admin'],
  self_action: [HttpStatus.CONFLICT, 'self_action'],
  not_staff: [HttpStatus.BAD_REQUEST, 'not_staff'],
  email_taken: [HttpStatus.CONFLICT, 'email_taken'],
};

@Catch(AuthError)
export class AuthErrorFilter implements ExceptionFilter {
  catch(err: AuthError, host: ArgumentsHost): void {
    const [status, error] = AUTH_HTTP[err.code];
    // Messages are safe to show only where they carry no account-existence signal.
    const showMessage = ['weak_password', 'last_super_admin', 'self_action', 'not_staff'].includes(err.code);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(status)
      .json(showMessage && err.message !== err.code ? { error, message: err.message } : { error });
  }
}

