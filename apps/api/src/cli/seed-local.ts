/**
 * Loads placeholder data so a fresh local database can be tested at once: motorcycle tiers, the
 * labelled placeholder contract, delivery pricing and payout rules, and switches the motorcycle
 * and dispatch products on. Every item is marked as a placeholder. Safe to run again (skips what
 * exists). Refuses to run anywhere but APP_ENV=development.
 *   node dist/cli/seed-local.js
 */
import { MemoryDocumentStore, SandboxMessaging } from '@project/adapters';
import { ContractsService } from '@project/contracts';
import { DispatchService, PayoutService, PLACEHOLDER_PAYOUT_SETTINGS, PLACEHOLDER_PRICING } from '@project/dispatch';
import { SandboxCheckout, SandboxPayouts, SandboxRoutes } from '@project/adapters';
import { LendingService, MOTORCYCLE_PLACEHOLDER_TIERS } from '@project/finance';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

const config = loadConfig();
if (config.APP_ENV !== 'development') {
  console.error(`seed-local only runs with APP_ENV=development (this is ${config.APP_ENV}).`);
  process.exit(1);
}

const pool = createPool(config, 2);
const messaging = new SandboxMessaging();
const done: string[] = [];

try {
  const admin = (await pool.query<{ person_id: string }>(`SELECT person_id FROM person_role WHERE role = 'super_admin' ORDER BY granted_at LIMIT 1`)).rows[0];
  if (!admin) throw new Error('Create the admin first (create-admin), then seed.');
  const by = admin.person_id;

  const lending = new LendingService(pool);
  const existing = new Set((await lending.currentTiers('motorcycle_ride_to_own')).map((t) => t.tier));
  for (const [tier, cfg] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
    if (existing.has(tier)) continue;
    await lending.publishTier('motorcycle_ride_to_own', tier, cfg, { actorId: by, isPlaceholder: true });
    done.push(`tier ${tier}`);
  }

  const contracts = new ContractsService(pool, messaging, new MemoryDocumentStore(), {
    otpPepper: config.AUTH_OTP_PEPPER,
    signingBaseUrl: config.SIGNING_BASE_URL ?? 'http://localhost:5175/sign/',
    linkTtlHours: 72,
  });
  if (await contracts.seedPlaceholderTemplate(by)) done.push('placeholder contract template');

  const dispatch = new DispatchService(pool, new SandboxRoutes(), new SandboxCheckout(config.COLLECTIONS_WEBHOOK_SECRET), messaging, { codePepper: Buffer.alloc(32) });
  if (!(await dispatch.currentPricing())) {
    await dispatch.setPricing(PLACEHOLDER_PRICING, by, true);
    done.push('delivery pricing');
  }
  const payouts = new PayoutService(pool, new SandboxPayouts(config.COLLECTIONS_WEBHOOK_SECRET), messaging);
  if (!(await payouts.settings())) {
    await payouts.setSettings(PLACEHOLDER_PAYOUT_SETTINGS, by, true);
    done.push('payout rules');
  }

  const live = await pool.query(
    `UPDATE product_setting SET live = true, updated_by = $1, updated_at = now()
      WHERE product_code IN ('motorcycle_ride_to_own', 'dispatch') AND NOT live RETURNING product_code`,
    [by],
  );
  for (const r of live.rows) done.push(`${r.product_code} switched on`);

  console.log(done.length ? `Seeded: ${done.join(', ')}.` : 'Nothing to seed: everything is already there.');
} finally {
  await pool.end();
}
