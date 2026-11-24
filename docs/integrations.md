# Integration matrix

Status values: **live** (real provider, production credentials), **sandbox-real** (real provider, sandbox keys), **simulated** (our own deterministic adapter, no network), **interface** (port defined, no adapter), **blocked** (needs a contract or approval we don't have).

| Port | Candidates | Adapter in repo | Status |
| --- | --- | --- | --- |
| IdentityVerification | Smile ID, Youverify, Prembly, Dojah, VerifyMe | `SandboxIdentityVerification` | simulated |
| CreditCheck | CRC, FirstCentral, CreditRegistry, CreditChek | — | interface |
| BankDataInsight | Mono, Okra | — | not started (Phase 3) |
| Collections | Paystack, Monnify, Flutterwave | `SandboxCollections` (own webhook format, HMAC-SHA512; refused in production config) | simulated |
| Checkout | Paystack (Pay with Transfer / checkout) | `SandboxCheckout` (own webhook format, HMAC-SHA512; shares the collections secret, as Paystack signs all webhooks with one key) | simulated |
| Payouts | Paystack, Monnify, Flutterwave | — | not started |
| ConditionalSettlement | authorised bank/payment partner | — | blocked: no partner |
| Messaging | Termii, Africa's Talking, WhatsApp Business, Firebase | `SandboxMessaging` (in-memory outbox; refused in production config) | simulated |
| Routes (Maps) | Google Maps, Mapbox | `SandboxRoutes` (straight line × 1.3) | simulated |
| Telematics | Traccar, Wialon | — | not started (Phase 2) |
| ExternalSigning | DocuSign and similar | — | optional |
| DocumentStore | AWS S3 (contracts bucket, Object Lock) | `S3DocumentStore` (write-once, SHA-256 checked); `MemoryDocumentStore` for dev/test | live (AWS) / simulated |
| BusinessRegistry | CAC verification | — | not started (Phase 4) |

Update this file in the same commit as any adapter change.

## SMS templates

Every message the platform sends, by template id. Register these with the SMS provider once chosen (sender ID and template approval are usually needed). Wording below is suggested; variables in `{braces}` are filled by the platform.

| Template | To | Variables | Suggested wording |
| --- | --- | --- | --- |
| `auth_otp_login` | customer | `code`, `minutes` | Your sign-in code is {code}. It expires in {minutes} minutes. Never share it. |
| `contract_sign_link` | borrower, guarantor | `name`, `reference`, `url` | {name}, please read and sign agreement {reference}: {url} |
| `contract_sign_otp` | borrower, guarantor | `code`, `reference` | Your code to sign {reference} is {code}. Never share it. |
| `arrears_notice` | borrower | `reference`, `amount`, `since` | {reference}: you have missed a payment since {since}. Pay {amount} to catch up and stop penalty interest. |
| `arrears_repossession_review` | borrower | `reference`, `missed`, `amount`, `deadline` | {reference} is under review after {missed} missed payments. Pay {amount} by {deadline} to keep it. |
| `arrears_cured` | borrower | `reference` | {reference} is up to date again. Thank you. |
| `guarantor_arrears_review` | guarantor who signed | `name`, `borrower`, `reference`, `amount`, `deadline`, `support` | {name}, {borrower}, whom you guaranteed, is behind on {reference}. {amount} is needed by {deadline}. Questions: {support}. |
| `guarantor_arrears_cured` | guarantor who signed | `name`, `borrower`, `reference` | {name}, {borrower}'s account {reference} is up to date again. No action is needed. |
| `dispatch_delivery_code` | delivery recipient | `reference`, `code` | A parcel is on its way to you ({reference}). Give the rider code {code} only when you have received it. |

Staff setup links are shown in the console for the admin to pass on; they are not sent by SMS.
