import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { kobo } from '@project/domain';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { balanceOf, type EntryDraft } from './entry.js';
import {
  accountBalance,
  AlreadyReversedError,
  bookNet,
  IdempotencyConflictError,
  LedgerValidationError,
  loadEntry,
  postEntry,
  postEntryInTx,
  reverseEntry,
} from './posting.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => db?.drop());

let seq = 0;
const key = () => `test-${++seq}`;
const at = new Date('2026-11-23T09:00:00Z');

function payment(amount: bigint, idempotencyKey = key(), account = 'fin:receivable:FA-1'): EntryDraft {
  return {
    idempotencyKey,
    source: 'webhook',
    actorId: 'paystack-sandbox',
    occurredAt: at,
    description: 'Instalment payment',
    lines: [
      { account: 'fin:clearing:collections', side: 'debit', amount: kobo(amount) },
      { account, side: 'credit', amount: kobo(amount) },
    ],
  };
}

describe('postEntry', () => {
  it('posts a balanced entry and updates balances', async () => {
    const r = await postEntry(db.pool, payment(500_000n, key(), 'fin:receivable:FA-A'));
    expect(r.duplicate).toBe(false);
    expect(await accountBalance(db.pool, 'fin:receivable:FA-A')).toBe(-500_000n);
  });

  it('treats a repeated idempotency key with identical content as a no-op', async () => {
    const k = key();
    const first = await postEntry(db.pool, payment(1_000n, k, 'fin:receivable:FA-B'));
    const second = await postEntry(db.pool, payment(1_000n, k, 'fin:receivable:FA-B'));
    expect(second).toEqual({ entryId: first.entryId, duplicate: true });
    expect(await accountBalance(db.pool, 'fin:receivable:FA-B')).toBe(-1_000n);
  });

  it('rejects a repeated idempotency key with different content', async () => {
    const k = key();
    await postEntry(db.pool, payment(1_000n, k, 'fin:receivable:FA-C'));
    await expect(postEntry(db.pool, payment(2_000n, k, 'fin:receivable:FA-C'))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    expect(await accountBalance(db.pool, 'fin:receivable:FA-C')).toBe(-1_000n);
  });

  it('writes exactly one entry when the same webhook arrives 20 times concurrently', async () => {
    const k = key();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => postEntry(db.pool, payment(7_500n, k, 'fin:receivable:FA-D'))),
    );
    expect(new Set(results.map((r) => r.entryId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await accountBalance(db.pool, 'fin:receivable:FA-D')).toBe(-7_500n);
  });

  it('rejects cross-book entries before touching the database', async () => {
    const sweep: EntryDraft = {
      ...payment(100n),
      lines: [
        { account: 'dsp:rider_payable:R-1', side: 'debit', amount: kobo(100n) },
        { account: 'fin:receivable:FA-1', side: 'credit', amount: kobo(100n) },
      ],
    };
    await expect(postEntry(db.pool, sweep)).rejects.toBeInstanceOf(LedgerValidationError);
    expect(await accountBalance(db.pool, 'dsp:rider_payable:R-1')).toBe(0n);
  });

  it('round-trips an entry exactly, including amounts above 2^53', async () => {
    const huge = 9_007_199_254_740_993n;
    const draft = payment(huge, key(), 'fin:receivable:FA-E');
    const { entryId } = await postEntry(db.pool, draft);
    const loaded = await loadEntry(db.pool, entryId);
    expect(loaded.lines).toEqual(draft.lines);
    expect(await accountBalance(db.pool, 'fin:receivable:FA-E')).toBe(-huge);
  });
});

describe('postEntryInTx', () => {
  it('rolls back with the caller: nothing is posted if the outer transaction fails', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await postEntryInTx(client, payment(900n, key(), 'fin:receivable:FA-TX'));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await accountBalance(db.pool, 'fin:receivable:FA-TX')).toBe(0n);
  });

  it('commits with the caller', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await postEntryInTx(client, payment(901n, key(), 'fin:receivable:FA-TX2'));
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await accountBalance(db.pool, 'fin:receivable:FA-TX2')).toBe(-901n);
  });
});

describe('reverseEntry', () => {
  it('nets the original to zero and links it', async () => {
    const { entryId } = await postEntry(db.pool, payment(40_000n, key(), 'fin:receivable:FA-R'));
    const rev = await reverseEntry(db.pool, entryId, {
      idempotencyKey: key(),
      actorId: 'admin-1',
      occurredAt: at,
      description: 'Reversal: payment misallocated',
    });
    expect(await accountBalance(db.pool, 'fin:receivable:FA-R')).toBe(0n);
    expect((await loadEntry(db.pool, rev.entryId)).reversesEntryId).toBe(entryId);
  });

  it('refuses to reverse the same entry twice', async () => {
    const { entryId } = await postEntry(db.pool, payment(3_000n, key(), 'fin:receivable:FA-S'));
    const meta = { actorId: 'admin-1', occurredAt: at, description: 'Reversal' };
    await reverseEntry(db.pool, entryId, { ...meta, idempotencyKey: key() });
    await expect(reverseEntry(db.pool, entryId, { ...meta, idempotencyKey: key() })).rejects.toBeInstanceOf(
      AlreadyReversedError,
    );
    expect(await accountBalance(db.pool, 'fin:receivable:FA-S')).toBe(0n);
  });
});

describe('ledger invariants against Postgres (property-based)', () => {
  const accounts = ['fin:p:a', 'fin:p:b', 'fin:p:c'];
  const line = fc.tuple(fc.constantFrom(...accounts), fc.bigInt({ min: 1n, max: 10_000_000_000n }));

  it('after any sequence of postings, every account matches an in-memory replay and the book nets to zero', async () => {
    const posted: EntryDraft[] = [];
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.array(line, { minLength: 1, maxLength: 3 }), fc.constantFrom(...accounts)), {
          minLength: 1,
          maxLength: 8,
        }),
        async (batch) => {
          for (const [debits, creditAccount] of batch) {
            const total = debits.reduce((s, [, a]) => s + a, 0n);
            const draft: EntryDraft = {
              idempotencyKey: key(),
              source: 'system',
              actorId: 'prop',
              occurredAt: at,
              description: 'property',
              lines: [
                ...debits.map(([account, a]) => ({ account, side: 'debit' as const, amount: kobo(a) })),
                { account: creditAccount, side: 'credit' as const, amount: kobo(total) },
              ],
            };
            await postEntry(db.pool, draft);
            posted.push(draft);
          }
          for (const a of accounts) {
            expect(await accountBalance(db.pool, a)).toBe(balanceOf(a, posted));
          }
          expect(await bookNet(db.pool, 'financing')).toBe(0n);
        },
      ),
      { numRuns: 40 },
    );
  });
});
