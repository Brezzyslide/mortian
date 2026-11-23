# Integration matrix

Status values: **live** (real provider, production credentials), **sandbox-real** (real provider, sandbox keys), **simulated** (our own deterministic adapter, no network), **interface** (port defined, no adapter), **blocked** (needs a contract or approval we don't have).

| Port | Candidates | Adapter in repo | Status |
| --- | --- | --- | --- |
| IdentityVerification | Smile ID, Youverify, Prembly, Dojah, VerifyMe | `SandboxIdentityVerification` | simulated |
| CreditCheck | CRC, FirstCentral, CreditRegistry, CreditChek | — | interface |
| BankDataInsight | Mono, Okra | — | not started (Phase 3) |
| Collections | Paystack, Monnify, Flutterwave | `SandboxCollections` (own webhook format, HMAC-SHA512; refused in production config) | simulated |
| Payouts | Paystack, Monnify, Flutterwave | — | not started (Phase 1) |
| ConditionalSettlement | authorised bank/payment partner | — | blocked: no partner |
| Messaging | Termii, Africa's Talking, WhatsApp Business, Firebase | `SandboxMessaging` (in-memory outbox; refused in production config) | simulated |
| Maps | Google Maps, Mapbox | — | not started (Phase 2) |
| Telematics | Traccar, Wialon | — | not started (Phase 2) |
| ExternalSigning | DocuSign and similar | — | optional |
| BusinessRegistry | CAC verification | — | not started (Phase 4) |

Update this file in the same commit as any adapter change.
