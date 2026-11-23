import type { Book, Kobo } from '@project/domain';

/**
 * Account codes are prefixed with their book: fin:, dsp:, mer:, plt:
 * e.g. "fin:receivable:FA-000123", "dsp:rider_payable:R-0042".
 */
const BOOK_PREFIX: Record<string, Book> = {
  fin: 'financing',
  dsp: 'dispatch',
  mer: 'merchant',
  plt: 'platform',
};

export type Side = 'debit' | 'credit';

export interface LedgerLine {
  readonly account: string;
  readonly side: Side;
  /** Always positive; direction comes from `side`. */
  readonly amount: Kobo;
}

export interface EntryDraft {
  readonly idempotencyKey: string;
  readonly source: 'webhook' | 'admin' | 'scheduler' | 'system';
  readonly actorId: string;
  readonly occurredAt: Date;
  readonly description: string;
  readonly lines: readonly LedgerLine[];
  readonly reversesEntryId?: string;
}

export type EntryError =
  | { code: 'missing_idempotency_key' }
  | { code: 'too_few_lines' }
  | { code: 'non_positive_amount'; lineIndex: number }
  | { code: 'unknown_book'; account: string }
  | { code: 'cross_book'; books: Book[] }
  | { code: 'unbalanced'; debits: bigint; credits: bigint };

export function bookOf(account: string): Book | undefined {
  const prefix = account.split(':', 1)[0] ?? '';
  return BOOK_PREFIX[prefix];
}

/**
 * Validates an entry before it is posted. Returns every problem found, so callers
 * (and tests) see the full picture rather than the first failure.
 */
export function validateEntry(entry: EntryDraft): EntryError[] {
  const errors: EntryError[] = [];

  if (entry.idempotencyKey.trim() === '') {
    errors.push({ code: 'missing_idempotency_key' });
  }
  if (entry.lines.length < 2) {
    errors.push({ code: 'too_few_lines' });
  }

  const books = new Set<Book>();
  let debits = 0n;
  let credits = 0n;

  entry.lines.forEach((line, lineIndex) => {
    if (line.amount <= 0n) {
      errors.push({ code: 'non_positive_amount', lineIndex });
    }
    const book = bookOf(line.account);
    if (!book) {
      errors.push({ code: 'unknown_book', account: line.account });
    } else {
      books.add(book);
    }
    if (line.side === 'debit') debits += line.amount;
    else credits += line.amount;
  });

  if (books.size > 1) {
    errors.push({ code: 'cross_book', books: [...books].sort() });
  }
  if (debits !== credits) {
    errors.push({ code: 'unbalanced', debits, credits });
  }

  return errors;
}

/** Builds the reversal of a posted entry: same lines, sides swapped. */
export function reversalOf(
  entryId: string,
  original: EntryDraft,
  meta: Pick<EntryDraft, 'idempotencyKey' | 'actorId' | 'occurredAt' | 'description'>,
): EntryDraft {
  return {
    ...meta,
    source: 'admin',
    reversesEntryId: entryId,
    lines: original.lines.map((l) => ({
      ...l,
      side: l.side === 'debit' ? 'credit' : 'debit',
    })),
  };
}

/** Net balance of an account (debits minus credits) across a set of entries. */
export function balanceOf(account: string, entries: readonly EntryDraft[]): bigint {
  let balance = 0n;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.account !== account) continue;
      balance += l.side === 'debit' ? l.amount : -l.amount;
    }
  }
  return balance;
}
