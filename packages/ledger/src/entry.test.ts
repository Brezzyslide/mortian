import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { kobo } from '@project/domain';
import { balanceOf, reversalOf, validateEntry, type EntryDraft } from './entry.js';

const base = {
  idempotencyKey: 'pay-001',
  source: 'webhook' as const,
  actorId: 'system',
  occurredAt: new Date('2026-11-23T09:00:00Z'),
  description: 'Instalment payment',
};

const repayment: EntryDraft = {
  ...base,
  lines: [
    { account: 'fin:clearing:paystack', side: 'debit', amount: kobo(500000n) },
    { account: 'fin:receivable:FA-1', side: 'credit', amount: kobo(500000n) },
  ],
};

describe('validateEntry', () => {
  it('accepts a balanced single-book entry', () => {
    expect(validateEntry(repayment)).toEqual([]);
  });

  it('rejects an unbalanced entry', () => {
    const bad: EntryDraft = {
      ...repayment,
      lines: [repayment.lines[0]!, { ...repayment.lines[1]!, amount: kobo(499999n) }],
    };
    expect(validateEntry(bad)).toContainEqual({ code: 'unbalanced', debits: 500000n, credits: 499999n });
  });

  it('rejects rider earnings posted against a loan receivable (cross-book)', () => {
    const sweep: EntryDraft = {
      ...base,
      lines: [
        { account: 'dsp:rider_payable:R-1', side: 'debit', amount: kobo(1000n) },
        { account: 'fin:receivable:FA-1', side: 'credit', amount: kobo(1000n) },
      ],
    };
    expect(validateEntry(sweep)).toContainEqual({ code: 'cross_book', books: ['dispatch', 'financing'] });
  });

  it('rejects missing idempotency key, zero amounts, unknown books and single lines', () => {
    const errors = validateEntry({
      ...base,
      idempotencyKey: '  ',
      lines: [{ account: 'xyz:thing', side: 'debit', amount: kobo(0n) }],
    });
    const codes = errors.map((e) => e.code).sort();
    expect(codes).toEqual(
      ['missing_idempotency_key', 'non_positive_amount', 'too_few_lines', 'unknown_book'].sort(),
    );
  });
});

describe('reversal', () => {
  it('nets every account back to zero', () => {
    const rev = reversalOf('E-1', repayment, { ...base, idempotencyKey: 'rev-001' });
    expect(validateEntry(rev)).toEqual([]);
    expect(rev.reversesEntryId).toBe('E-1');
    for (const line of repayment.lines) {
      expect(balanceOf(line.account, [repayment, rev])).toBe(0n);
    }
  });
});

describe('ledger invariants (property-based)', () => {
  const accounts = ['fin:a', 'fin:b', 'fin:c', 'fin:d'];
  const amount = fc.bigInt({ min: 1n, max: 10_000_000_000n });

  // A balanced entry: n debit lines, and credits that split the same total.
  const balancedEntry = fc
    .tuple(fc.array(fc.tuple(fc.constantFrom(...accounts), amount), { minLength: 1, maxLength: 4 }), fc.constantFrom(...accounts))
    .map(([debitLines, creditAccount], i): EntryDraft => {
      const total = debitLines.reduce((s, [, a]) => s + a, 0n);
      return {
        ...base,
        idempotencyKey: `k-${i}`,
        lines: [
          ...debitLines.map(([account, a]) => ({ account, side: 'debit' as const, amount: kobo(a) })),
          { account: creditAccount, side: 'credit' as const, amount: kobo(total) },
        ],
      };
    });

  it('any sequence of balanced entries keeps the book summing to zero', () => {
    fc.assert(
      fc.property(fc.array(balancedEntry, { minLength: 1, maxLength: 50 }), (entries) => {
        for (const e of entries) expect(validateEntry(e)).toEqual([]);
        const total = accounts.reduce((s, a) => s + balanceOf(a, entries), 0n);
        expect(total).toBe(0n);
      }),
      { numRuns: 500 },
    );
  });
});
