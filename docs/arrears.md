# Arrears, repossession and reactivation

Repossession is always a staff decision confirmed by a second person. The system never repossesses, immobilises or locks anything automatically.

## Daily job (`POST /v1/admin/lending/jobs/daily`, scheduler in production)

For each date since the last completed run, in order (capped at 60 days unless `maxCatchUpDays` is raised), for every serviced account:

1. Book interest due and apply credit through the waterfall.
2. **Penalty interest**: `penaltyBpsPerDay` × overdue principal + interest on instalments past `graceDays`. Fees and earlier penalty are excluded, so penalty never compounds on itself. One posting per account per day.
3. **Status**, from the account's frozen terms:

| From | Condition | To | Notice |
| --- | --- | --- | --- |
| active | anything missed | in_arrears | `arrears_notice` |
| in_arrears | nothing missed | active | none |
| active / in_arrears | oldest missed ≥ `repossessionReviewDaysOverdue` days | repossession_review; cure deadline = today + `reactivationWindowDays` | `arrears_repossession_review` (amount, missed count, deadline) |
| repossession_review | reactivation amount fully paid | active | `arrears_cured` |
| repossessed | (never automatic) | | |

Notices go by SMS once per event (`notification_log` deduplicates). Guarantor notices are added with guarantors in Phase 2.

One runner at a time across all API instances (advisory lock). Re-running a date changes nothing.

## Reactivation amount

Missed instalments + penalty outstanding + fees outstanding (recovery costs are charged as a fee, e.g. `recovery_cost`, and so are included).

## What the borrower sees (`arrears` in the statement)

`reactivationAmount`, `penaltyOutstanding`, `feesOutstanding`, `arrearsSince`, `reviewStartsOn` (when review will start if nothing is paid), `reviewStartedOn`, `cureDeadline`, `cureDeadlinePassed`, `repossessedOn`, plus `steps`: plain instructions with the exact naira amount, the repayment account and the date. Alongside `missed`: instalments missed, amount missed, oldest missed date, days overdue.

## Staff actions (two people each)

| Action | Requested by | Allowed when | Confirmed by | Effect |
| --- | --- | --- | --- | --- |
| Repossession | collections | repossession_review | manager (not the requester) | repossessed; location, condition, photo refs recorded |
| Release | collections | repossessed and reactivation amount is 0 | manager | active; review fields cleared |
| Close as recovered | collections or manager | review or repossessed, cure deadline passed | manager | closed_recovered |

Closing does not post the asset resale yet. Shortfall or surplus postings come with asset disposal.

## Collections and finance views

- `GET /v1/admin/lending/arrears?status=` (collections, manager): worklist, most overdue first.
- `GET /v1/admin/lending/portfolio` (finance, manager): accounts and principal by days-overdue bucket (current, 1–7, 8–30, 31–60, 61–90, 90+) and PAR30.

## Assumptions to confirm

- Penalty continues to accrue during review and while repossessed, and stops at closure.
- The cure deadline starts when review starts, not when the asset is repossessed.
- The `in_arrears` state starts on the first day anything is missed; penalty starts only after the grace days.
