# PROJECT_NAME

Integrated asset finance, dispatch and in-app contract execution platform. Launch zone: Mararaba (Nasarawa) with FCT service zones.

`PROJECT_NAME` is a placeholder. Brand name, colours, domains and copy live in `packages/domain/src/brand.ts` and must never be hard-coded elsewhere.

## Layout

```
apps/
  api/        NestJS API (modular monolith) + worker entrypoint
  rider/      Expo rider app (Android first) — Phase 2
  web/        customer + merchant PWA (React + Vite)
  console/    admin console (React + Vite)
  sign/       signer / guarantor web flow (React + Vite)
packages/
  domain/     money (kobo), brand config, shared types and state machines
  db/         SQL migrations, migration runner, test database helper
  ledger/     double-entry posting rules, posting service and allocation engine
  identity/   phone OTP, staff password + TOTP, sessions, audit log
  finance/    accounts, collections, tiers, term snapshots, schedules, waterfall, fees, approvals
  adapters/   provider ports + sandbox implementations
infra/        AWS CDK stacks
docs/         PRD pointer, ADRs, integration matrix
```

## Commands

```sh
corepack enable
docker compose up -d db
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/project_dev
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm synth        # CDK synth, no AWS credentials needed
```

## Status

Phase 0 scaffold. See `docs/integrations.md` for what is live, simulated or blocked. Nothing in this repo talks to a real provider yet.
