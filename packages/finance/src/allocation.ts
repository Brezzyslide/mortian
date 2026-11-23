/**
 * Payment waterfall. Pure: takes what is owed now and how much credit is available,
 * returns how to split it. Only amounts already due are paid; anything left stays as
 * credit and is applied when the next instalment falls due.
 */
export type Bucket = 'fee' | 'penalty' | 'overdue_interest' | 'overdue_principal' | 'current_interest' | 'current_principal';

export const DEFAULT_WATERFALL: readonly Bucket[] = [
  'fee',
  'penalty',
  'overdue_interest',
  'overdue_principal',
  'current_interest',
  'current_principal',
];

export type Due =
  | { readonly component: 'fee'; readonly feeChargeId: string; readonly since: string; readonly amount: bigint }
  | { readonly component: 'penalty'; readonly amount: bigint }
  | {
      readonly component: 'interest' | 'principal';
      readonly instalmentId: string;
      readonly seq: number;
      readonly dueDate: string;
      readonly amount: bigint;
    };

export type Allocated = Due & { readonly allocated: bigint };

export function bucketOf(d: Due, asOf: string): Bucket {
  if (d.component === 'fee' || d.component === 'penalty') return d.component;
  const when = d.dueDate < asOf ? 'overdue' : 'current';
  return `${when}_${d.component}` as Bucket;
}

export function allocate(
  dues: readonly Due[],
  available: bigint,
  asOf: string,
  waterfall: readonly Bucket[] = DEFAULT_WATERFALL,
): { allocations: Allocated[]; remaining: bigint } {
  if (available < 0n) throw new Error('available credit cannot be negative');
  if (new Set(waterfall).size !== DEFAULT_WATERFALL.length || !DEFAULT_WATERFALL.every((b) => waterfall.includes(b))) {
    throw new Error('waterfall must list every bucket exactly once');
  }
  for (const d of dues) {
    if (d.amount <= 0n) throw new Error('dues must be positive');
    if ('dueDate' in d && d.dueDate > asOf) throw new Error('future instalments are not due');
  }

  const rank = (d: Due) => waterfall.indexOf(bucketOf(d, asOf));
  const ordered = [...dues].sort((a, b) => {
    const byBucket = rank(a) - rank(b);
    if (byBucket !== 0) return byBucket;
    const ka = 'dueDate' in a ? `${a.dueDate}#${String(a.seq).padStart(6, '0')}` : 'since' in a ? a.since : '';
    const kb = 'dueDate' in b ? `${b.dueDate}#${String(b.seq).padStart(6, '0')}` : 'since' in b ? b.since : '';
    return ka < kb ? -1 : ka > kb ? 1 : 0; // oldest first within a bucket
  });

  let remaining = available;
  const allocations: Allocated[] = [];
  for (const d of ordered) {
    if (remaining === 0n) break;
    const take = d.amount < remaining ? d.amount : remaining;
    allocations.push({ ...d, allocated: take });
    remaining -= take;
  }
  return { allocations, remaining };
}
