/**
 * Auth errors deliberately carry little detail outward: the API maps them to generic
 * messages so responses never reveal whether a phone or email exists.
 */
export class AuthError extends Error {
  constructor(
    readonly code:
      | 'invalid_phone'
      | 'rate_limited'
      | 'otp_invalid'
      | 'otp_expired'
      | 'otp_locked'
      | 'invalid_credentials'
      | 'account_locked'
      | 'account_inactive'
      | 'mfa_invalid'
      | 'mfa_expired'
      | 'session_invalid'
      | 'session_reused'
      | 'weak_password',
    message: string = code,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
