import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from './migrate.js';

export interface TestDatabase {
  readonly pool: pg.Pool;
  readonly schema: string;
  drop(): Promise<void>;
}

/**
 * Creates an isolated, fully migrated schema for one test file.
 * Requires DATABASE_URL (CI provides it; locally `docker compose up -d db`).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set. Start Postgres with `docker compose up -d db` and export DATABASE_URL.');
  }
  const schema = `t_${randomBytes(6).toString('hex')}`;

  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: url, max: 5, options: `-c search_path=${schema}` });
  await runMigrations(pool);

  return {
    pool,
    schema,
    async drop() {
      await pool.end();
      const cleanup = new pg.Pool({ connectionString: url, max: 1 });
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.end();
    },
  };
}
