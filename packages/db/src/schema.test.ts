import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from './testing.js';
import { runMigrations } from './migrate.js';

/**
 * These tests bypass the application and write raw SQL, to prove the database itself
 * refuses invalid ledger data even if a bug or a manual query tries to write it.
 */
let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
  await db.pool.query(`
    INSERT INTO ledger_account (code, book) VALUES
      ('fin:cash', 'financing'), ('fin:receivable:A', 'financing'), ('dsp:rider_payable:R', 'dispatch')`);
});
afterAll(async () => db?.drop());

async function tx(sql: string): Promise<void> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql);
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

const entry = (key: string, book = 'financing') => `
  INSERT INTO ledger_entry (id, idempotency_key, payload_hash, book, source, actor_id, description, occurred_at)
  VALUES ('00000000-0000-0000-0000-${key.padStart(12, '0')}', '${key}', 'h', '${book}', 'system', 'test', 'd', now());`;
const id = (key: string) => `00000000-0000-0000-0000-${key.padStart(12, '0')}`;
const line = (key: string, account: string, side: string, amount: number, book = 'financing') =>
  `INSERT INTO ledger_line (entry_id, book, account_code, side, amount) VALUES ('${id(key)}', '${book}', '${account}', '${side}', ${amount});`;

describe('ledger schema guarantees', () => {
  it('is idempotent to migrate twice', async () => {
    expect(await runMigrations(db.pool)).toEqual([]);
  });

  it('accepts a balanced entry', async () => {
    await tx(entry('1') + line('1', 'fin:cash', 'debit', 500) + line('1', 'fin:receivable:A', 'credit', 500));
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM ledger_line');
    expect(rows[0].n).toBe(2);
  });

  it('rejects an unbalanced entry at commit', async () => {
    await expect(
      tx(entry('2') + line('2', 'fin:cash', 'debit', 500) + line('2', 'fin:receivable:A', 'credit', 499)),
    ).rejects.toThrow(/unbalanced/);
  });

  it('rejects an entry with a single line', async () => {
    await expect(tx(entry('3') + line('3', 'fin:cash', 'debit', 500))).rejects.toThrow(/at least 2/);
  });

  it('rejects an entry with no lines', async () => {
    await expect(tx(entry('4'))).rejects.toThrow(/at least 2/);
  });

  it('rejects a line whose account is in another book (rider earnings vs loan)', async () => {
    await expect(
      tx(
        entry('5') +
          line('5', 'fin:receivable:A', 'credit', 100) +
          line('5', 'dsp:rider_payable:R', 'debit', 100, 'financing'),
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('rejects an account whose code prefix does not match its book', async () => {
    await expect(db.pool.query(`INSERT INTO ledger_account (code, book) VALUES ('dsp:x', 'financing')`)).rejects.toThrow(
      /check constraint/,
    );
  });

  it('rejects zero or negative amounts', async () => {
    await expect(
      tx(entry('6') + line('6', 'fin:cash', 'debit', 0) + line('6', 'fin:receivable:A', 'credit', 0)),
    ).rejects.toThrow(/check constraint/);
  });

  it('refuses updates, deletes and truncation of posted rows', async () => {
    await expect(db.pool.query(`UPDATE ledger_line SET amount = 1`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`DELETE FROM ledger_line`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE ledger_entry SET description = 'x'`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`DELETE FROM ledger_entry`)).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`TRUNCATE ledger_line`)).rejects.toThrow(/immutable/);
  });

  it('refuses lines added to an existing entry in a later transaction, even if balanced', async () => {
    await expect(
      tx(line('1', 'fin:cash', 'debit', 7) + line('1', 'fin:receivable:A', 'credit', 7)),
    ).rejects.toThrow(/transaction that created/);
  });

  it('rejects a reused idempotency key', async () => {
    await expect(
      tx(
        entry('1').replace(id('1'), id('9')) + line('9', 'fin:cash', 'debit', 5) + line('9', 'fin:receivable:A', 'credit', 5),
      ),
    ).rejects.toThrow(/duplicate key/);
  });
});
