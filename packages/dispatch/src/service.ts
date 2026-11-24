import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Checkout, Messaging, Point, Routes } from '@project/adapters';
import { haversineMeters } from '@project/adapters';
import { formatNaira, kobo } from '@project/domain';
import { maskPhone, normalizeNigerianMobile, recordAudit, type PoolLike, type Queryable } from '@project/identity';
import { accountBalance, postEntryInTx, type LedgerLine } from '@project/ledger';

/** Dispatch book accounts. Nothing here ever touches the financing book. */
export const dsp = {
  clearing: (provider: string) => `dsp:clearing:${provider}`,
  prepaid: (jobRef: string) => `dsp:prepaid:${jobRef}`,
  /** Credit balance: we owe the rider. Debit balance: the rider owes us (cash commissions). */
  rider: (riderRef: string) => `dsp:rider:${riderRef}`,
  commission: 'dsp:income:commission',
  refund: (jobRef: string) => `dsp:refund_payable:${jobRef}`,
};

export class DispatchError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'not_live'
      | 'no_pricing'
      | 'quote_expired'
      | 'quote_used'
      | 'invalid_phone'
      | 'invalid_status'
      | 'not_a_rider'
      | 'rider_not_active'
      | 'already_rider'
      | 'finance_account_not_eligible'
      | 'licence_not_accepted'
      | 'job_taken'
      | 'rider_busy'
      | 'cash_debt_limit'
      | 'too_far'
      | 'code_invalid'
      | 'code_locked'
      | 'own_job'
      | 'same_person',
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface PricingInput {
  baseFareKobo: bigint;
  perKmKobo: bigint;
  minFareKobo: bigint;
  commissionBps: number;
  cashDebtLimitKobo: bigint;
  searchRadiusM: number;
}

/** Placeholder prices for testing. Not market research: set real ones in the console. */
export const PLACEHOLDER_PRICING: PricingInput = {
  baseFareKobo: 50_000n, // ₦500
  perKmKobo: 15_000n, // ₦150 / km
  minFareKobo: 100_000n, // ₦1,000
  commissionBps: 2000, // 20%
  cashDebtLimitKobo: 500_000n, // ₦5,000
  searchRadiusM: 5000,
};

export const QUOTE_TTL_MS = 10 * 60 * 1000;
const CODE_ATTEMPTS = 5;
/** A delivery confirmed this far from the drop-off is flagged for review (GPS is imprecise, so not refused). */
const DROPOFF_FLAG_METERS = 500;

/** Fare in whole naira: base + distance, never below the minimum. Integer kobo throughout. */
export function fareFor(distanceM: number, p: PricingInput): { fare: bigint; commission: bigint } {
  const raw = p.baseFareKobo + (BigInt(distanceM) * p.perKmKobo + 999n) / 1000n;
  const fare = ((raw > p.minFareKobo ? raw : p.minFareKobo) + 99n) / 100n * 100n;
  const commission = (fare * BigInt(p.commissionBps) + 5_000n) / 10_000n;
  return { fare, commission };
}

interface JobRow {
  id: string;
  reference: string;
  customer_id: string;
  status: string;
  payment_method: 'cash' | 'in_app';
  rider_id: string | null;
  fare_kobo: string;
  commission_kobo: string;
  recipient_phone: string;
  pickup_attempts: number;
  delivery_attempts: number;
  dropoff_lat: number;
  dropoff_lng: number;
  pickup_lat: number;
  pickup_lng: number;
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

export class DispatchService {
  constructor(
    private readonly pool: PoolLike,
    private readonly routes: Routes,
    private readonly checkout: Checkout,
    private readonly messaging: Messaging,
    private readonly opts: { codePepper: Buffer },
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // ---------------- pricing ----------------

  async currentPricing(db: Queryable = this.pool) {
    const { rows } = await db.query<{
      id: string;
      base_fare_kobo: string;
      per_km_kobo: string;
      min_fare_kobo: string;
      commission_bps: number;
      cash_debt_limit_kobo: string;
      search_radius_m: number;
      is_placeholder: boolean;
      created_at: Date;
    }>('SELECT * FROM dispatch_pricing ORDER BY version DESC LIMIT 1');
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      isPlaceholder: r.is_placeholder,
      createdAt: r.created_at,
      baseFareKobo: BigInt(r.base_fare_kobo),
      perKmKobo: BigInt(r.per_km_kobo),
      minFareKobo: BigInt(r.min_fare_kobo),
      commissionBps: r.commission_bps,
      cashDebtLimitKobo: BigInt(r.cash_debt_limit_kobo),
      searchRadiusM: r.search_radius_m,
    };
  }

  /** A new pricing version; quotes already given keep theirs. */
  async setPricing(p: PricingInput, actorId: string | null, isPlaceholder = false) {
    if (p.minFareKobo <= 0n || p.baseFareKobo < 0n || p.perKmKobo < 0n || p.cashDebtLimitKobo < 0n) throw new DispatchError('no_pricing', 'Prices must not be negative');
    if (p.commissionBps < 0 || p.commissionBps > 5000) throw new DispatchError('no_pricing', 'Commission must be between 0% and 50%');
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO dispatch_pricing (base_fare_kobo, per_km_kobo, min_fare_kobo, commission_bps, cash_debt_limit_kobo, search_radius_m, is_placeholder, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [p.baseFareKobo.toString(), p.perKmKobo.toString(), p.minFareKobo.toString(), p.commissionBps, p.cashDebtLimitKobo.toString(), p.searchRadiusM, isPlaceholder, actorId, this.clock()],
    );
    await recordAudit(this.pool, { actorId, actorKind: actorId ? 'person' : 'system', action: 'dispatch.pricing_set', subjectType: 'dispatch_pricing', subjectId: rows[0]!.id, details: { ...p, baseFareKobo: String(p.baseFareKobo), perKmKobo: String(p.perKmKobo), minFareKobo: String(p.minFareKobo), cashDebtLimitKobo: String(p.cashDebtLimitKobo) } });
    return rows[0]!.id;
  }

  // ---------------- riders ----------------

  /** A customer applies to ride. A financed rider names the ride-to-own account the bike is on. */
  async applyAsRider(personId: string, input: { kind: 'own_bike' } | { kind: 'financed'; financeReference: string }) {
    let financeAccountId: string | null = null;
    if (input.kind === 'financed') {
      const fa = (
        await this.pool.query<{ id: string; status: string }>(
          `SELECT id, status FROM finance_account WHERE reference = $1 AND person_id = $2 AND product_code IN ('motorcycle_ride_to_own', 'purchase_and_deliver')`,
          [input.financeReference, personId],
        )
      ).rows[0];
      if (!fa || !['active', 'in_arrears'].includes(fa.status)) {
        throw new DispatchError('finance_account_not_eligible', 'The bike must be handed over and the account active');
      }
      financeAccountId = fa.id;
    }
    try {
      await this.pool.query(`INSERT INTO rider (person_id, kind, finance_account_id, applied_at) VALUES ($1, $2, $3, $4)`, [personId, input.kind, financeAccountId, this.clock()]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new DispatchError('already_rider');
      throw e;
    }
    return this.rider(personId);
  }

  async rider(personId: string) {
    const { rows } = await this.pool.query<{
      person_id: string;
      reference: string;
      kind: string;
      status: string;
      online: boolean;
      finance_reference: string | null;
      status_note: string | null;
      full_name: string | null;
      phone: string | null;
    }>(
      `SELECT r.person_id, r.reference, r.kind, r.status, r.online, f.reference AS finance_reference, r.status_note, p.full_name, p.phone
         FROM rider r JOIN person p ON p.id = r.person_id LEFT JOIN finance_account f ON f.id = r.finance_account_id
        WHERE r.person_id = $1`,
      [personId],
    );
    const r = rows[0];
    if (!r) throw new DispatchError('not_a_rider');
    const balance = await accountBalance(this.pool, dsp.rider(r.reference));
    return {
      personId: r.person_id,
      reference: r.reference,
      kind: r.kind,
      status: r.status,
      online: r.online,
      financeReference: r.finance_reference,
      statusNote: r.status_note,
      fullName: r.full_name,
      // Positive: earned and not yet paid out. Negative: commission owed from cash jobs.
      earningsBalanceKobo: (-balance).toString(),
    };
  }

  async riders(status?: string) {
    const { rows } = await this.pool.query(
      `SELECT r.person_id AS "personId", r.reference, r.kind, r.status, r.online, r.applied_at AS "appliedAt", r.last_seen_at AS "lastSeenAt",
              p.full_name AS "fullName", p.phone, f.reference AS "financeReference",
              EXISTS (SELECT 1 FROM customer_document d WHERE d.person_id = r.person_id AND d.kind = 'drivers_licence' AND d.status = 'accepted') AS "licenceAccepted"
         FROM rider r JOIN person p ON p.id = r.person_id LEFT JOIN finance_account f ON f.id = r.finance_account_id
        ${status ? 'WHERE r.status = $1' : ''} ORDER BY r.applied_at DESC LIMIT 500`,
      status ? [status] : [],
    );
    return rows;
  }

  /** Staff activate or suspend a rider. Activation needs an accepted driver's licence. */
  async decideRider(personId: string, staffId: string, decision: 'active' | 'suspended', note: string) {
    if (personId === staffId) throw new DispatchError('same_person');
    await inTx(this.pool, async (tx) => {
      const r = (await tx.query<{ status: string }>('SELECT status FROM rider WHERE person_id = $1 FOR UPDATE', [personId])).rows[0];
      if (!r) throw new DispatchError('not_a_rider');
      if (decision === 'active') {
        const ok = await tx.query(`SELECT 1 FROM customer_document WHERE person_id = $1 AND kind = 'drivers_licence' AND status = 'accepted'`, [personId]);
        if (!ok.rows[0]) throw new DispatchError('licence_not_accepted', "Accept the rider's driver's licence first");
      }
      await tx.query(
        `UPDATE rider SET status = $2, online = CASE WHEN $2 = 'active' THEN online ELSE false END, decided_by = $3, decided_at = $4, status_note = $5 WHERE person_id = $1`,
        [personId, decision, staffId, this.clock(), note],
      );
      await recordAudit(tx, { actorId: staffId, actorKind: 'person', action: `dispatch.rider_${decision}`, subjectType: 'person', subjectId: personId, details: { note } });
    });
  }

  /** Going online needs an active rider; a financed rider's bike must still be with them. */
  async setOnline(personId: string, online: boolean, at?: Point) {
    await inTx(this.pool, async (tx) => {
      const r = (
        await tx.query<{ status: string; fa_status: string | null }>(
          `SELECT r.status, f.status AS fa_status FROM rider r LEFT JOIN finance_account f ON f.id = r.finance_account_id WHERE r.person_id = $1 FOR UPDATE OF r`,
          [personId],
        )
      ).rows[0];
      if (!r) throw new DispatchError('not_a_rider');
      if (online && r.status !== 'active') throw new DispatchError('rider_not_active');
      if (online && r.fa_status && !['active', 'in_arrears'].includes(r.fa_status)) {
        throw new DispatchError('finance_account_not_eligible', 'Your financed bike is not available for jobs right now. Check your account.');
      }
      await tx.query(
        `UPDATE rider SET online = $2, last_lat = coalesce($3, last_lat), last_lng = coalesce($4, last_lng), last_seen_at = $5 WHERE person_id = $1`,
        [personId, online, at?.lat ?? null, at?.lng ?? null, this.clock()],
      );
    });
  }

  async updateLocation(personId: string, at: Point) {
    const r = await this.pool.query(`UPDATE rider SET last_lat = $2, last_lng = $3, last_seen_at = $4 WHERE person_id = $1`, [personId, at.lat, at.lng, this.clock()]);
    if (r.rowCount === 0) throw new DispatchError('not_a_rider');
  }

  // ---------------- customers ----------------

  async quote(customerId: string, pickup: Point & { address: string }, dropoff: Point & { address: string }) {
    const live = await this.pool.query<{ live: boolean }>(`SELECT live FROM product_setting WHERE product_code = 'dispatch'`);
    if (!live.rows[0]?.live) throw new DispatchError('not_live', 'Deliveries are not open yet');
    const pricing = await this.currentPricing();
    if (!pricing) throw new DispatchError('no_pricing');
    const route = await this.routes.estimate(pickup, dropoff);
    const { fare, commission } = fareFor(route.distanceMeters, pricing);
    const expiresAt = new Date(this.clock().getTime() + QUOTE_TTL_MS);
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO dispatch_quote (customer_id, pricing_id, pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
                                   distance_m, distance_source, fare_kobo, commission_kobo, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
      [customerId, pricing.id, pickup.lat, pickup.lng, pickup.address.trim(), dropoff.lat, dropoff.lng, dropoff.address.trim(), route.distanceMeters, route.source, fare.toString(), commission.toString(), this.clock(), expiresAt],
    );
    return { quoteId: rows[0]!.id, fareKobo: fare.toString(), distanceMeters: route.distanceMeters, expiresAt, isPlaceholderPricing: pricing.isPlaceholder };
  }

  /** Six digits derived from the job id with a secret: never stored, shown to the people who need it. */
  private code(jobId: string, which: 'pickup' | 'delivery'): string {
    const n = createHmac('sha256', this.opts.codePepper).update(`${jobId}:${which}`).digest().readUInt32BE(0) % 1_000_000;
    return n.toString().padStart(6, '0');
  }
  private codeHash(code: string): string {
    return createHmac('sha256', this.opts.codePepper).update(`code:${code}`).digest('hex');
  }

  async book(
    customerId: string,
    input: { quoteId: string; paymentMethod: 'cash' | 'in_app'; recipientName: string; recipientPhone: string; packageNote?: string | null },
  ) {
    const phone = normalizeNigerianMobile(input.recipientPhone);
    if (!phone) throw new DispatchError('invalid_phone', 'Enter the recipient’s Nigerian mobile number');
    const job = await inTx(this.pool, async (tx) => {
      const q = (
        await tx.query<{ id: string; fare_kobo: string; commission_kobo: string; expires_at: Date }>(
          'SELECT id, fare_kobo, commission_kobo, expires_at FROM dispatch_quote WHERE id = $1 AND customer_id = $2 FOR UPDATE',
          [input.quoteId, customerId],
        )
      ).rows[0];
      if (!q) throw new DispatchError('not_found', 'Quote not found');
      if (q.expires_at < this.clock()) throw new DispatchError('quote_expired', 'This price has expired. Get a new quote.');
      const id = randomUUID();
      try {
        const { rows } = await tx.query<{ id: string; reference: string; status: string }>(
          `INSERT INTO dispatch_job (id, customer_id, quote_id, payment_method, status, fare_kobo, commission_kobo, recipient_name, recipient_phone,
                                     package_note, pickup_code_hash, delivery_code_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id, reference, status`,
          [
            id, customerId, q.id, input.paymentMethod, input.paymentMethod === 'in_app' ? 'awaiting_payment' : 'searching',
            q.fare_kobo, q.commission_kobo, input.recipientName.trim(), phone, input.packageNote?.trim() || null,
            this.codeHash(this.code(id, 'pickup')), this.codeHash(this.code(id, 'delivery')), this.clock(),
          ],
        );
        await this.event(tx, id, 'booked', customerId, null, { paymentMethod: input.paymentMethod });
        return rows[0]!;
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'dispatch_job_quote_id_key') throw new DispatchError('quote_used', 'This quote has already been booked');
        throw e;
      }
    });
    let payUrl: string | null = null;
    if (input.paymentMethod === 'in_app') {
      const customerPhone = (await this.pool.query<{ phone: string }>('SELECT phone FROM person WHERE id = $1', [customerId])).rows[0]?.phone ?? '';
      const fare = (await this.pool.query<{ fare_kobo: string }>('SELECT fare_kobo FROM dispatch_job WHERE id = $1', [job.id])).rows[0]!.fare_kobo;
      const charge = await this.checkout.createCharge({ reference: job.reference, amount: kobo(BigInt(fare)), customerPhone, description: `Delivery ${job.reference}` });
      await this.pool.query('UPDATE dispatch_job SET payment_reference = $2 WHERE id = $1', [job.id, charge.reference]);
      payUrl = charge.payUrl;
    }
    return { ...(await this.customerView(customerId, job.reference)), payUrl };
  }

  /**
   * A verified payment for an in-app job. Exactly once: the ledger entry's idempotency key is the
   * provider's event id, and the job only moves from awaiting_payment. A wrong amount is held, not
   * accepted, for finance to resolve.
   */
  async paymentReceived(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const paid = this.checkout.parseWebhook(rawBody, headers);
    if (!paid) return { outcome: 'ignored' as const };
    const provider = this.checkout.info.provider;
    return inTx(this.pool, async (tx) => {
      const job = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE payment_reference = $1 FOR UPDATE', [paid.reference])).rows[0];
      const unmatched = async (why: string) => {
        await postEntryInTx(tx, {
          idempotencyKey: `dsp-charge:${provider}:${paid.providerEventId}`,
          source: 'webhook',
          actorId: `checkout:${provider}`,
          occurredAt: paid.paidAt,
          description: `Delivery payment ${paid.reference} not matched: ${why}`,
          lines: [
            { account: dsp.clearing(provider), side: 'debit', amount: paid.amount },
            { account: 'dsp:suspense:unmatched', side: 'credit', amount: paid.amount },
          ],
        });
        return { outcome: 'unmatched' as const, reason: why };
      };
      // The same event delivered again: already posted, nothing to do.
      const key = `dsp-charge:${provider}:${paid.providerEventId}`;
      if ((await tx.query('SELECT 1 FROM ledger_entry WHERE idempotency_key = $1', [key])).rows[0]) return { outcome: 'duplicate' as const };
      if (!job) return unmatched('no such job');
      // A different payment for a job that is already paid (or cancelled) is held for finance.
      if (job.status !== 'awaiting_payment') return unmatched(`job is ${job.status}`);
      if (BigInt(job.fare_kobo) !== paid.amount) return unmatched(`amount ${paid.amount} does not match fare ${job.fare_kobo}`);
      const { entryId, duplicate } = await postEntryInTx(tx, {
        idempotencyKey: `dsp-charge:${provider}:${paid.providerEventId}`,
        source: 'webhook',
        actorId: `checkout:${provider}`,
        occurredAt: paid.paidAt,
        description: `Delivery ${job.reference} paid`,
        lines: [
          { account: dsp.clearing(provider), side: 'debit', amount: paid.amount },
          { account: dsp.prepaid(job.reference), side: 'credit', amount: paid.amount },
        ],
      });
      if (duplicate) return { outcome: 'duplicate' as const };
      await tx.query(`UPDATE dispatch_job SET status = 'searching', paid_entry_id = $2 WHERE id = $1`, [job.id, entryId]);
      await this.event(tx, job.id, 'paid', null, null, { amountKobo: paid.amount.toString() });
      return { outcome: 'paid' as const, reference: job.reference };
    });
  }

  /** What the customer sees: status, rider, both codes (they pass them on), never the hashes. */
  async customerView(customerId: string, reference: string) {
    const { rows } = await this.pool.query<{
      id: string; reference: string; status: string; payment_method: string; fare_kobo: string; recipient_name: string; recipient_phone: string;
      pickup_address: string; dropoff_address: string; distance_m: number; created_at: Date; delivered_at: Date | null; cancel_reason: string | null;
      rider_name: string | null; rider_phone: string | null; rider_ref: string | null;
    }>(
      `SELECT j.id, j.reference, j.status, j.payment_method, j.fare_kobo, j.recipient_name, j.recipient_phone,
              q.pickup_address, q.dropoff_address, q.distance_m, j.created_at, j.delivered_at, j.cancel_reason,
              p.full_name AS rider_name, p.phone AS rider_phone, r.reference AS rider_ref
         FROM dispatch_job j JOIN dispatch_quote q ON q.id = j.quote_id
         LEFT JOIN rider r ON r.person_id = j.rider_id LEFT JOIN person p ON p.id = j.rider_id
        WHERE j.reference = $1 AND j.customer_id = $2`,
      [reference, customerId],
    );
    const j = rows[0];
    if (!j) throw new DispatchError('not_found');
    const live = !['delivered', 'cancelled'].includes(j.status);
    return {
      reference: j.reference,
      status: j.status,
      paymentMethod: j.payment_method,
      fareKobo: j.fare_kobo,
      pickupAddress: j.pickup_address,
      dropoffAddress: j.dropoff_address,
      distanceMeters: j.distance_m,
      recipient: { name: j.recipient_name, phone: maskPhone(j.recipient_phone) },
      rider: j.rider_ref ? { reference: j.rider_ref, name: j.rider_name, phone: ['accepted', 'picked_up'].includes(j.status) ? j.rider_phone : null } : null,
      // The sender gives the pickup code to the rider; the delivery code goes to the recipient.
      pickupCode: live && j.status !== 'picked_up' ? this.code(j.id, 'pickup') : null,
      deliveryCode: live ? this.code(j.id, 'delivery') : null,
      createdAt: j.created_at,
      deliveredAt: j.delivered_at,
      cancelReason: j.cancel_reason,
    };
  }

  async customerJobs(customerId: string) {
    const { rows } = await this.pool.query<{ reference: string }>('SELECT reference FROM dispatch_job WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [customerId]);
    return Promise.all(rows.map((r) => this.customerView(customerId, r.reference)));
  }

  /** The customer cancels before pickup. A paid job's fare becomes a refund owed to them. */
  async cancelByCustomer(customerId: string, reference: string, reason: string) {
    return inTx(this.pool, async (tx) => {
      const job = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE reference = $1 AND customer_id = $2 FOR UPDATE', [reference, customerId])).rows[0];
      if (!job) throw new DispatchError('not_found');
      return this.cancelTx(tx, job, customerId, reason);
    });
  }

  async cancelByStaff(reference: string, staffId: string, reason: string) {
    return inTx(this.pool, async (tx) => {
      const job = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
      if (!job) throw new DispatchError('not_found');
      return this.cancelTx(tx, job, staffId, reason);
    });
  }

  private async cancelTx(tx: Queryable, job: JobRow, actorId: string, reason: string) {
    if (!['awaiting_payment', 'searching', 'accepted'].includes(job.status)) {
      throw new DispatchError('invalid_status', job.status === 'picked_up' ? 'The parcel has been picked up and cannot be cancelled' : `Job is ${job.status}`);
    }
    let refundKobo = '0';
    const paid = (await tx.query<{ paid_entry_id: string | null }>('SELECT paid_entry_id FROM dispatch_job WHERE id = $1', [job.id])).rows[0]!.paid_entry_id;
    if (paid) {
      await postEntryInTx(tx, {
        idempotencyKey: `dsp-cancel:${job.reference}`,
        source: 'system',
        actorId,
        occurredAt: this.clock(),
        description: `Delivery ${job.reference} cancelled before pickup: fare to be refunded`,
        lines: [
          { account: dsp.prepaid(job.reference), side: 'debit', amount: kobo(BigInt(job.fare_kobo)) },
          { account: dsp.refund(job.reference), side: 'credit', amount: kobo(BigInt(job.fare_kobo)) },
        ],
      });
      refundKobo = job.fare_kobo;
    }
    await tx.query(`UPDATE dispatch_job SET status = 'cancelled', cancelled_at = $2, cancel_reason = $3 WHERE id = $1`, [job.id, this.clock(), reason]);
    await this.event(tx, job.id, 'cancelled', actorId, null, { reason, refundKobo });
    return { reference: job.reference, status: 'cancelled', refundKobo };
  }

  // ---------------- rider jobs ----------------

  private async activeRider(tx: Queryable, personId: string) {
    const r = (await tx.query<{ reference: string; status: string; online: boolean; last_lat: number | null; last_lng: number | null }>(
      'SELECT reference, status, online, last_lat, last_lng FROM rider WHERE person_id = $1',
      [personId],
    )).rows[0];
    if (!r) throw new DispatchError('not_a_rider');
    if (r.status !== 'active') throw new DispatchError('rider_not_active');
    return r;
  }

  /** What the rider owes from cash jobs, in kobo (0 when they are owed money). */
  private async cashDebt(db: Queryable, riderRef: string): Promise<bigint> {
    const b = await accountBalance(db, dsp.rider(riderRef));
    return b > 0n ? b : 0n;
  }

  /** Open jobs near the rider, nearest pickup first. Cash jobs are hidden once their debt is over the limit. */
  async availableJobs(riderId: string) {
    const r = await this.activeRider(this.pool, riderId);
    if (!r.online) return { jobs: [], cashBlocked: false };
    if (r.last_lat === null || r.last_lng === null) return { jobs: [], cashBlocked: false };
    const pricing = (await this.currentPricing())!;
    const cashBlocked = (await this.cashDebt(this.pool, r.reference)) > pricing.cashDebtLimitKobo;
    const { rows } = await this.pool.query<{ reference: string; payment_method: string; fare_kobo: string; commission_kobo: string; pickup_lat: number; pickup_lng: number; pickup_address: string; dropoff_address: string; distance_m: number; customer_id: string }>(
      `SELECT j.reference, j.payment_method, j.fare_kobo, j.commission_kobo, q.pickup_lat, q.pickup_lng, q.pickup_address, q.dropoff_address, q.distance_m, j.customer_id
         FROM dispatch_job j JOIN dispatch_quote q ON q.id = j.quote_id
        WHERE j.status = 'searching' AND j.customer_id <> $1 ORDER BY j.created_at LIMIT 200`,
      [riderId],
    );
    const here = { lat: r.last_lat, lng: r.last_lng };
    const jobs = rows
      .map((j) => ({ ...j, toPickupM: Math.round(haversineMeters(here, { lat: j.pickup_lat, lng: j.pickup_lng })) }))
      .filter((j) => j.toPickupM <= pricing.searchRadiusM && !(cashBlocked && j.payment_method === 'cash'))
      .sort((a, b) => a.toPickupM - b.toPickupM)
      .slice(0, 20)
      .map((j) => ({
        reference: j.reference,
        paymentMethod: j.payment_method,
        fareKobo: j.fare_kobo,
        earningKobo: (BigInt(j.fare_kobo) - BigInt(j.commission_kobo)).toString(),
        pickupAddress: j.pickup_address,
        dropoffAddress: j.dropoff_address,
        tripMeters: j.distance_m,
        toPickupMeters: j.toPickupM,
      }));
    return { jobs, cashBlocked };
  }

  /** First rider to accept wins. One live job per rider. */
  async accept(riderId: string, reference: string) {
    return inTx(this.pool, async (tx) => {
      const r = await this.activeRider(tx, riderId);
      if (!r.online) throw new DispatchError('rider_not_active', 'Go online to take jobs');
      const job = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE reference = $1 FOR UPDATE', [reference])).rows[0];
      if (!job) throw new DispatchError('not_found');
      if (job.customer_id === riderId) throw new DispatchError('own_job');
      if (job.status !== 'searching') throw new DispatchError('job_taken', 'Another rider took this job');
      if (job.payment_method === 'cash') {
        const pricing = (await this.currentPricing(tx))!;
        if ((await this.cashDebt(tx, r.reference)) > pricing.cashDebtLimitKobo) throw new DispatchError('cash_debt_limit', 'Settle the commission you owe before taking cash jobs');
      }
      try {
        await tx.query(`UPDATE dispatch_job SET status = 'accepted', rider_id = $2, accepted_at = $3 WHERE id = $1`, [job.id, riderId, this.clock()]);
      } catch (e) {
        if ((e as { constraint?: string }).constraint === 'dispatch_job_one_live_per_rider') throw new DispatchError('rider_busy', 'Finish your current job first');
        throw e;
      }
      await this.event(tx, job.id, 'accepted', riderId, r.last_lat !== null ? { lat: r.last_lat, lng: r.last_lng! } : null, {});
      return { reference, status: 'accepted' };
    });
  }

  /**
   * Checked before the job row is locked: a wrong guess is counted in its own statement (so it
   * sticks even though the step fails), and it never waits on a lock the caller holds.
   */
  private async checkCode(job: JobRow, which: 'pickup' | 'delivery', given: string) {
    const attempts = which === 'pickup' ? job.pickup_attempts : job.delivery_attempts;
    if (attempts >= CODE_ATTEMPTS) throw new DispatchError('code_locked', 'Too many wrong codes. Call support.');
    const ok = /^\d{6}$/.test(given) && timingSafeEqual(Buffer.from(this.codeHash(given), 'hex'), Buffer.from(this.codeHash(this.code(job.id, which)), 'hex'));
    if (!ok) {
      const col = which === 'pickup' ? 'pickup_attempts' : 'delivery_attempts';
      const r = await this.pool.query<{ n: number }>(`UPDATE dispatch_job SET ${col} = ${col} + 1 WHERE id = $1 RETURNING ${col} AS n`, [job.id]);
      throw new DispatchError(r.rows[0]!.n >= CODE_ATTEMPTS ? 'code_locked' : 'code_invalid');
    }
  }

  /** At pickup the rider enters the sender's code; the recipient is then texted the delivery code. */
  async pickup(riderId: string, reference: string, code: string, at: Point) {
    const job = await this.riderJob(riderId, reference, 'accepted');
    await this.checkCode(job, 'pickup', code);
    await inTx(this.pool, async (tx) => {
      const locked = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE id = $1 FOR UPDATE', [job.id])).rows[0]!;
      if (locked.status !== 'accepted') throw new DispatchError('invalid_status');
      await tx.query(`UPDATE dispatch_job SET status = 'picked_up', picked_up_at = $2 WHERE id = $1`, [job.id, this.clock()]);
      await this.event(tx, job.id, 'picked_up', riderId, at, { fromPickupM: Math.round(haversineMeters(at, { lat: job.pickup_lat, lng: job.pickup_lng })) });
    });
    await this.messaging.send('sms', job.recipient_phone, 'dispatch_delivery_code', { reference, code: this.code(job.id, 'delivery') });
    return { reference, status: 'picked_up' };
  }

  /**
   * At drop-off the rider enters the recipient's code. The fare is settled in the dispatch book:
   * in-app, the prepaid fare is split into the rider's earnings and our commission; cash, the
   * rider already holds the fare and now owes the commission.
   */
  async deliver(riderId: string, reference: string, code: string, at: Point) {
    const job = await this.riderJob(riderId, reference, 'picked_up');
    await this.checkCode(job, 'delivery', code);
    return inTx(this.pool, async (tx) => {
      const locked = (await tx.query<JobRow>('SELECT * FROM dispatch_job WHERE id = $1 FOR UPDATE', [job.id])).rows[0]!;
      if (locked.status !== 'picked_up') throw new DispatchError('invalid_status');
      const riderRef = (await tx.query<{ reference: string }>('SELECT reference FROM rider WHERE person_id = $1', [riderId])).rows[0]!.reference;
      const fare = BigInt(locked.fare_kobo);
      const commission = BigInt(locked.commission_kobo);
      const lines: LedgerLine[] =
        locked.payment_method === 'in_app'
          ? [
              { account: dsp.prepaid(reference), side: 'debit', amount: kobo(fare) },
              { account: dsp.rider(riderRef), side: 'credit', amount: kobo(fare - commission) },
              ...(commission > 0n ? [{ account: dsp.commission, side: 'credit' as const, amount: kobo(commission) }] : []),
            ]
          : commission > 0n
            ? [
                { account: dsp.rider(riderRef), side: 'debit', amount: kobo(commission) },
                { account: dsp.commission, side: 'credit', amount: kobo(commission) },
              ]
            : [];
      let entryId: string | null = null;
      if (lines.length) {
        entryId = (
          await postEntryInTx(tx, {
            idempotencyKey: `dsp-deliver:${reference}`,
            source: 'system',
            actorId: riderId,
            occurredAt: this.clock(),
            description: `Delivery ${reference} completed (${locked.payment_method}): fare ${fare}, commission ${commission}`,
            lines,
          })
        ).entryId;
      }
      const offBy = Math.round(haversineMeters(at, { lat: job.dropoff_lat, lng: job.dropoff_lng }));
      // A cash job with no commission has nothing to post.
      await tx.query(`UPDATE dispatch_job SET status = 'delivered', delivered_at = $2, settled_entry_id = $3 WHERE id = $1`, [job.id, this.clock(), entryId]);
      await this.event(tx, job.id, 'delivered', riderId, at, { fromDropoffM: offBy, flagged: offBy > DROPOFF_FLAG_METERS });
      return {
        reference,
        status: 'delivered',
        earningKobo: (fare - commission).toString(),
        collectCashKobo: locked.payment_method === 'cash' ? fare.toString() : '0',
        flaggedFarFromDropoff: offBy > DROPOFF_FLAG_METERS,
      };
    });
  }

  private async riderJob(riderId: string, reference: string, expected: string) {
    const j = (
      await this.pool.query<JobRow>(
        `SELECT j.*, q.dropoff_lat, q.dropoff_lng, q.pickup_lat, q.pickup_lng FROM dispatch_job j JOIN dispatch_quote q ON q.id = j.quote_id WHERE j.reference = $1`,
        [reference],
      )
    ).rows[0];
    if (!j || j.rider_id !== riderId) throw new DispatchError('not_found');
    if (j.status !== expected) throw new DispatchError('invalid_status', `Job is ${j.status}`);
    return j;
  }

  /** The rider's current job, with what they need on the road (addresses, recipient, payment). */
  async currentJob(riderId: string) {
    const { rows } = await this.pool.query(
      `SELECT j.reference, j.status, j.payment_method AS "paymentMethod", j.fare_kobo AS "fareKobo",
              (j.fare_kobo - j.commission_kobo)::text AS "earningKobo", q.pickup_address AS "pickupAddress", q.pickup_lat AS "pickupLat",
              q.pickup_lng AS "pickupLng", q.dropoff_address AS "dropoffAddress", q.dropoff_lat AS "dropoffLat", q.dropoff_lng AS "dropoffLng",
              j.recipient_name AS "recipientName", j.package_note AS "packageNote",
              CASE WHEN j.status = 'picked_up' THEN j.recipient_phone END AS "recipientPhone",
              c.full_name AS "senderName", c.phone AS "senderPhone"
         FROM dispatch_job j JOIN dispatch_quote q ON q.id = j.quote_id JOIN person c ON c.id = j.customer_id
        WHERE j.rider_id = $1 AND j.status IN ('accepted', 'picked_up')`,
      [riderId],
    );
    return rows[0] ?? null;
  }

  /** Earnings: balance and the latest postings to the rider's account. */
  async earnings(riderId: string) {
    const r = await this.rider(riderId);
    const { rows } = await this.pool.query(
      `SELECT e.occurred_at AS "occurredAt", e.description, l.side, l.amount::text AS "amountKobo"
         FROM ledger_line l JOIN ledger_entry e ON e.id = l.entry_id
        WHERE l.account_code = $1 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 50`,
      [dsp.rider(r.reference)],
    );
    const pricing = await this.currentPricing();
    const debt = BigInt(r.earningsBalanceKobo) < 0n ? -BigInt(r.earningsBalanceKobo) : 0n;
    return {
      balanceKobo: r.earningsBalanceKobo,
      cashBlocked: pricing ? debt > pricing.cashDebtLimitKobo : false,
      cashDebtLimitKobo: pricing?.cashDebtLimitKobo.toString() ?? null,
      entries: rows,
    };
  }

  // ---------------- staff ----------------

  async jobs(status?: string) {
    const { rows } = await this.pool.query(
      `SELECT j.reference, j.status, j.payment_method AS "paymentMethod", j.fare_kobo AS "fareKobo", j.commission_kobo AS "commissionKobo",
              q.pickup_address AS "pickupAddress", q.dropoff_address AS "dropoffAddress", j.created_at AS "createdAt",
              c.full_name AS "customerName", r.reference AS "riderReference", rp.full_name AS "riderName",
              EXISTS (SELECT 1 FROM dispatch_job_event e WHERE e.job_id = j.id AND (e.details->>'flagged')::boolean) AS flagged,
              (j.pickup_attempts >= ${CODE_ATTEMPTS} OR j.delivery_attempts >= ${CODE_ATTEMPTS}) AS "codeLocked"
         FROM dispatch_job j JOIN dispatch_quote q ON q.id = j.quote_id JOIN person c ON c.id = j.customer_id
         LEFT JOIN rider r ON r.person_id = j.rider_id LEFT JOIN person rp ON rp.id = j.rider_id
        ${status ? 'WHERE j.status = $1' : ''} ORDER BY j.created_at DESC LIMIT 200`,
      status ? [status] : [],
    );
    return rows;
  }

  async jobEvents(reference: string) {
    const { rows } = await this.pool.query(
      `SELECT e.occurred_at AS "occurredAt", e.kind, e.lat, e.lng, e.details, p.full_name AS "actorName"
         FROM dispatch_job_event e JOIN dispatch_job j ON j.id = e.job_id LEFT JOIN person p ON p.id = e.actor_id
        WHERE j.reference = $1 ORDER BY e.id`,
      [reference],
    );
    return rows;
  }

  private async event(tx: Queryable, jobId: string, kind: string, actorId: string | null, at: Point | null, details: Record<string, unknown>) {
    await tx.query(
      `INSERT INTO dispatch_job_event (job_id, occurred_at, kind, actor_id, lat, lng, details) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [jobId, this.clock(), kind, actorId, at?.lat ?? null, at?.lng ?? null, JSON.stringify(details)],
    );
  }
}

export const naira = (k: string | bigint) => formatNaira(kobo(BigInt(k)));
