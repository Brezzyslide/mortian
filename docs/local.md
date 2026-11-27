# Running everything on your computer

Local staging while the platform is being built and tested. Every provider is a sandbox, so no real SMS, payments, payouts or AWS are used, and none cost anything.

## One-time install (Mac)

1. **Docker Desktop**: docker.com/products/docker-desktop. Open it once and leave it running.
2. **Node 22 LTS**: nodejs.org (the macOS installer).
3. **Git**: run `git --version` in Terminal. If it is missing, macOS offers to install it.

## First run

Install pnpm once. Node 25 and newer no longer bundle corepack, so install it with npm:

```sh
sudo npm install -g corepack
corepack enable
```

Then:

```sh
git clone https://github.com/Brezzyslide/mortian.git
cd mortian
pnpm local:setup
```

Setup does the following:

- writes `.env` with fresh random secrets (never commit it)
- starts Postgres in Docker
- builds the code
- creates the tables
- asks for your console admin email, name and password
- loads the placeholder test data: tiers A–C, the contract template, delivery prices and payout rules, with motorcycle ride-to-own and dispatch switched on

It is safe to run again: it skips what already exists.

## Every day

```sh
pnpm local
```

| App | Address |
| --- | --- |
| Customer app | http://localhost:5173/app/ |
| Staff console | http://localhost:5174/console/ |
| Signing page | http://localhost:5175/sign/ |
| API health | http://localhost:3000/v1/health |

- **Ctrl+C** stops everything. Data stays in the database between runs.
- **Console login:** the first login asks you to scan a QR code with an authenticator app (Google Authenticator, 1Password, etc.).
- **SMS codes and signing links:** customers sign in with a phone number and a code sent by SMS. Locally, nothing is sent. Open **console → Sandbox SMS** to see every message, including login codes, signing links and delivery codes. The inbox empties when the API restarts.
- **Payments:** sandbox collections, checkout and payouts accept the test flows described in `docs/integrations.md`. No money moves.

## Other commands

| Command | What it does |
| --- | --- |
| `pnpm local:daily` | Runs the nightly job now: arrears, notices and weekly payouts. Locally nothing runs it on a schedule. |
| `pnpm local:test` | Runs every check GitHub runs (build, typecheck, all tests, `pnpm synth`) against a separate `project_test` database, so your local data is never touched. Run it before merging. |
| `pnpm local:reset` | Deletes all local data (asks first). Run `pnpm local:setup` afterwards. |
| `LOCAL_NETWORK=1 pnpm local` | Lets phones on the same Wi-Fi open the apps at `http://<your-Mac's-IP>:5173/app/`. Find the IP in System Settings → Wi-Fi → Details. Only do this on a network you trust. |

After pulling new code, run `pnpm local:setup` again. It rebuilds and applies new migrations.

## What this does not test

- CloudFront, WAF, the S3 contract archive and Object Lock. Locally, contract PDFs and ID uploads are plain files in `.local-data/documents`: they are write-once but not tamper-proof and not backed up.
- Real SMS and Paystack. These are AWS staging concerns: see `docs/deploy.md` when you are ready to pay for it.
