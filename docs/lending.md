# Terms, schedules and the payment waterfall

## Lifecycle so far

`applied` → **approve on a tier** → `approved` → *(Phase 2: contract signed → `contracted`)* → deposit in credit → **activate** → `active` → … → `settled`

Arrears, penalty, repossession and reactivation: see [arrears.md](arrears.md).

## Tiers

- Each product has tiers (A, B, C…). A tier sets every term's default, floor and ceiling, plus frequency and interest method.
- Publishing a tier creates a new **version**; old versions and any account approved on them never change.
- `MOTORCYCLE_PLACEHOLDER_TIERS` exist only so the system runs end to end. Every account approved on them is marked `isPlaceholderTerms: true` in statements. **They are not pricing recommendations.**

| Term | Unit |
| --- | --- |
| `assetPriceKobo` | integer kobo (string) |
| `depositBps`, `annualInterestBps`, `guarantorMaxLiabilityBps` | basis points (100 = 1%) |
| `penaltyBpsPerDay` | basis points per day on overdue amount |
| `tenorPeriods` | number of instalments |
| `graceDays`, `repossessionReviewDaysOverdue`, `reactivationWindowDays` | days |
| `guarantorsRequired` | count |

## Approval

- Within the tier's bounds: the underwriter approves directly.
- Outside: the underwriter's request becomes a pending **approval request** (reason required). A manager confirms it **from their own session**. The database refuses a snapshot where the second approver is the requester.
- Approved terms are copied into an immutable `term_snapshot`. The schedule (and, in Phase 2, the contract) is generated from it.

## Schedules

- Flat: interest on the original principal for the whole tenor, spread evenly.
- Reducing: equal instalments, interest on the remaining balance.
- All integer kobo. Principal always sums exactly to the financed amount; the last instalment absorbs rounding. Verified by property tests over random terms.
- Dates are Lagos calendar dates; monthly dates keep the anchor day and clamp to month end.

## Waterfall

Default order: **fees → penalty → overdue interest → overdue principal → current interest → current principal**, oldest first within each. Only amounts already due are paid. Anything left stays as credit and is applied when the next instalment falls due (`POST /admin/lending/jobs/daily`).

Payments are applied immediately after the webhook posts. If that fails, the money stays in credit and the daily job applies it.

## Fees

- Finance or a manager charges a fee.
- A waiver is requested by collections or finance and confirmed by a different manager. Only the unpaid remainder is waived, by a ledger entry; the fee row records both people.

## Borrower statement (`GET /v1/me/accounts/:reference`)

Outstanding principal, interest, fees and penalty; credit; **missed instalments, amount missed, oldest missed date and days overdue**; next due; percent paid off; every instalment with its state (`paid`, `part_paid`, `missed`, `due`, `upcoming`); repayment account number.

## Routes

| Method | Path | Who |
| --- | --- | --- |
| POST | `/me/applications` `{ productCode }` | customer; product must be live |
| GET | `/me/accounts`, `/me/accounts/:reference` | owner only (others get 404) |
| POST | `/admin/lending/products/:product/live` `{ live }` | super_admin |
| GET | `/admin/lending/tiers/:product` | underwriter, manager |
| POST | `/admin/lending/tiers/:product/:tier` `{ config, note? }` | manager |
| POST | `/admin/lending/tiers/seed-placeholders` | super_admin |
| GET | `/admin/lending/accounts/:reference` | underwriter, collections, finance, manager |
| POST | `/admin/lending/accounts/:reference/approve` `{ tier, assetPriceKobo, adjustments?, reason? }` | underwriter |
| POST | `/admin/lending/accounts/:reference/activate` `{ startDate? }` | manager |
| POST | `/admin/lending/accounts/:reference/fees` `{ code, amountKobo }` | finance, manager |
| POST | `/admin/lending/fees/:feeChargeId/waiver-requests` `{ reason }` | collections, finance |
| GET | `/admin/lending/approvals` | manager |
| POST | `/admin/lending/approvals/:id/decide` `{ decision, note }` | manager (not the requester) |
| POST | `/admin/lending/jobs/daily` `{ asOf?, maxCatchUpDays? }` | super_admin (scheduler in production) |
