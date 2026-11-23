/**
 * Money is always integer kobo (1 NGN = 100 kobo) held as bigint.
 * The brand prevents a plain bigint or number being passed where money is expected.
 */
export type Kobo = bigint & { readonly __brand: 'Kobo' };

export const KOBO_PER_NAIRA = 100n;

export function kobo(value: bigint): Kobo {
  return value as Kobo;
}

/** Parse a naira amount written as a decimal string, e.g. "1250.50". Rejects more than 2 decimal places. */
export function parseNaira(input: string): Kobo {
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid naira amount: "${input}"`);
  }
  const [, sign, whole, frac = ''] = match;
  const value = BigInt(whole!) * KOBO_PER_NAIRA + BigInt(frac.padEnd(2, '0'));
  return kobo(sign ? -value : value);
}

/** Format kobo as a naira string with the ₦ symbol and thousands separators, e.g. "₦1,250.50". */
export function formatNaira(amount: Kobo): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const whole = (abs / KOBO_PER_NAIRA).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = (abs % KOBO_PER_NAIRA).toString().padStart(2, '0');
  return `${negative ? '-' : ''}₦${whole}.${frac}`;
}

export function sum(amounts: readonly Kobo[]): Kobo {
  return kobo(amounts.reduce<bigint>((acc, a) => acc + a, 0n));
}
