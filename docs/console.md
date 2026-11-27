# Staff console

Served at `/console/` on the same address as the API, so it calls `/v1` same-origin and tokens never cross domains.

## Screens and who sees them

| Screen | Roles | What it does |
| --- | --- | --- |
| Overview | all staff | Applications waiting (underwriters), approvals waiting (managers), portfolio by days overdue and PAR30 (finance, managers) |
| Applications | underwriter, manager | Underwriting queue by status |
| Customers | underwriter, collections, finance, manager | Everyone who has signed up, applied or not. Search by phone (any common format), name or `FA-…` reference. Customer page: phone, accounts, and ID documents with view, accept and reject (underwriter, manager only), including replaced uploads. |
| Account (search `FA-…`) | underwriter, collections, finance, manager | ID documents (underwriter, manager: view, accept, reject with reason), statement, arrears and what the borrower is told, schedule, fees, guarantors, contract progress. Actions by role: approve on a tier; add/remove guarantors and issue the contract (underwriter); resend a link; countersign and revoke (manager); download the signed PDF, text and certificate; activate once signed; charge fee, request waiver, request repossession / release / closure |
| Approvals | manager | Two-person decisions. Your own requests are shown but cannot be decided by you |
| Arrears | collections, manager | Worklist, most overdue first, with call links |
| Payment exceptions | finance | Move unmatched payments to an account, mark reviewed; sandbox payment simulator |
| Tiers | underwriter (view), manager (publish) | Current version per tier; publish a new version; super admin can load the labelled placeholders |
| Deliveries | operations, finance, manager | Every job with route, fare, payment method, rider, status, flags (far from drop-off, code locked), history; cancel before pickup (operations, manager) |
| Riders | operations, manager | Approve (needs accepted licence) or suspend, with a note |
| Rider payouts | finance, manager | Bank accounts whose name does not match the rider (approve or reject with reason), payout rules (manager changes them), every payout with fees and status |
| Delivery pricing | operations, finance, manager | Current prices; a manager sets new ones (apply to new quotes only) |
| Assets | operations, underwriter, collections, finance, manager | Register units (operations, manager), search by chassis/IMEI/plate/account, history, record location, return to stock, papers handed over, write off (manager). Account page: assign a unit before handover, request a resale of a recovered unit |
| Contract templates | underwriter (view), manager (write, approve) | Versions per product. A manager other than the author approves with a legal review note; approved wording is frozen. Super admin can load the labelled placeholder |
| Products | manager (view), super admin (switch) | Live switches |
| Audit log | manager | Append-only event log, filter by subject |
| Staff | super_admin | Invite, change roles, suspend, reset access, re-issue setup links |
| Change password | all staff | Own password; other sessions signed out |

`super_admin` sees everything. The API enforces the same rules again, so hiding a screen is not the only control.

## Sign-in

Email and password, then the authenticator code. On first sign-in the console shows a QR code and the key to enter manually.

The access token is kept in memory only. The refresh token is kept in `sessionStorage`: it survives a page reload but not closing the tab. The server rotates it on every use and signs out every device if a used token is replayed. Staff sessions last at most 12 hours.

## Security headers

Strict Content-Security-Policy (`default-src 'self'`, no inline scripts, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS. The bucket is private and readable only by CloudFront.

## Local development

```sh
docker compose up -d db
cp .env.example .env            # fill the AUTH_* and COLLECTIONS_* values
pnpm build
(cd apps/api && node --env-file=../../.env dist/main.js)
ADMIN_EMAIL=you@example.com ADMIN_NAME=You ADMIN_PASSWORD='at-least-12-chars' \
  node --env-file=.env apps/api/dist/cli/create-admin.js
pnpm --filter @project/console dev   # http://localhost:5173/console/ (proxies /v1 to :3000)
```

## Known gaps

- Only the very first super admin is created with the CLI; everyone else is invited from the Staff screen.
- Tier editing is a JSON editor with server-side validation, not a form.
