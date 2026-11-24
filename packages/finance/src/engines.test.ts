import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { allocate, DEFAULT_WATERFALL, type Bucket, type Due } from './allocation.js';
import { addPeriods, daysBetween, depositOf, financedPrincipalOf, generateSchedule, lagosDate } from './schedule.js';
import { MOTORCYCLE_PLACEHOLDER_TIERS, resolveTerms, validateTierConfig, type TermSet } from './terms.js';

const tierA = MOTORCYCLE_PLACEHOLDER_TIERS.A;

const baseTerms: TermSet = {
  assetPriceKobo: '150000000', // ₦1,500,000
  depositBps: 2_000,
  tenorPeriods: 52,
  frequency: 'weekly',
  interestMethod: 'flat',
  annualInterestBps: 3_600,
  penaltyBpsPerDay: 10,
  graceDays: 1,
  repossessionReviewDaysOverdue: 14,
  reactivationWindowDays: 10,
  guarantorsRequired: 1,
  guarantorMaxLiabilityBps: 10_000,
};

describe('tier presets and term resolution', () => {
  it('placeholder tiers are internally valid', () => {
    for (const t of Object.values(MOTORCYCLE_PLACEHOLDER_TIERS)) expect(validateTierConfig(t)).toEqual([]);
  });

  it('rejects a tier whose default is outside its own bounds', () => {
    const bad = { ...tierA, bounds: { ...tierA.bounds, depositBps: { default: 500, min: 1000, max: 2000 } } };
    expect(validateTierConfig(bad)).toContain('depositBps');
  });

  it('uses defaults when nothing is overridden', () => {
    const r = resolveTerms(tierA, { assetPriceKobo: '150000000' });
    expect(r.terms.depositBps).toBe(tierA.bounds.depositBps.default);
    expect(r.overridden).toEqual([]);
    expect(r.outOfBounds).toEqual([]);
  });

  it('reports adjustments inside and outside the bounds separately', () => {
    const r = resolveTerms(tierA, { assetPriceKobo: '150000000', depositBps: 2_000, tenorPeriods: 100 });
    expect(r.overridden.sort()).toEqual(['depositBps', 'tenorPeriods']);
    expect(r.outOfBounds).toEqual(['tenorPeriods']);
  });

  it('flags an asset price outside the tier range', () => {
    expect(resolveTerms(tierA, { assetPriceKobo: '1000' }).outOfBounds).toContain('assetPriceKobo');
  });

  it('throws for values no approval can authorise', () => {
    expect(() => resolveTerms(tierA, { assetPriceKobo: '150000000', depositBps: 10_001 })).toThrow();
    expect(() => resolveTerms(tierA, { assetPriceKobo: '150000000', tenorPeriods: 1.5 })).toThrow();
    expect(() => resolveTerms(tierA, { assetPriceKobo: '-1' })).toThrow();
  });
});

describe('schedule generator', () => {
  it('flat: ₦1.5m bike, 20% deposit, 36% p.a., 52 weeks', () => {
    const s = generateSchedule(baseTerms, '2026-12-01');
    expect(depositOf(baseTerms)).toBe(30_000_000n);
    expect(financedPrincipalOf(baseTerms)).toBe(120_000_000n);
    expect(s).toHaveLength(52);
    // 1,200,000 × 36% × 52/52 = ₦432,000 interest
    expect(s.reduce((a, i) => a + i.interest, 0n)).toBe(43_200_000n);
    expect(s[0]).toEqual({ seq: 1, dueDate: '2026-12-08', principal: 2_307_692n, interest: 830_769n });
    expect(s.at(-1)!.dueDate).toBe('2027-11-30');
  });

  it('reducing balance pays less total interest than flat at the same rate', () => {
    const flat = generateSchedule(baseTerms, '2026-12-01');
    const red = generateSchedule({ ...baseTerms, interestMethod: 'reducing' }, '2026-12-01');
    const sum = (xs: typeof flat) => xs.reduce((a, i) => a + i.interest, 0n);
    expect(sum(red)).toBeLessThan(sum(flat));
    // equal instalments except the last, which absorbs rounding
    const totals = red.slice(0, -1).map((i) => i.principal + i.interest);
    expect(new Set(totals).size).toBe(1);
  });

  it('zero interest is principal only', () => {
    const s = generateSchedule({ ...baseTerms, annualInterestBps: 0, interestMethod: 'reducing' }, '2026-12-01');
    expect(s.every((i) => i.interest === 0n)).toBe(true);
  });

  const termsArb = fc.record({
    assetPriceKobo: fc.bigInt({ min: 10_000n, max: 10_000_000_000n }).map(String),
    depositBps: fc.integer({ min: 0, max: 9_000 }),
    tenorPeriods: fc.integer({ min: 1, max: 400 }),
    frequency: fc.constantFrom('daily' as const, 'weekly' as const, 'monthly' as const),
    interestMethod: fc.constantFrom('flat' as const, 'reducing' as const),
    annualInterestBps: fc.integer({ min: 0, max: 20_000 }),
  });

  it('for any terms: principal sums exactly to the financed amount, nothing negative, dates increase', () => {
    fc.assert(
      fc.property(termsArb, (t) => {
        const terms = { ...baseTerms, ...t };
        const s = generateSchedule(terms, '2026-01-31');
        expect(s.reduce((a, i) => a + i.principal, 0n)).toBe(financedPrincipalOf(terms));
        for (const i of s) {
          expect(i.principal >= 0n && i.interest >= 0n).toBe(true);
        }
        for (let k = 1; k < s.length; k++) expect(s[k]!.dueDate > s[k - 1]!.dueDate).toBe(true);
      }),
      { numRuns: 400 },
    );
  }, 60_000); // hundreds of random schedules: seconds locally, longer on shared CI machines

  it('monthly dates clamp to month end and keep the anchor day', () => {
    expect(addPeriods('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addPeriods('2026-01-31', 'monthly', 2)).toBe('2026-03-31');
    expect(addPeriods('2027-11-30', 'monthly', 3)).toBe('2028-02-29');
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('uses the Lagos calendar date', () => {
    expect(lagosDate(new Date('2026-11-30T23:30:00Z'))).toBe('2026-12-01');
    expect(lagosDate(new Date('2026-11-30T22:30:00Z'))).toBe('2026-11-30');
  });
});

describe('allocation waterfall', () => {
  const asOf = '2026-12-15';
  const dues: Due[] = [
    { component: 'principal', instalmentId: '2', seq: 2, dueDate: '2026-12-15', amount: 1000n },
    { component: 'interest', instalmentId: '2', seq: 2, dueDate: '2026-12-15', amount: 300n },
    { component: 'principal', instalmentId: '1', seq: 1, dueDate: '2026-12-08', amount: 1000n },
    { component: 'interest', instalmentId: '1', seq: 1, dueDate: '2026-12-08', amount: 300n },
    { component: 'penalty', amount: 50n },
    { component: 'fee', feeChargeId: 'f1', since: '2026-12-01', amount: 200n },
  ];

  it('pays fees, then penalty, then overdue interest and principal, then current', () => {
    const { allocations, remaining } = allocate(dues, 1_600n, asOf);
    expect(allocations.map((a) => [a.component, 'seq' in a ? a.seq : null, a.allocated])).toEqual([
      ['fee', null, 200n],
      ['penalty', null, 50n],
      ['interest', 1, 300n],
      ['principal', 1, 1000n],
      ['interest', 2, 50n],
    ]);
    expect(remaining).toBe(0n);
  });

  it('leaves overpayment as credit', () => {
    const { remaining } = allocate(dues, 5_000n, asOf);
    expect(remaining).toBe(5_000n - 2_850n);
  });

  it('honours a configured order', () => {
    const order: Bucket[] = ['overdue_principal', 'overdue_interest', 'current_principal', 'current_interest', 'penalty', 'fee'];
    const { allocations } = allocate(dues, 1_000n, asOf, order);
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({ component: 'principal', seq: 1, allocated: 1000n });
  });

  it('refuses future dues and incomplete waterfalls', () => {
    expect(() =>
      allocate([{ component: 'principal', instalmentId: '9', seq: 9, dueDate: '2027-01-01', amount: 1n }], 1n, asOf),
    ).toThrow();
    expect(() => allocate(dues, 1n, asOf, ['fee'])).toThrow();
  });

  it('never allocates more than available or more than owed (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 20 }),
        fc.bigInt({ min: 0n, max: 30_000_000n }),
        fc.shuffledSubarray([...DEFAULT_WATERFALL], { minLength: 6, maxLength: 6 }),
        (amounts, available, order) => {
          const ds: Due[] = amounts.map((amount, i) => ({
            component: i % 2 ? 'interest' : 'principal',
            instalmentId: String(i),
            seq: i,
            dueDate: i % 3 ? '2026-12-01' : asOf,
            amount,
          }));
          const owed = amounts.reduce((a, b) => a + b, 0n);
          const { allocations, remaining } = allocate(ds, available, asOf, order);
          const paid = allocations.reduce((a, x) => a + x.allocated, 0n);
          expect(paid + remaining).toBe(available);
          expect(paid <= owed).toBe(true);
          for (const a of allocations) expect(a.allocated > 0n && a.allocated <= a.amount).toBe(true);
          expect(remaining === 0n || paid === owed).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
