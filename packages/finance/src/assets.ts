import { recordAudit, type PoolLike, type Queryable } from '@project/identity';
import type { FinanceProductCode } from './collections.js';

export const ASSET_KINDS = ['motorcycle', 'phone', 'equipment', 'other'] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];
export type AssetStatus =
  | 'in_stock'
  | 'assigned'
  | 'with_customer'
  | 'recovered'
  | 'for_sale'
  | 'sold'
  | 'paid_off'
  | 'title_transferred'
  | 'written_off';
export type IdKind = 'chassis' | 'imei' | 'serial';

/** Which asset kinds each product finances. School fees finance no asset. */
export const PRODUCT_ASSET_KINDS: Record<FinanceProductCode, readonly AssetKind[]> = {
  motorcycle_ride_to_own: ['motorcycle'],
  phone_financing: ['phone'],
  business_equipment_finance: ['equipment', 'other'],
  purchase_and_deliver: ['motorcycle', 'phone', 'equipment', 'other'],
  school_fee_financing: [],
};
export const productNeedsAsset = (p: FinanceProductCode) => PRODUCT_ASSET_KINDS[p].length > 0;

export class AssetError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_identifier'
      | 'duplicate'
      | 'invalid_status'
      | 'wrong_kind'
      | 'account_has_asset'
      | 'no_asset',
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** Upper-case and strip spaces, dashes and dots, so "md2 a12-bz" and "MD2A12BZ" are the same unit. */
export const normaliseId = (s: string) => s.toUpperCase().replace(/[\s.\-/]/g, '');

/** IMEI: 15 digits, last one a Luhn check digit. Catches most typos at registration. */
export function isValidImei(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = Number(imei[14 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export interface AssetRow {
  id: string;
  kind: AssetKind;
  make: string;
  model: string;
  year: number | null;
  idKind: IdKind;
  identifier: string;
  engineNumber: string | null;
  plateNumber: string | null;
  costKobo: string;
  status: AssetStatus;
  location: string;
  financeAccountId: string | null;
  reference: string | null;
  createdAt: Date;
}

const SELECT = `SELECT a.id, a.kind, a.make, a.model, a.year, a.id_kind AS "idKind", a.identifier,
                       a.engine_number AS "engineNumber", a.plate_number AS "plateNumber", a.cost_kobo::text AS "costKobo",
                       a.status, a.location, a.finance_account_id AS "financeAccountId", f.reference, a.created_at AS "createdAt"
                  FROM asset a LEFT JOIN finance_account f ON f.id = a.finance_account_id`;

type EventKind =
  | 'registered'
  | 'assigned'
  | 'unassigned'
  | 'handed_over'
  | 'moved'
  | 'recovered'
  | 'returned'
  | 'listed_for_sale'
  | 'sold'
  | 'paid_off'
  | 'title_transferred'
  | 'written_off';

async function recordEvent(
  tx: Queryable,
  e: {
    assetId: string;
    kind: EventKind;
    from: AssetStatus | null;
    to: AssetStatus;
    location?: string | null;
    financeAccountId?: string | null;
    actorId?: string | null;
    note?: string | null;
    details?: Record<string, unknown>;
    at: Date;
  },
) {
  await tx.query(
    `INSERT INTO asset_event (asset_id, occurred_at, kind, from_status, to_status, location, finance_account_id, actor_id, note, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.assetId, e.at, e.kind, e.from, e.to, e.location ?? null, e.financeAccountId ?? null, e.actorId ?? null, e.note ?? null, JSON.stringify(e.details ?? {})],
  );
}

/**
 * Moves the asset financed under an account from one of `from` to `to`. Used inside the lending
 * transactions (handover, repossession, release, closure, payoff, sale) so the asset and the
 * account can never disagree. Caller must already hold the finance account lock.
 */
export async function moveAccountAssetTx(
  tx: Queryable,
  financeAccountId: string,
  t: { from: readonly AssetStatus[]; to: AssetStatus; event: EventKind; actorId: string | null; at: Date; location?: string | null; note?: string | null; details?: Record<string, unknown> },
): Promise<{ id: string; costKobo: bigint } | null> {
  const { rows } = await tx.query<{ id: string; status: AssetStatus; location: string; cost_kobo: string }>(
    'SELECT id, status, location, cost_kobo FROM asset WHERE finance_account_id = $1 FOR UPDATE',
    [financeAccountId],
  );
  const a = rows[0];
  if (!a) return null;
  if (!t.from.includes(a.status)) throw new AssetError('invalid_status', `Asset is ${a.status}; expected ${t.from.join(' or ')}`);
  const location = t.location ?? a.location;
  await tx.query('UPDATE asset SET status = $2, location = $3 WHERE id = $1', [a.id, t.to, location]);
  await recordEvent(tx, {
    assetId: a.id,
    kind: t.event,
    from: a.status,
    to: t.to,
    location,
    financeAccountId,
    actorId: t.actorId,
    note: t.note ?? null,
    details: t.details ?? {},
    at: t.at,
  });
  return { id: a.id, costKobo: BigInt(a.cost_kobo) };
}

export async function accountAssetTx(tx: Queryable, financeAccountId: string): Promise<{ id: string; status: AssetStatus } | null> {
  const { rows } = await tx.query<{ id: string; status: AssetStatus }>('SELECT id, status FROM asset WHERE finance_account_id = $1', [financeAccountId]);
  return rows[0] ?? null;
}

async function inTx<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export interface RegisterAsset {
  kind: AssetKind;
  make: string;
  model: string;
  year?: number | null;
  idKind: IdKind;
  identifier: string;
  engineNumber?: string | null;
  plateNumber?: string | null;
  costKobo: bigint;
  location: string;
}

export class AssetService {
  constructor(
    private readonly pool: PoolLike,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async register(input: RegisterAsset, actorId: string): Promise<AssetRow> {
    const identifier = normaliseId(input.identifier);
    if (input.kind === 'phone' && input.idKind !== 'imei') throw new AssetError('invalid_identifier', 'Phones are registered by IMEI');
    if (input.kind === 'motorcycle' && input.idKind !== 'chassis') throw new AssetError('invalid_identifier', 'Motorcycles are registered by chassis number');
    if (input.idKind === 'imei' && !isValidImei(identifier)) throw new AssetError('invalid_identifier', 'IMEI must be 15 digits with a valid check digit');
    if (!/^[A-Z0-9]{5,40}$/.test(identifier)) throw new AssetError('invalid_identifier', 'Identifier must be 5 to 40 letters or digits');
    if (input.costKobo < 0n) throw new AssetError('invalid_identifier', 'Cost cannot be negative');
    return inTx(this.pool, async (tx) => {
      let id: string;
      try {
        const r = await tx.query<{ id: string }>(
          `INSERT INTO asset (kind, make, model, year, id_kind, identifier, engine_number, plate_number, cost_kobo, location, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            input.kind,
            input.make.trim(),
            input.model.trim(),
            input.year ?? null,
            input.idKind,
            identifier,
            input.engineNumber ? normaliseId(input.engineNumber) : null,
            input.plateNumber ? normaliseId(input.plateNumber) : null,
            input.costKobo.toString(),
            input.location.trim(),
            actorId,
          ],
        );
        id = r.rows[0]!.id;
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AssetError('duplicate', 'An asset with this identifier or plate is already registered');
        throw e;
      }
      await recordEvent(tx, { assetId: id, kind: 'registered', from: null, to: 'in_stock', location: input.location.trim(), actorId, at: this.clock() });
      await recordAudit(tx, { actorId, actorKind: 'person', action: 'asset.registered', subjectType: 'asset', subjectId: id, details: { identifier } });
      return (await this.getTx(tx, id))!;
    });
  }

  private async getTx(db: Queryable, id: string): Promise<AssetRow | null> {
    const { rows } = await db.query<AssetRow>(`${SELECT} WHERE a.id = $1`, [id]);
    return rows[0] ?? null;
  }

  async get(id: string) {
    const asset = await this.getTx(this.pool, id);
    if (!asset) throw new AssetError('not_found');
    const events = await this.pool.query(
      `SELECT e.occurred_at AS "occurredAt", e.kind, e.from_status AS "fromStatus", e.to_status AS "toStatus", e.location,
              f.reference, e.note, e.details, p.full_name AS "actorName"
         FROM asset_event e LEFT JOIN finance_account f ON f.id = e.finance_account_id LEFT JOIN person p ON p.id = e.actor_id
        WHERE e.asset_id = $1 ORDER BY e.id`,
      [id],
    );
    return { asset, events: events.rows };
  }

  async forAccount(financeAccountId: string): Promise<AssetRow | null> {
    const { rows } = await this.pool.query<AssetRow>(`${SELECT} WHERE a.finance_account_id = $1`, [financeAccountId]);
    return rows[0] ?? null;
  }

  /** Search by status, or by identifier / plate / account reference fragment. */
  async list(filter: { status?: AssetStatus; q?: string } = {}): Promise<AssetRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.status) where.push(`a.status = $${args.push(filter.status)}`);
    if (filter.q) {
      const q = normaliseId(filter.q);
      if (q) where.push(`(a.identifier LIKE $${args.push(`%${q}%`)} OR a.plate_number LIKE $${args.length} OR f.reference LIKE $${args.length})`);
    }
    const { rows } = await this.pool.query<AssetRow>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT 200`, args);
    return rows;
  }

  /** Reserves an in-stock asset for an approved (or signed) application of a product that finances that kind. */
  async assign(assetId: string, financeAccountId: string, actorId: string): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const fa = (
        await tx.query<{ id: string; reference: string; status: string; product_code: FinanceProductCode }>(
          'SELECT id, reference, status, product_code FROM finance_account WHERE id = $1 FOR UPDATE',
          [financeAccountId],
        )
      ).rows[0];
      if (!fa) throw new AssetError('not_found', 'Account not found');
      if (!['approved', 'contracted'].includes(fa.status)) throw new AssetError('invalid_status', `Account is ${fa.status}; assign after approval and before handover`);
      if (await accountAssetTx(tx, fa.id)) throw new AssetError('account_has_asset', 'This account already has an asset');
      const a = (await tx.query<{ id: string; kind: AssetKind; status: AssetStatus; location: string }>('SELECT id, kind, status, location FROM asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0];
      if (!a) throw new AssetError('not_found');
      if (a.status !== 'in_stock') throw new AssetError('invalid_status', `Asset is ${a.status}`);
      if (!PRODUCT_ASSET_KINDS[fa.product_code].includes(a.kind)) throw new AssetError('wrong_kind', `A ${a.kind} cannot be financed under ${fa.product_code}`);
      await tx.query(`UPDATE asset SET status = 'assigned', finance_account_id = $2 WHERE id = $1`, [a.id, fa.id]);
      await recordEvent(tx, { assetId: a.id, kind: 'assigned', from: 'in_stock', to: 'assigned', location: a.location, financeAccountId: fa.id, actorId, at: this.clock() });
      await recordAudit(tx, { actorId, actorKind: 'person', action: 'asset.assigned', subjectType: 'finance_account', subjectId: fa.reference, details: { assetId: a.id } });
    });
  }

  /** Releases an assigned asset back to stock (wrong unit picked), only before handover. */
  async unassign(assetId: string, actorId: string, note: string): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const pre = (await tx.query<{ finance_account_id: string | null }>('SELECT finance_account_id FROM asset WHERE id = $1', [assetId])).rows[0];
      if (!pre) throw new AssetError('not_found');
      if (pre.finance_account_id) await tx.query('SELECT 1 FROM finance_account WHERE id = $1 FOR UPDATE', [pre.finance_account_id]);
      const a = (await tx.query<{ status: AssetStatus; location: string; finance_account_id: string | null }>('SELECT status, location, finance_account_id FROM asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0]!;
      if (a.status !== 'assigned') throw new AssetError('invalid_status', `Asset is ${a.status}; only an assigned asset can be returned to stock`);
      await tx.query(`UPDATE asset SET status = 'in_stock', finance_account_id = NULL WHERE id = $1`, [assetId]);
      await recordEvent(tx, { assetId, kind: 'unassigned', from: 'assigned', to: 'in_stock', location: a.location, financeAccountId: a.finance_account_id, actorId, note, at: this.clock() });
    });
  }

  /** Records where the asset is now (yard, workshop, branch). */
  async move(assetId: string, location: string, actorId: string, note: string | null): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const a = (await tx.query<{ status: AssetStatus }>('SELECT status FROM asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0];
      if (!a) throw new AssetError('not_found');
      if (['sold', 'written_off', 'title_transferred'].includes(a.status)) throw new AssetError('invalid_status', `Asset is ${a.status}`);
      await tx.query('UPDATE asset SET location = $2 WHERE id = $1', [assetId, location.trim()]);
      await recordEvent(tx, { assetId, kind: 'moved', from: a.status, to: a.status, location: location.trim(), actorId, note, at: this.clock() });
    });
  }

  /** After payoff: the ownership papers have been handed to the customer. */
  async titleTransferred(assetId: string, actorId: string, note: string): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const pre = (await tx.query<{ finance_account_id: string | null }>('SELECT finance_account_id FROM asset WHERE id = $1', [assetId])).rows[0];
      if (!pre?.finance_account_id) throw new AssetError('not_found');
      const fa = (await tx.query<{ status: string; reference: string }>('SELECT status, reference FROM finance_account WHERE id = $1 FOR UPDATE', [pre.finance_account_id])).rows[0]!;
      if (fa.status !== 'settled') throw new AssetError('invalid_status', `Account is ${fa.status}; title is transferred only after payoff`);
      await moveAccountAssetTx(tx, pre.finance_account_id, { from: ['paid_off'], to: 'title_transferred', event: 'title_transferred', actorId, at: this.clock(), note });
      await tx.query(`UPDATE finance_account SET status = 'title_transferred' WHERE id = $1`, [pre.finance_account_id]);
      await recordAudit(tx, { actorId, actorKind: 'person', action: 'asset.title_transferred', subjectType: 'finance_account', subjectId: fa.reference, details: { assetId, note } });
    });
  }

  /**
   * Damaged beyond use, stolen from the yard, or registered by mistake. Only for assets the
   * company holds; an asset with a customer stays on their account.
   */
  async writeOff(assetId: string, actorId: string, reason: string): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const pre = (await tx.query<{ finance_account_id: string | null }>('SELECT finance_account_id FROM asset WHERE id = $1', [assetId])).rows[0];
      if (!pre) throw new AssetError('not_found');
      if (pre.finance_account_id) await tx.query('SELECT 1 FROM finance_account WHERE id = $1 FOR UPDATE', [pre.finance_account_id]);
      const a = (await tx.query<{ status: AssetStatus; location: string }>('SELECT status, location FROM asset WHERE id = $1 FOR UPDATE', [assetId])).rows[0]!;
      if (!['in_stock', 'recovered', 'for_sale'].includes(a.status)) throw new AssetError('invalid_status', `Asset is ${a.status}; only stock or recovered assets can be written off`);
      await tx.query(`UPDATE asset SET status = 'written_off' WHERE id = $1`, [assetId]);
      await recordEvent(tx, { assetId, kind: 'written_off', from: a.status, to: 'written_off', location: a.location, financeAccountId: pre.finance_account_id, actorId, note: reason, at: this.clock() });
      await recordAudit(tx, { actorId, actorKind: 'person', action: 'asset.written_off', subjectType: 'asset', subjectId: assetId, details: { reason } });
    });
  }
}
