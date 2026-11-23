# Rules for agents working in this repo

## Money
- All amounts are integer kobo (`bigint`) using `Kobo` from `@project/domain`. No `number`, no floats, no `Decimal` in money paths.
- Only `packages/ledger` and the API's ledger module write ledger tables. Every other module calls the posting service.
- Ledger entries are immutable. Corrections are a reversing entry plus a new entry linked by `reversesEntryId`.
- Every entry must balance (debits = credits) and post to exactly one book. Cross-book postings are rejected — rider dispatch earnings and loan repayments never touch.
- Every posting carries an idempotency key. Duplicate keys are a no-op, not an error to retry around.

## Integrations
- Providers sit behind ports in `packages/adapters`. Ship a sandbox adapter first.
- Never invent provider endpoints. A real adapter is written only from the provider's published docs with sandbox keys in hand.
- Never label a sandbox adapter as live. Update `docs/integrations.md` in the same change as any adapter.

## Product scope
- Every product line is built; each has a live flag. Do not delete or stub out a product domain to make something else pass.
- Brand strings come from `packages/domain/src/brand.ts` only.

## Signing
- Signer tokens are single-use, expiring, stored hashed. A borrower must never be able to complete a guarantor's signature.
- A SHA-256 hash is tamper evidence, not a digital signature. Do not describe it as one in UI or docs.

## Safeguards
- No contact-list access, no device locking, no automatic repossession.

## Infrastructure
- All AWS resources are defined in `infra/` (CDK). No console-created resources.
- No secrets in the repo, env files, or CI logs.

## Done means
- Typecheck, tests and `pnpm synth` pass. Money and signing changes include tests for the failure cases, not only the happy path.
