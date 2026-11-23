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
| GET, POST | `/admin/staff` | super_admin: list, invite |
| PUT | `/admin/staff/:id/roles` | super_admin |
| POST | `/admin/staff/:id/suspend`, `/reactivate`, `/reset-access`, `/reissue-link` | super_admin |
| POST | `/auth/staff/setup` `{ token, password }` | public, one-time link |
| POST | `/me/password` `{ currentPassword, newPassword }` | staff session |

Every route is authenticated unless marked `@Public()`. Staff routes use `@StaffRoles(...)`; `super_admin` passes every staff check.

## Controls

- OTP: 5-minute expiry, 5 attempts, 3 requests per phone per 15 minutes; stored as HMAC with a server pepper.
- Access tokens: 15 minutes, HS256. Every request also checks the session is live, so logout and suspension apply immediately.
- Refresh tokens: rotate on every use, stored as SHA-256. Presenting a used token revokes the whole session family.
- Staff: scrypt password hashes, lockout for 15 minutes after 5 failures, identical errors for unknown email and wrong password, TOTP secrets encrypted with AES-256-GCM, TOTP replay rejected.
- Audit: every auth event goes to `audit_event`, which the database refuses to update or delete. No codes, passwords or secrets are logged.

## Staff lifecycle (super admin, console → Staff)

| Action | Effect |
| --- | --- |
| Invite | Creates the person with no password and returns a **one-time setup link** (72 hours, single use, stored as a hash). Hand it over privately |
| Set password | The invitee opens the link and chooses a password; they enrol an authenticator at first sign-in |
| Change roles | Replaces roles and signs the person out everywhere so new permissions apply at once |
| Suspend / reactivate | Suspension signs them out and blocks sign-in |
| Reset access | Forgotten password or lost phone: clears password and authenticator, signs out everywhere, issues a new link |
| New link | Re-issues an expired invite; the old link stops working |

Guards: nobody can suspend or reset themselves; the last active super admin cannot be demoted or suspended. Every change is in the audit log. Setup links put the token in the URL fragment (`/console/setup#…`), which browsers never send to a server or in a Referer header.

Staff change their own password at console → Change password (current password required); every other session is signed out.

## First admin

```sh
ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='at-least-12-chars' \
  node apps/api/dist/cli/create-admin.js
```

Then sign in through `/auth/staff/login` and scan the returned `otpauthUri` into an authenticator app.

## Not yet done

- Per-IP rate limiting at the edge (WAF rule, Phase 1 infra).
- Secrets from AWS Secrets Manager instead of environment variables (Phase 1 infra).
