/**
 * Daily arrears job, run by the scheduler as a one-off container just after midnight Lagos time.
 * Catches up any missed dates in order. Exits non-zero on failure so the scheduler alarms.
 */
import { SandboxMessaging } from '@project/adapters';
import { ArrearsService, LendingService } from '@project/finance';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

const config = loadConfig();
const pool = createPool(config, 3);
const lending = new LendingService(pool);
// Swapped for the real SMS adapter when a provider is chosen (same factory as the API).
const arrears = new ArrearsService(pool, lending, new SandboxMessaging());

try {
  const r = await arrears.runDaily();
  console.log(JSON.stringify({ job: 'daily-arrears', ...r }));
} catch (err) {
  console.error(JSON.stringify({ job: 'daily-arrears', error: (err as Error).message }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
