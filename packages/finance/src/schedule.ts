import type { Frequency, TermSet } from './terms.js';

export interface ScheduledInstalment {
  readonly seq: number;
  /** Calendar date in Africa/Lagos, YYYY-MM-DD. */
  readonly dueDate: string;
  readonly principal: bigint;
  readonly interest: bigint;
}

export const PERIODS_PER_YEAR: Record<Frequency, bigint> = { daily: 365n, weekly: 52n, monthly: 12n };

/** a / b rounded half away from zero, for non-negative a and positive b. */
export function divRoundHalfUp(a: bigint, b: bigint): bigint {
  return (2n * a + b) / (2n * b);
}

export function depositOf(terms: TermSet): bigint {
  return divRoundHalfUp(BigInt(terms.assetPriceKobo) * BigInt(terms.depositBps), 10_000n);
}

export function financedPrincipalOf(terms: TermSet): bigint {
  return BigInt(terms.assetPriceKobo) - depositOf(terms);
}

/**
 * Builds the repayment schedule in integer kobo. Guarantees, checked by property tests:
 *   - principal across all instalments sums exactly to the financed amount
 *   - no instalment component is negative
 *   - dates strictly increase
 */
export function generateSchedule(terms: TermSet, startDate: string): ScheduledInstalment[] {
  const P = financedPrincipalOf(terms);
  const n = terms.tenorPeriods;
  const N = BigInt(n);
  const ppy = PERIODS_PER_YEAR[terms.frequency];
  const bps = BigInt(terms.annualInterestBps);

  const principals: bigint[] = [];
  const interests: bigint[] = [];

  if (terms.interestMethod === 'flat' || bps === 0n) {
    // Flat: interest on the original principal for the whole tenor, spread evenly.
    const totalInterest = divRoundHalfUp(P * bps * N, 10_000n * ppy);
    spread(P, n, principals);
    spread(totalInterest, n, interests);
  } else {
    // Reducing balance, equal instalments. Fixed-point at 1e18 keeps rounding error far below a kobo.
    const S = 10n ** 18n;
    const r = (bps * S) / (10_000n * ppy); // periodic rate × S
    let pow = S;
    for (let i = 0; i < n; i++) pow = (pow * (S + r)) / S; // (1 + r)^n × S
    const instalment = divRoundHalfUp(P * r * pow, (pow - S) * S);
    let balance = P;
    for (let k = 1; k <= n; k++) {
      const interest = divRoundHalfUp(balance * r, S);
      let principal = k === n ? balance : instalment - interest;
      if (principal < 0n) principal = 0n;
      if (principal > balance) principal = balance;
      principals.push(principal);
      interests.push(interest);
      balance -= principal;
    }
  }

  return principals.map((principal, i) => ({
    seq: i + 1,
    dueDate: addPeriods(startDate, terms.frequency, i + 1),
    principal,
    interest: interests[i]!,
  }));
}

/** Splits total into n parts; earlier parts get the floor, the last absorbs the remainder. */
function spread(total: bigint, n: number, out: bigint[]): void {
  const N = BigInt(n);
  const base = total / N;
  for (let i = 0; i < n - 1; i++) out.push(base);
  out.push(total - base * (N - 1n));
}

export function addPeriods(date: string, frequency: Frequency, k: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  if (frequency === 'daily' || frequency === 'weekly') {
    const t = Date.UTC(y, m - 1, d) + k * (frequency === 'daily' ? 1 : 7) * 86_400_000;
    return new Date(t).toISOString().slice(0, 10);
  }
  // Monthly: same day of month, clamped to the month's last day (31 Jan → 28/29 Feb).
  const total = m - 1 + k;
  const ty = y + Math.floor(total / 12);
  const tm = (total % 12) + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Today's date in Africa/Lagos (UTC+1, no daylight saving). */
export function lagosDate(at: Date): string {
  return new Date(at.getTime() + 3_600_000).toISOString().slice(0, 10);
}
