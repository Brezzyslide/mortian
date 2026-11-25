/** Applies database migrations and exits. The API also does this on boot when MIGRATE_ON_BOOT=true. */
import { runMigrations } from '@project/db';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';

const pool = createPool(loadConfig(), 2);
try {
  await runMigrations(pool);
  console.log('Database is up to date.');
} finally {
  await pool.end();
}
