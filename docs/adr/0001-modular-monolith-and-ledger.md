# ADR 0001: Modular monolith with a single double-entry ledger

**Status:** accepted · 2026-11-23

## Decision

- One NestJS API with strict module boundaries, one PostgreSQL database, one TypeScript monorepo.
- All money moves through one append-only double-entry ledger partitioned into four books: financing, dispatch, merchant, platform.
- Amounts are integer kobo (`bigint`). Entries balance, post to exactly one book, and carry an idempotency key.
- Rider dispatch earnings and loan repayments are separate books. A cross-book entry is rejected by `validateEntry`.

## Why

- One developer: a monolith avoids distributed-transaction and deployment overhead while modules keep domains separable later.
- Balances derived from immutable entries can be replayed and audited; editable balance columns cannot.

## Consequences

- Extracting a module into a service later means replacing in-process calls with a transport; the interfaces are already narrow.
- Every money feature needs a posting rule and tests before UI.
