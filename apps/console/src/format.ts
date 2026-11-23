import { formatNaira, kobo } from '@project/domain';

/** The API sends money as integer-kobo strings. Never parse them as floats. */
export function naira(koboString: string | null | undefined): string {
  if (koboString === null || koboString === undefined || !/^-?\d+$/.test(koboString)) return '—';
  return formatNaira(kobo(BigInt(koboString)));
}

/** "₦1,500,000" or "1500000.50" → integer-kobo string. Throws on anything ambiguous. */
export function toKobo(input: string): string {
  const clean = input.replace(/[₦,\s]/g, '');
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) throw new Error('Enter an amount like 1500000 or 1,500,000.50');
  const value = BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
  if (value <= 0n) throw new Error('Amount must be more than zero');
  return value.toString();
}

export function bps(n: number): string {
  return `${(n / 100).toFixed(2).replace(/\.00$/, '')}%`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short' });
}

export const STATUS_LABEL: Record<string, string> = {
  applied: 'Applied',
  approved: 'Approved',
  contracted: 'Contracted',
  deposit_paid: 'Deposit paid',
  active: 'Active',
  in_arrears: 'In arrears',
  repossession_review: 'Repossession review',
  repossessed: 'Repossessed',
  closed_recovered: 'Closed (recovered)',
  settled: 'Settled',
  title_transferred: 'Title transferred',
  declined: 'Declined',
  withdrawn: 'Withdrawn',
  written_off: 'Written off',
};

export const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  active: 'good',
  settled: 'good',
  title_transferred: 'good',
  in_arrears: 'warn',
  repossession_review: 'bad',
  repossessed: 'bad',
  closed_recovered: 'bad',
  written_off: 'bad',
};
