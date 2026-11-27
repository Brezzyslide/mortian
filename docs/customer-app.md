# Customer app

`apps/web`, served at `/app/`. Mobile-first for low-cost Android phones. No router or UI library.

## What a customer can do

| Screen | What it shows / does |
|---|---|
| Sign in | Phone number, then the 6-digit SMS code. Stays signed in on the phone (see Sessions). |
| Your name | Required once before applying: full name as on their ID. It goes on agreements. |
| Home | ID documents: upload (camera or file), status, and the reason if one was not accepted. Each account: product, status in plain words, missed payments and days overdue, next payment, amount left. |
| Apply | Live products only. One tap sends the application; staff set price and terms after review. |
| Account | Status and what it means; once approved, the terms in plain amounts (price, deposit, financed, repayments, interest, total cost) and, before handover, deposit paid and left to pay; the unit they hold (description, chassis/IMEI, plate); at-risk panel (amount to catch up or reactivate, penalty included, deadline, steps); repayment account with copy button; amount left, next payment, % paid; payment schedule; withdraw while under review. |

Before an agreement is signed, the app tells the customer not to pay anything.

## API (customer sessions only)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/me/products` | Live products with names and one-line descriptions (`PRODUCT_INFO` in `@project/domain`). |
| POST | `/v1/me/profile` | `{ fullName }`: letters, spaces, `' . -`, first and last name. Refused with `name_locked` once any application is past review: the name is on terms and contracts, so staff change it. |
| POST | `/v1/me/applications` | Needs a name (`profile_incomplete`). One open application per product (`application_open`, with its reference), enforced under a per-person lock so double taps cannot create two. |
| POST | `/v1/me/applications/:ref/withdraw` | Only while `applied`; otherwise `not_withdrawable`. |
| GET | `/v1/me/accounts`, `/v1/me/accounts/:ref` | Summary list and full statement with the repayment account, terms, deposit and unit. Another person's reference returns 404. |
| POST | `/v1/me/documents?kind=` | Raw file body (`image/jpeg`, `image/png`, `application/pdf`), up to 8 MB. |
| GET | `/v1/me/documents` | Their documents, status and rejection reasons. |

Name changes and withdrawals are written with their audit record in a single statement.

## Sessions

The access token is held in memory. The refresh token is kept on the phone (localStorage) so customers are not asked for a code every 15 minutes. It rotates on every use; a replayed old token revokes the whole session on the server, and the app signs out instead of retrying. Tabs share the token under a Web Lock so two open tabs do not trip reuse detection.

Trade-off: anything able to run script in the app could read the refresh token. The CSP allows only the app's own scripts, and no third-party code is loaded.

## ID documents

Customers upload a national ID/NIN slip, driver's licence, voter's card, passport or proof of address as a photo or PDF. Photos are shrunk on the phone first (longest side 1600 px, JPEG): a 4 MB camera photo becomes about 300 KB, and re-encoding drops EXIF data such as GPS location.

- The file is the raw request body, up to 8 MB. Its type is decided from its bytes (JPEG, PNG or PDF only), not from its name or the header.
- At most 10 can wait for review per customer; the same file cannot be uploaded twice.
- Underwriters and managers view documents on the account page (every view is in the audit log) and accept or reject them. A rejection needs a reason, which the customer sees. A decision is final: a rejected document is replaced by a new upload.
- A new upload of the same type replaces one that is still waiting for review (not for "other"). The earlier file is kept and marked replaced, staff can still open it, and it can no longer be accepted. The database allows only one pending upload per type per customer.
- Staff also see documents on the customer page (console → Customers), so someone who uploads but has not applied is not missed.
- Files are served with `no-store`, `nosniff` and a sandboxing CSP, so a PDF opened directly cannot run anything.
- Storage: a dedicated encrypted bucket (`KYC_BUCKET`), not the contracts archive. It is deliberately not object-locked, because data-protection law can require deleting ID documents. The API can only put and get under `kyc/`; it cannot delete.

Approval does not yet require an accepted ID document; the console warns the underwriter instead. Automated checks (NIN lookup, face match) arrive with an identity-verification provider (see integrations.md).

## Not yet built
- Offline support and install-to-home-screen (PWA manifest and service worker).
