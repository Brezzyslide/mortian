# Asset register

Every financed motorcycle, phone or piece of equipment is a registered unit with a history. The asset moves with the account inside the same database transaction, so the two can never disagree.

## Registering

Operations (`dispatch_ops`) or a manager registers each unit as it arrives: kind, make, model, year, cost to us, location, and the identifier that proves which unit it is.

| Kind | Identifier | Checks |
|---|---|---|
| Motorcycle | Chassis number (plus engine number and plate if known) | 5–40 letters or digits |
| Phone | IMEI | 15 digits, valid check digit (catches most typos) |
| Equipment / other | Serial number | 5–40 letters or digits |

Identifiers and plates are stored upper-case without spaces, dashes, dots or slashes, so `md2a 12-bz` and `MD2A12BZ` are the same unit and the second is refused as a duplicate. Kind, identifier and cost can never change: a mistake is written off and the unit registered again.

## Life of an asset

| Status | How it gets there |
|---|---|
| In stock | Registered |
| Reserved for handover | Assigned to an approved or signed account (underwriter, operations, manager). One asset per account; the kind must match the product. Can be returned to stock before handover. |
| With customer | Handover (activation). **Handover is refused without an assigned asset** for every product except school fees. |
| Recovered (in yard) | Repossession approved (two people). Location from the repossession request. |
| With customer again | Release approved after the reactivation amount is cleared. |
| For sale | Account closed as recovered after the cure deadline. |
| Sold | Sale approved by a second manager (below). Final. |
| Paid off, papers due | Account settled in full. |
| Owned by customer | A manager records the ownership papers handed over; the account becomes `title_transferred`. Final. |
| Written off | Manager, with reason. Only for units the company holds (in stock, recovered, for sale): a unit with a customer stays on their account. Final. |

Location can be recorded at any time before a final status. Every change is an append-only event (who, when, where, which account, note); the database refuses edits and deletes of history and of final assets.

## Resale of a recovered asset

Requested by collections or a manager on the account page (price, buyer, reason); approved by a different manager under Approvals. On approval, in one transaction:

1. The price is posted as received into `fin:clearing:asset_resale` (finance matches it to the bank deposit).
2. It pays down what the borrower owes in order: fees, penalty, interest, principal. Only interest already due is owed; a closed account accrues no new interest or penalty.
3. Anything above what is owed is credited to `fin:payable:resale_surplus:<ref>`: money owed back to the borrower.
4. A shortfall stays on the account's receivables.
5. The asset becomes Sold with price and buyer in its history.

The entry's idempotency key is the asset id, so one asset can be sold once.

## Customer view

The customer's account shows which unit they have: description, identifier and plate. Not cost or location.

## Not yet built

- Writing off a shortfall after sale (needs a write-off approval and an expense account).
- Paying a resale surplus back to the borrower (needs a payout provider).
- Photos and condition reports on recovery (the repossession request takes photo references; uploading them needs the document store wired to the console).
- GPS trackers: not planned. The safeguards rule out device locking and automatic repossession.
