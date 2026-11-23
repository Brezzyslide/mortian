import pg from 'pg';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date');
} finally {
  await pool.end();
}
