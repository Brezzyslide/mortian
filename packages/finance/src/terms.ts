/**
 * Terms a borrower is approved on. Rates are integer basis points (1 bp = 0.01%),
 * money is integer kobo as a decimal string (JSON-safe), durations are whole days or periods.
 */
export type Frequency = 'daily' | 'weekly' | 'monthly';
export type InterestMethod = 'flat' | 'reducing';

export interface TermSet {
  readonly assetPriceKobo: string;
  readonly depositBps: number;
  readonly tenorPeriods: number;
  readonly frequency: Frequency;
  readonly interestMethod: InterestMethod;
  readonly annualInterestBps: number;
  readonly penaltyBpsPerDay: number;
  readonly graceDays: number;
  readonly repossessionReviewDaysOverdue: number;
  readonly reactivationWindowDays: number;
  readonly guarantorsRequired: number;
  readonly guarantorMaxLiabilityBps: number;
}

export const NUMERIC_TERMS = [
  'depositBps',
  'tenorPeriods',
  'annualInterestBps',
  'penaltyBpsPerDay',
  'graceDays',
  'repossessionReviewDaysOverdue',
  'reactivationWindowDays',
  'guarantorsRequired',
  'guarantorMaxLiabilityBps',
] as const;
export type NumericTerm = (typeof NUMERIC_TERMS)[number];

export interface Bound {
  readonly default: number;
  readonly min: number;
  readonly max: number;
}

export interface TierConfig {
  readonly frequency: Frequency;
  readonly interestMethod: InterestMethod;
  readonly assetPriceKobo: { readonly min: string; readonly max: string };
  readonly bounds: { readonly [K in NumericTerm]: Bound };
}

/** Hard limits no tier may exceed, whatever an admin configures. */
const ABSOLUTE: { readonly [K in NumericTerm]: readonly [number, number] } = {
  depositBps: [0, 10_000],
  tenorPeriods: [1, 2_000],
  annualInterestBps: [0, 20_000],
  penaltyBpsPerDay: [0, 500],
  graceDays: [0, 60],
  repossessionReviewDaysOverdue: [1, 365],
  reactivationWindowDays: [1, 180],
  guarantorsRequired: [0, 5],
  guarantorMaxLiabilityBps: [0, 10_000],
};

export function validateTierConfig(c: TierConfig): string[] {
  const problems: string[] = [];
  if (!['daily', 'weekly', 'monthly'].includes(c.frequency)) problems.push('frequency');
  if (!['flat', 'reducing'].includes(c.interestMethod)) problems.push('interestMethod');
  const pMin = parseKobo(c.assetPriceKobo?.min);
  const pMax = parseKobo(c.assetPriceKobo?.max);
  if (pMin === null || pMax === null || pMin <= 0n || pMin > pMax) problems.push('assetPriceKobo');
  for (const k of NUMERIC_TERMS) {
    const b = c.bounds?.[k];
    const [lo, hi] = ABSOLUTE[k];
    if (
      !b ||
      ![b.min, b.default, b.max].every(Number.isInteger) ||
      b.min > b.default ||
      b.default > b.max ||
      b.min < lo ||
      b.max > hi
    ) {
      problems.push(k);
    }
  }
  return problems;
}

export interface ResolvedTerms {
  readonly terms: TermSet;
  /** Terms the underwriter changed from the tier default. */
  readonly overridden: NumericTerm[];
  /** Overridden terms outside the tier's floor and ceiling: need a second approver. */
  readonly outOfBounds: (NumericTerm | 'assetPriceKobo')[];
}

/**
 * Applies an underwriter's adjustments to a tier's defaults. Never throws for values outside
 * the tier bounds (they are reported so the caller can require approval); throws for values
 * outside the absolute limits, which no approval can authorise.
 */
export function resolveTerms(
  config: TierConfig,
  input: { assetPriceKobo: string } & Partial<Pick<TermSet, NumericTerm>>,
): ResolvedTerms {
  const price = parseKobo(input.assetPriceKobo);
  if (price === null || price <= 0n) throw new Error('assetPriceKobo must be a positive integer kobo string');

  const overridden: NumericTerm[] = [];
  const outOfBounds: (NumericTerm | 'assetPriceKobo')[] = [];
  const values = {} as Record<NumericTerm, number>;

  for (const k of NUMERIC_TERMS) {
    const b = config.bounds[k];
    const given = input[k];
    if (given === undefined) {
      values[k] = b.default;
      continue;
    }
    const [lo, hi] = ABSOLUTE[k];
    if (!Number.isInteger(given) || given < lo || given > hi) throw new Error(`${k} must be an integer in [${lo}, ${hi}]`);
    values[k] = given;
    if (given !== b.default) overridden.push(k);
    if (given < b.min || given > b.max) outOfBounds.push(k);
  }
  if (price < BigInt(config.assetPriceKobo.min) || price > BigInt(config.assetPriceKobo.max)) {
    outOfBounds.push('assetPriceKobo');
  }

  return {
    terms: {
      assetPriceKobo: price.toString(),
      frequency: config.frequency,
      interestMethod: config.interestMethod,
      ...values,
    },
    overridden,
    outOfBounds,
  };
}

function parseKobo(s: unknown): bigint | null {
  return typeof s === 'string' && /^\d{1,18}$/.test(s) ? BigInt(s) : null;
}

const naira = (n: number) => (BigInt(n) * 100n).toString();
const bound = (d: number, min: number, max: number): Bound => ({ default: d, min, max });

/**
 * PLACEHOLDER motorcycle tiers so the system can run end to end before real pricing exists.
 * Every snapshot made from these is marked is_placeholder and shown as such in the console.
 * Replace through the tier admin screen; nothing here is a pricing recommendation.
 */
export const MOTORCYCLE_PLACEHOLDER_TIERS: Readonly<Record<'A' | 'B' | 'C', TierConfig>> = {
  A: {
    frequency: 'weekly',
    interestMethod: 'flat',
    assetPriceKobo: { min: naira(800_000), max: naira(2_500_000) },
    bounds: {
      depositBps: bound(1_500, 1_000, 2_500),
      tenorPeriods: bound(52, 40, 78),
      annualInterestBps: bound(3_000, 2_500, 3_500),
      penaltyBpsPerDay: bound(10, 5, 15),
      graceDays: bound(2, 0, 3),
      repossessionReviewDaysOverdue: bound(21, 14, 28),
      reactivationWindowDays: bound(14, 7, 21),
      guarantorsRequired: bound(1, 1, 2),
      guarantorMaxLiabilityBps: bound(10_000, 5_000, 10_000),
    },
  },
  B: {
    frequency: 'weekly',
    interestMethod: 'flat',
    assetPriceKobo: { min: naira(800_000), max: naira(2_500_000) },
    bounds: {
      depositBps: bound(2_000, 1_500, 3_000),
      tenorPeriods: bound(52, 40, 78),
      annualInterestBps: bound(3_600, 3_000, 4_200),
      penaltyBpsPerDay: bound(10, 5, 20),
      graceDays: bound(1, 0, 2),
      repossessionReviewDaysOverdue: bound(14, 10, 21),
      reactivationWindowDays: bound(10, 7, 14),
      guarantorsRequired: bound(1, 1, 2),
      guarantorMaxLiabilityBps: bound(10_000, 5_000, 10_000),
    },
  },
  C: {
    frequency: 'weekly',
    interestMethod: 'flat',
    assetPriceKobo: { min: naira(800_000), max: naira(2_000_000) },
    bounds: {
      depositBps: bound(3_000, 2_500, 4_000),
      tenorPeriods: bound(52, 26, 52),
      annualInterestBps: bound(4_200, 3_600, 4_800),
      penaltyBpsPerDay: bound(15, 10, 25),
      graceDays: bound(0, 0, 1),
      repossessionReviewDaysOverdue: bound(10, 7, 14),
      reactivationWindowDays: bound(7, 5, 10),
      guarantorsRequired: bound(2, 1, 3),
      guarantorMaxLiabilityBps: bound(10_000, 7_500, 10_000),
    },
  },
};
