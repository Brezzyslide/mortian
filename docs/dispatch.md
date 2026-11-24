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

## Payouts

Riders are paid from their dispatch-book balance (earnings minus any cash commission owed) by bank transfer through the `Payouts` port. Riders need no account with the provider.

**Bank account.** The rider picks a bank and enters the 10-digit account number. The provider returns the name the bank holds; it is compared word by word with the rider's verified name (any order, accents ignored, at least two names must appear). A match is ready at once; anything else waits for finance to approve or reject with a reason (console: Rider payouts). Changing the account texts the rider (`payout_account_changed`) and pauses payouts for the cooling-off period, so a stolen phone cannot quietly redirect pay. Only the last four digits are ever shown.

**When.**
- *Weekly:* on the set weekday the daily job pays every active rider their whole balance (at least the minimum). The platform pays the transfer fee. Runs at most once per rider per day; a rider without a usable account is skipped, not a failure for everyone.
- *Instant:* the rider withdraws any amount above the minimum, up to a daily limit. By default the rider pays the transfer fee (taken from the amount).

**Loan share (opt-in).** A financed rider can send a share of every payout (up to the set maximum) to their loan. It is a separate transfer to their own repayment account, so it arrives through the collections webhook into the financing book like any other repayment; the two books never share an entry. No fee is taken from the loan part.

**Money.**

| When | Entry (dispatch book) |
|---|---|
| Payout created | Dr `dsp:rider:<R>` gross / Cr `dsp:payout_in_transit:<PO>` net / Cr `dsp:income:payout_fees` rider fee |
| Transfer succeeded | Dr in-transit / Cr `dsp:clearing:<provider>` net; Dr `dsp:expense:transfer_fees` / Cr clearing provider fee |
| Transfer failed (webhook, or the provider refused at once) | Everything back to the rider, fee included |

The rider row is locked while a payout is created, so two withdrawals at once cannot spend the same balance. Each outcome posts once; a repeated webhook is a duplicate. Finished payouts cannot be changed or deleted.

Placeholder rules: Monday weekly payout, ₦1,000 minimum, instant on with the rider paying the fee, ₦100,000 a day, loan share up to 50%, 24-hour cooling-off.

Fees follow Paystack's published Nigerian transfer pricing (₦10 up to ₦5,000, ₦25 up to ₦50,000, ₦50 above, plus ₦50 stamp duty from ₦10,000); the sandbox charges the same so test books are realistic.

## Not yet built

- Paying refunds owed to customers for cancelled paid jobs (the liability is recorded; the transfer is not built).
- Recovering cash commission a rider owes when they have no in-app earnings (today it waits for future earnings).
- **Customer booking screens** in the app: need address search and a map pin, i.e. a maps provider.
- **Rider app** (Android): planned after staging. The rider endpoints (jobs, codes, earnings, bank account, withdrawals, loan share) are ready for it.
- Merchants and bulk bookings, live tracking map, proof-of-delivery photos, disputes.
