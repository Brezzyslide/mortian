# Authentication and roles

## Who signs in how

| User | Method | Session |
| --- | --- | --- |
| Customer, rider, merchant | Nigerian mobile + 6-digit SMS OTP | `customer` session, 30-day refresh |
| Staff | Email + password, then TOTP authenticator code | `staff` session, MFA-verified, 12-hour refresh |
| Guarantor | Per-contract signing link (Phase 2) | No account |

A person can hold several roles. A customer session never carries staff roles, even if the same person is also staff.

## Endpoints (`/v1`)

| Method | Path | Auth |
| --- | --- | --- |
| POST | `/auth/otp/request` `{ phone }` | public |
| POST | `/auth/otp/verify` `{ challengeId, code }` | public |
| POST | `/auth/refresh` `{ refreshToken }` | public |
| POST | `/auth/logout` `{ refreshToken }` | public |
| POST | `/auth/staff/login` `{ email, password }` | public, returns MFA challenge (and TOTP secret on first login) |
| POST | `/auth/staff/mfa` `{ challengeId, code }` | public |
| GET | `/me` | any session |
| GET | `/admin/audit` | staff: manager |
| GET | `/admin/sandbox/messages` | staff: manager, sandbox messaging only |

Every route is authenticated unless marked `@Public()`. Staff routes use `@StaffRoles(...)`; `super_admin` passes every staff check.

## Controls

- OTP: 5-minute expiry, 5 attempts, 3 requests per phone per 15 minutes; stored as HMAC with a server pepper.
- Access tokens: 15 minutes, HS256. Every request also checks the session is live, so logout and suspension apply immediately.
- Refresh tokens: rotate on every use, stored as SHA-256. Presenting a used token revokes the whole session family.
- Staff: scrypt password hashes, lockout for 15 minutes after 5 failures, identical errors for unknown email and wrong password, TOTP secrets encrypted with AES-256-GCM, TOTP replay rejected.
- Audit: every auth event goes to `audit_event`, which the database refuses to update or delete. No codes, passwords or secrets are logged.

## First admin

```sh
ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='at-least-12-chars' \
  node apps/api/dist/cli/create-admin.js
```

Then sign in through `/auth/staff/login` and scan the returned `otpauthUri` into an authenticator app.

## Not yet done

- Per-IP rate limiting at the edge (WAF rule, Phase 1 infra).
- Secrets from AWS Secrets Manager instead of environment variables (Phase 1 infra).
- Staff role management endpoints (grant/revoke with audit).
