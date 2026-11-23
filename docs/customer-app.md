# Customer app

`apps/web`, served at `/app/`. Mobile-first for low-cost Android phones. No router or UI library.

## What a customer can do

| Screen | What it shows / does |
|---|---|
| Sign in | Phone number, then the 6-digit SMS code. Stays signed in on the phone (see Sessions). |
| Your name | Required once before applying: full name as on their ID. It goes on agreements. |
| Home | Each account: product, status in plain words, missed payments and days overdue, next payment, amount left. |
| Apply | Live products only. One tap sends the application; staff set price and terms after review. |
| Account | Status and what it means; at-risk panel (amount to catch up or reactivate, penalty included, deadline, steps); repayment account with copy button; amount left, next payment, % paid; payment schedule; withdraw while under review. |

Before an agreement is signed, the app tells the customer not to pay anything.

## API (customer sessions only)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/me/products` | Live products with names and one-line descriptions (`PRODUCT_INFO` in `@project/domain`). |
| POST | `/v1/me/profile` | `{ fullName }`: letters, spaces, `' . -`, first and last name. Refused with `name_locked` once any application is past review: the name is on terms and contracts, so staff change it. |
| POST | `/v1/me/applications` | Needs a name (`profile_incomplete`). One open application per product (`application_open`, with its reference), enforced under a per-person lock so double taps cannot create two. |
| POST | `/v1/me/applications/:ref/withdraw` | Only while `applied`; otherwise `not_withdrawable`. |
| GET | `/v1/me/accounts`, `/v1/me/accounts/:ref` | Summary list and full statement with the repayment account. Another person's reference returns 404. |

Name changes and withdrawals are written with their audit record in a single statement.

## Sessions

The access token is held in memory. The refresh token is kept on the phone (localStorage) so customers are not asked for a code every 15 minutes. It rotates on every use; a replayed old token revokes the whole session on the server, and the app signs out instead of retrying. Tabs share the token under a Web Lock so two open tabs do not trip reuse detection.

Trade-off: anything able to run script in the app could read the refresh token. The CSP allows only the app's own scripts, and no third-party code is loaded.

## Not yet built

- Uploading ID or other documents for review.
- Showing the deposit amount before activation (staff currently tell the customer).
- Offline support and install-to-home-screen (PWA manifest and service worker).
