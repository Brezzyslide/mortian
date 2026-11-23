# Collections and payment exceptions

## Flow

1. Each finance account gets its own repayment account number (`virtual_account`).
2. The customer pays into it. The provider calls `POST /v1/webhooks/collections/<provider>`.
3. The API verifies the signature over the exact raw bytes, then stores the event (`payment_event`).
4. The payment posts to the ledger: debit `fin:clearing:<provider>`, credit `fin:suspense:<FA-ref>`.
5. The allocation engine (next) moves suspense into fees, interest and principal by the product's order.

## Guarantees

| Situation | What happens |
| --- | --- |
| Same webhook delivered again, or 10 times at once | Posted once. Later deliveries return `duplicate` |
| Delivery stopped after the event was stored but before posting | The next delivery finishes it; the ledger key stops double posting |
| Same provider reference, different amount or account | Not posted. Flagged `conflicting_redelivery` for review |
| Unknown account number | Posted to `fin:suspense:unmatched` and queued, so clearing still matches the bank |
| Payment to a settled, declined or written-off account | Posted, and flagged `account_status_<status>` |
| Bad or missing signature | 401, nothing stored |
| Stored event facts (amount, account, payload) | The database refuses edits and deletes |

Invariant checked in tests: the clearing balance equals the sum of all processed payment events, and the financing book nets to zero.

## Admin routes (`/v1/admin/payments`)

| Method | Path | Role |
| --- | --- | --- |
| GET | `/exceptions` | finance |
| POST | `/exceptions/:eventId/assign` `{ financeAccountReference, note }` | finance: posts a suspense transfer, never edits the original |
| POST | `/exceptions/:eventId/resolve` `{ note }` | finance: closes a reviewed non-unmatched exception |
| POST | `/sandbox/simulate` `{ accountNumber, amountKobo, reference? }` | manager or finance; sandbox only |

## Sandbox provider

`SandboxCollections` is our own simulated provider. Its webhook format (`payment.received`, amount as integer-kobo string) and signature (`x-sandbox-signature`: HMAC-SHA512 hex of the raw body) are ours. A real provider adapter is written from that provider's published documentation once you choose one and have sandbox keys. The API refuses to start with `COLLECTIONS_PROVIDER=sandbox` in production.
