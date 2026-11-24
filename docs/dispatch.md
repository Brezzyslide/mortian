# Dispatch

Customers book deliveries; riders take them; the fare is settled in the **dispatch book** of the ledger. Dispatch money never touches the financing book: a rider's loan is repaid by a real transfer into their repayment account, not by a ledger shortcut.

## Riders

- Any customer can apply to ride: **own bike**, or **financed** (naming their ride-to-own account, which must be active or in arrears, i.e. the bike is with them).
- Operations (`dispatch_ops`) or a manager activates a rider. **Activation needs an accepted driver's licence** (uploaded in the app, accepted by an underwriter or manager on the Documents panel). Staff never activate themselves.
- A financed rider cannot go online once their account is repossessed, closed or otherwise not active.
- Online riders send their location; they see open jobs whose pickup is within the job radius, nearest first.

Assumptions taken (not confirmed): both financed and own-bike riders can ride, with no priority between them.

## Pricing

Versioned. Fare = base + per-km × route distance, at least the minimum, rounded **up** to the whole naira. Commission is a share of the fare. A quote records the pricing version and the distance source, lasts 10 minutes, belongs to one customer and books once; later price changes never change it. Placeholder prices (₦500 + ₦150/km, minimum ₦1,000, 20% commission, ₦5,000 cash debt limit, 5 km radius) are marked as such.

Distance comes from the `Routes` port. The sandbox uses straight-line distance × 1.3; a maps provider (Google Maps or Mapbox) replaces it before customers are charged by distance.

## A job

`awaiting_payment` (in-app only) → `searching` → `accepted` → `picked_up` → `delivered`, or `cancelled` before pickup. The database refuses any move backwards, any change after delivery or cancellation, any change to fare or parties, and a second live job for one rider.

1. **Book.** Customer chooses cash or in-app. In-app jobs get a payment link and wait for a verified payment; riders do not see them until paid.
2. **Accept.** First rider to accept wins (row lock). A rider cannot accept their own booking.
3. **Pickup.** The sender gives the rider the 6-digit pickup code. The recipient is then texted the 6-digit delivery code (`dispatch_delivery_code`).
4. **Deliver.** The rider enters the recipient's code. A delivery confirmed more than 500 m from the drop-off is **flagged** for review, not refused (GPS is imprecise).

Codes are derived from the job id with a secret key, never stored; the customer sees both while the job is live, never after. Five wrong tries lock a code (staff then help). Every step is an append-only event with who, when and where.

## Money (dispatch book)

| When | Entry |
|---|---|
| In-app payment verified | Dr `dsp:clearing:<provider>` / Cr `dsp:prepaid:<job>` |
| Payment wrong amount, unknown job, or job already paid/cancelled | Dr `dsp:clearing:<provider>` / Cr `dsp:suspense:unmatched` (held for finance; the job is not released) |
| Delivered, in-app | Dr `dsp:prepaid:<job>` / Cr `dsp:rider:<R-ref>` (fare − commission) / Cr `dsp:income:commission` |
| Delivered, cash | Dr `dsp:rider:<R-ref>` / Cr `dsp:income:commission` (the rider kept the fare and owes the commission) |
| Paid job cancelled before pickup | Dr `dsp:prepaid:<job>` / Cr `dsp:refund_payable:<job>` |

A rider's account balance is what they are owed (credit) or owe (debit). A rider owing more than the cash debt limit sees no cash jobs and cannot accept one until it is recovered; in-app jobs remain open to them, and their earnings reduce the debt.

Each payment event posts once (idempotency key = provider event id); a repeat is acknowledged as a duplicate.

## Not yet built

- **Payouts** to riders' bank accounts (bank account check against their verified name, weekly automatic payout plus instant withdrawal, opt-in loan repayment share), and paying out refunds. Fees: see [integrations.md](integrations.md).
- **Customer booking screens** in the app: need address search and a map pin, i.e. a maps provider.
- **Rider app** (Android): planned after staging.
- Merchants and bulk bookings, live tracking map, proof-of-delivery photos, disputes.
