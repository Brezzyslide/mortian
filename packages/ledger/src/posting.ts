import { createHash } from 'node:crypto';
import type { Book } from '@project/domain';
import { bookOf, reversalOf, validateEntry, type EntryDraft, type EntryError, type LedgerLine } from './entry.js';

/** Minimal slice of node-postgres used here, so this package does not depend on a driver. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}
export interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

export class LedgerValidationError extends Error {
  constructor(readonly errors: EntryError[]) {
    super(`Invalid ledger entry: ${errors.map((e) => e.code).join(', ')}`);
    this.name = 'LedgerValidationError';
  }
}

/** Same idempotency key, different content: a caller bug, never silently accepted. */
export class IdempotencyConflictError extends Error {
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" was already used for a different entry`);
    this.name = 'IdempotencyConflictError';
  }
}

export class AlreadyReversedError extends Error {
  constructor(readonly entryId: string) {
    super(`Entry ${entryId} has already been reversed`);
    this.name = 'AlreadyReversedError';
  }
}

export class EntryNotFoundError extends Error {
  constructor(readonly entryId: string) {
    super(`Entry ${entryId} not found`);
    this.name = 'EntryNotFoundError';
  }
}

export interface PostResult {
  readonly entryId: string;
  /** true when the idempotency key had already been posted with identical content: nothing new was written. */
  readonly duplicate: boolean;
}

/** Hash of everything that defines the entry's financial meaning. */
export function payloadHash(entry: EntryDraft): string {
  const canonical = JSON.stringify({
    source: entry.source,
    actorId: entry.actorId,
    description: entry.description,
    occurredAt: entry.occurredAt.toISOString(),
    reversesEntryId: entry.reversesEntryId ?? null,
    lines: entry.lines.map((l) => [l.account, l.side, l.amount.toString()]),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const UNIQUE_VIOLATION = '23505';

/**
 * Posts one entry atomically. Re-posting the same idempotency key with identical content
 * returns the original entry id with duplicate=true and writes nothing.
 */
export async function postEntry(pool: PoolLike, entry: EntryDraft): Promise<PostResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await postEntryInTx(client, entry);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Posts one entry inside a transaction the caller has already opened, so the posting
 * commits or rolls back together with the caller's other writes (allocation rows,
 * status changes). Same validation and idempotency rules as postEntry.
 */
export async function postEntryInTx(tx: Queryable, entry: EntryDraft): Promise<PostResult> {
  const errors = validateEntry(entry);
  if (errors.length > 0) throw new LedgerValidationError(errors);

  const book = bookOf(entry.lines[0]!.account) as Book;
  const hash = payloadHash(entry);

  try {
    const accounts = [...new Set(entry.lines.map((l) => l.account))];
    await tx.query(
      `INSERT INTO ledger_account (code, book)
       SELECT unnest($1::text[]), $2
       ON CONFLICT (code) DO NOTHING`,
      [accounts, book],
    );

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO ledger_entry
         (idempotency_key, payload_hash, book, source, actor_id, description, occurred_at, reverses_entry_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        entry.idempotencyKey,
        hash,
        book,
        entry.source,
        entry.actorId,
        entry.description,
        entry.occurredAt,
        entry.reversesEntryId ?? null,
      ],
    );

    if (inserted.rows.length === 0) {
      const existing = await tx.query<{ id: string; payload_hash: string }>(
        'SELECT id, payload_hash FROM ledger_entry WHERE idempotency_key = $1',
        [entry.idempotencyKey],
      );
      const row = existing.rows[0]!;
      if (row.payload_hash !== hash) throw new IdempotencyConflictError(entry.idempotencyKey);
      return { entryId: row.id, duplicate: true };
    }

    const entryId = inserted.rows[0]!.id;
    await tx.query(
      `INSERT INTO ledger_line (entry_id, book, account_code, side, amount)
       SELECT $1, $2, a, s, m::bigint
         FROM unnest($3::text[], $4::text[], $5::text[]) AS t(a, s, m)`,
      [
        entryId,
        book,
        entry.lines.map((l) => l.account),
        entry.lines.map((l) => l.side),
        entry.lines.map((l) => l.amount.toString()),
      ],
    );
    return { entryId, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err, 'ledger_entry_reverses_entry_id_key') && entry.reversesEntryId) {
      throw new AlreadyReversedError(entry.reversesEntryId);
    }
    throw err;
  }
}

/** Loads a posted entry back into draft form. */
export async function loadEntry(db: Queryable, entryId: string): Promise<EntryDraft> {
  const head = await db.query<{
    idempotency_key: string;
    source: EntryDraft['source'];
    actor_id: string;
    description: string;
    occurred_at: Date;
    reverses_entry_id: string | null;
  }>(
    `SELECT idempotency_key, source, actor_id, description, occurred_at, reverses_entry_id
       FROM ledger_entry WHERE id = $1`,
    [entryId],
  );
  const h = head.rows[0];
  if (!h) throw new EntryNotFoundError(entryId);

  const lines = await db.query<{ account_code: string; side: LedgerLine['side']; amount: string }>(
    'SELECT account_code, side, amount::text FROM ledger_line WHERE entry_id = $1 ORDER BY id',
    [entryId],
  );
  return {
    idempotencyKey: h.idempotency_key,
    source: h.source,
    actorId: h.actor_id,
    description: h.description,
    occurredAt: h.occurred_at,
    ...(h.reverses_entry_id ? { reversesEntryId: h.reverses_entry_id } : {}),
    lines: lines.rows.map((l) => ({
      account: l.account_code,
      side: l.side,
      amount: BigInt(l.amount) as LedgerLine['amount'],
    })),
  };
}

/** Posts the exact reversal of an entry. An entry can be reversed once. */
export async function reverseEntry(
  pool: PoolLike,
  entryId: string,
  meta: Pick<EntryDraft, 'idempotencyKey' | 'actorId' | 'occurredAt' | 'description'>,
): Promise<PostResult> {
  const original = await loadEntry(pool, entryId);
  return postEntry(pool, reversalOf(entryId, original, meta));
}

/** Net balance (debits − credits) of one account, in kobo. */
export async function accountBalance(db: Queryable, account: string): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT coalesce(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END), 0)::text AS net
       FROM ledger_line WHERE account_code = $1`,
    [account],
  );
  return BigInt(rows[0]!.net);
}

/** Sum of all lines in a book. Must always be zero; a non-zero result is a critical alert. */
export async function bookNet(db: Queryable, book: Book): Promise<bigint> {
  const { rows } = await db.query<{ net: string }>(
    `SELECT coalesce(sum(CASE side WHEN 'debit' THEN amount ELSE -amount END), 0)::text AS net
       FROM ledger_line WHERE book = $1`,
    [book],
  );
  return BigInt(rows[0]!.net);
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string };
  return e?.code === UNIQUE_VIOLATION && e.constraint === constraint;
}
