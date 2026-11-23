import { describe, expect, it } from 'vitest';
import { formatNaira, kobo, parseNaira, sum } from './money.js';

describe('money', () => {
  it('parses naira strings to kobo', () => {
    expect(parseNaira('1250.5')).toBe(125050n);
    expect(parseNaira('1250.05')).toBe(125005n);
    expect(parseNaira('0')).toBe(0n);
    expect(parseNaira('-3.10')).toBe(-310n);
  });

  it('rejects malformed or over-precise amounts', () => {
    expect(() => parseNaira('1.234')).toThrow();
    expect(() => parseNaira('abc')).toThrow();
    expect(() => parseNaira('1,000')).toThrow();
    expect(() => parseNaira('')).toThrow();
  });

  it('formats kobo with naira sign and separators', () => {
    expect(formatNaira(kobo(125050n))).toBe('₦1,250.50');
    expect(formatNaira(kobo(100000000n))).toBe('₦1,000,000.00');
    expect(formatNaira(kobo(-5n))).toBe('-₦0.05');
  });

  it('round-trips parse and format', () => {
    for (const s of ['0.01', '99.99', '1234567.89']) {
      expect(formatNaira(parseNaira(s)).replace(/[₦,]/g, '')).toBe(s);
    }
  });

  it('sums without precision loss beyond Number.MAX_SAFE_INTEGER', () => {
    const big = kobo(9_007_199_254_740_993n);
    expect(sum([big, kobo(1n)])).toBe(9_007_199_254_740_994n);
  });
});
