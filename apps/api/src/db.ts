import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { AppConfig } from './config.js';

/** The one place a database pool is built, for the API, the jobs and the CLIs alike. */
export function createPool(config: AppConfig, max: number = config.DB_POOL_MAX): pg.Pool {
  const ssl = config.DB_SSL_CA_FILE
    ? { ca: readFileSync(config.DB_SSL_CA_FILE, 'utf8'), rejectUnauthorized: true }
    : undefined;
  if (config.DATABASE_URL) {
    return new pg.Pool({ connectionString: config.DATABASE_URL, max, ...(ssl ? { ssl } : {}) });
  }
  return new pg.Pool({
    host: config.DB_HOST!,
    port: config.DB_PORT,
    database: config.DB_NAME!,
    user: config.DB_USER!,
    password: config.DB_PASSWORD!,
    max,
    ...(ssl ? { ssl } : {}),
  });
}
