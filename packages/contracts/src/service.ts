import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { DocumentStore, Messaging } from '@project/adapters';
import { brand, formatNaira, kobo } from '@project/domain';
import { depositOf, financedPrincipalOf, generateSchedule, lagosDate, type TermSet } from '@project/finance';
import { maskPhone, normalizeNigerianMobile, recordAudit, type PoolLike, type Queryable } from '@project/identity';
import { keyTerms, PLACEHOLDER_MOTORCYCLE_TEMPLATE, render, unknownPlaceholders, type Placeholder } from './template.js';

export class ContractError extends Error {
  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_status'
      | 'invalid_template'
      | 'same_person'
      | 'no_template'
      | 'guarantors_missing'
      | 'invalid_phone'
      | 'guarantor_is_borrower'
      | 'link_invalid'
      | 'otp_required'
      | 'otp_invalid'
      | 'otp_locked'
      | 'otp_rate_limited'
      | 'document_changed'
      | 'terms_not_acknowledged'
      | 'signature_missing'
      | 'not_your_turn'
      | 'same_device_as_borrower'
      | 'not_configured'
      | 'device_required',
    message: string = code,
  ) {
    super(message);
    this.name = 'ContractError';
  }
}

export interface ContractsConfig {
  /** ≥ 32 bytes; hashes signer OTP codes. */
  readonly otpPepper: Buffer;
  /** Absolute URL of the signing page, e.g. https://api.example.com/sign/ (token goes in the fragment). */
  readonly signingBaseUrl: string | null;
  readonly linkTtlHours?: number;
}

export interface SignerContext {
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  /** Random id the signing page keeps on the device; only its hash is stored. */
  readonly deviceId?: string | null;
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_SENDS_PER_15_MIN = 3;
const OTP_VALID_FOR_SIGNING_MS = 30 * 60_000;

interface SessionRow {
  id: string;
  contract_id: string;
  signer_order: number;
  signer_role: 'borrower' | 'guarantor' | 'company';
  guarantor_id: string | null;
  signer_name: string;
  phone: string | null;
  status: string;
  expires_at: Date | null;
  otp_hash: string | null;
  otp_expires_at: Date | null;
  otp_attempts: number;
  otp_verified_at: Date | null;
  contract_status: string;
  document_sha256: string;
  rendered_text: string;
  field_values: Record<Placeholder, string>;
  is_placeholder: boolean;
  reference: string;
}

export class ContractsService {
  private readonly linkTtlMs: number;

  constructor(
    private readonly pool: PoolLike,
    private readonly messaging: Messaging,
    private readonly documents: DocumentStore,
    private readonly config: ContractsConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (config.otpPepper.length < 32) throw new Error('otpPepper must be at least 32 bytes');
    this.linkTtlMs = (config.linkTtlHours ?? 72) * 3_600_000;
  }

  // ===================== Templates =====================

  async createTemplate(productCode: string, title: string, body: string, by: string) {
    const unknown = unknownPlaceholders(body);
    if (unknown.length) throw new ContractError('invalid_template', `Unknown placeholders: ${unknown.join(', ')}`);
    return inTx(this.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`template:${productCode}`]);
      const { rows } = await tx.query<{ id: string; version: number }>(
        `INSERT INTO contract_template (product_code, version, title, body, created_by)
         SELECT $1, coalesce(max(version), 0) + 1, $2, $3, $4 FROM contract_template WHERE product_code = $1
         RETURNING id, version`,
        [productCode, title, body, by],
      );
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'contract.template_created', subjectType: 'contract_template', subjectId: rows[0]!.id });
      return rows[0]!;
    });
  }

  /** A different person approves, recording the legal review. Approved wording is frozen. */
  async approveTemplate(templateId: string, by: string, legalReviewNote: string) {
    await inTx(this.pool, async (tx) => {
      const { rows } = await tx.query<{ created_by: string | null; status: string; product_code: string }>(
        'SELECT created_by, status, product_code FROM contract_template WHERE id = $1 FOR UPDATE',
        [templateId],
      );
      const t = rows[0];
      if (!t) throw new ContractError('not_found');
      if (t.status !== 'draft') throw new ContractError('invalid_status', `Template is ${t.status}`);
      if (t.created_by === by) throw new ContractError('same_person');
      await tx.query(`UPDATE contract_template SET status = 'retired' WHERE product_code = $1 AND status = 'approved'`, [t.product_code]);
      await tx.query(
        `UPDATE contract_template SET status = 'approved', approved_by = $2, approved_at = $3, legal_review_note = $4 WHERE id = $1`,
        [templateId, by, this.clock(), legalReviewNote],
      );
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'contract.template_approved', subjectType: 'contract_template', subjectId: templateId, details: { legalReviewNote } });
    });
  }

  /** Loads the clearly-marked placeholder motorcycle template if the product has none. */
  async seedPlaceholderTemplate(by: string): Promise<string | null> {
    const exists = await this.pool.query(`SELECT 1 FROM contract_template WHERE product_code = 'motorcycle_ride_to_own'`);
    if (exists.rows.length) return null;
    const { rows } = await this.pool.query<{ id: string }>(
      `INSERT INTO contract_template (product_code, version, title, body, is_placeholder, status, approved_by, approved_at, legal_review_note)
       VALUES ('motorcycle_ride_to_own', 1, $1, $2, true, 'approved', $3, $4, 'PLACEHOLDER: not reviewed by counsel')
       RETURNING id`,
      [PLACEHOLDER_MOTORCYCLE_TEMPLATE.title, PLACEHOLDER_MOTORCYCLE_TEMPLATE.body, by, this.clock()],
    );
    return rows[0]!.id;
  }

  async templates(productCode: string) {
    const { rows } = await this.pool.query(
      `SELECT id, version, title, body, is_placeholder AS "isPlaceholder", status, created_by AS "createdBy", created_at AS "createdAt",
              approved_by AS "approvedBy", approved_at AS "approvedAt", legal_review_note AS "legalReviewNote"
         FROM contract_template WHERE product_code = $1 ORDER BY version DESC`,
      [productCode],
    );
    return rows;
  }

  // ===================== Guarantors =====================

  async addGuarantor(financeAccountId: string, g: { fullName: string; phone: string; relationship: string }, by: string) {
    const phone = normalizeNigerianMobile(g.phone);
    if (!phone) throw new ContractError('invalid_phone');
    return inTx(this.pool, async (tx) => {
      const fa = await lockAccount(tx, financeAccountId);
      if (!['applied', 'approved'].includes(fa.status)) throw new ContractError('invalid_status', `Account is ${fa.status}`);
      if (fa.phone === phone) throw new ContractError('guarantor_is_borrower', 'A borrower cannot be their own guarantor');
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO guarantor (finance_account_id, full_name, phone, relationship, added_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [financeAccountId, g.fullName.trim(), phone, g.relationship.trim(), by],
      );
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'guarantor.added', subjectType: 'finance_account', subjectId: fa.reference, details: { phone: maskPhone(phone) } });
      return rows[0]!.id;
    });
  }

  async removeGuarantor(guarantorId: string, by: string) {
    await inTx(this.pool, async (tx) => {
      const g = (await tx.query<{ finance_account_id: string }>('SELECT finance_account_id FROM guarantor WHERE id = $1 AND removed_at IS NULL', [guarantorId])).rows[0];
      if (!g) throw new ContractError('not_found');
      const fa = await lockAccount(tx, g.finance_account_id);
      if (!['applied', 'approved'].includes(fa.status)) throw new ContractError('invalid_status');
      const live = await tx.query(`SELECT 1 FROM contract WHERE finance_account_id = $1 AND status IN ('issued', 'partially_signed')`, [fa.id]);
      if (live.rows.length) throw new ContractError('invalid_status', 'Revoke the contract in progress first');
      await tx.query('UPDATE guarantor SET removed_at = $2 WHERE id = $1', [guarantorId, this.clock()]);
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'guarantor.removed', subjectType: 'finance_account', subjectId: fa.reference });
    });
  }

  async guarantors(financeAccountId: string) {
    const { rows } = await this.pool.query(
      `SELECT id, full_name AS "fullName", phone, relationship, added_at AS "addedAt"
         FROM guarantor WHERE finance_account_id = $1 AND removed_at IS NULL ORDER BY added_at`,
      [financeAccountId],
    );
    return rows;
  }

  // ===================== Issue =====================

  /**
   * Renders the latest approved template with the account's frozen terms, fixes its SHA-256,
   * creates one signing slot per signer (borrower, each guarantor, company) and sends the
   * borrower their link. Guarantors get theirs only after the borrower has signed.
   */
  async issue(financeAccountId: string, by: string): Promise<{ contractId: string; documentSha256: string }> {
    if (!this.config.signingBaseUrl) throw new ContractError('not_configured', 'SIGNING_BASE_URL is not set');
    let notice: { phone: string; name: string; token: string; reference: string } | null = null;
    const result = await inTx(this.pool, async (tx) => {
      const fa = await lockAccount(tx, financeAccountId);
      if (fa.status !== 'approved' || !fa.current_snapshot_id) throw new ContractError('invalid_status', `Account is ${fa.status}`);
      const terms = (await tx.query<{ terms: TermSet }>('SELECT terms FROM term_snapshot WHERE id = $1', [fa.current_snapshot_id])).rows[0]!.terms;
      const guarantors = (
        await tx.query<{ id: string; full_name: string; phone: string }>(
          'SELECT id, full_name, phone FROM guarantor WHERE finance_account_id = $1 AND removed_at IS NULL ORDER BY added_at',
          [fa.id],
        )
      ).rows;
      if (guarantors.length < terms.guarantorsRequired) {
        throw new ContractError('guarantors_missing', `${terms.guarantorsRequired} guarantor(s) required, ${guarantors.length} added`);
      }
      const template = (
        await tx.query<{ id: string; body: string; is_placeholder: boolean }>(
          `SELECT id, body, is_placeholder FROM contract_template WHERE product_code = $1 AND status = 'approved' ORDER BY version DESC LIMIT 1`,
          [fa.product_code],
        )
      ).rows[0];
      if (!template) throw new ContractError('no_template', 'No approved contract template for this product');

      const values = fieldValues(fa, terms, guarantors, lagosDate(this.clock()));
      let text: string;
      try {
        text = render(template.body, values);
      } catch (err) {
        throw new ContractError('invalid_template', (err as Error).message);
      }
      const documentSha256 = sha256(text);
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO contract (finance_account_id, template_id, snapshot_id, rendered_text, field_values, document_sha256, is_placeholder, issued_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [fa.id, template.id, fa.current_snapshot_id, text, JSON.stringify(values), documentSha256, template.is_placeholder, by],
      );
      const contractId = rows[0]!.id;

      let order = 1;
      const token = randomToken();
      await tx.query(
        `INSERT INTO signing_session (contract_id, signer_order, signer_role, signer_person_id, signer_name, phone, token_hash, status, link_sent_at, expires_at)
         VALUES ($1, $2, 'borrower', $3, $4, $5, $6, 'open', $7, $8)`,
        [contractId, order++, fa.person_id, fa.full_name ?? 'Borrower', fa.phone, sha256(token), this.clock(), this.expiry()],
      );
      for (const g of guarantors) {
        await tx.query(
          `INSERT INTO signing_session (contract_id, signer_order, signer_role, guarantor_id, signer_name, phone)
           VALUES ($1, $2, 'guarantor', $3, $4, $5)`,
          [contractId, order++, g.id, g.full_name, g.phone],
        );
      }
      await tx.query(
        `INSERT INTO signing_session (contract_id, signer_order, signer_role, signer_name) VALUES ($1, $2, 'company', $3)`,
        [contractId, order, brand.name],
      );
      await this.ev(tx, contractId, null, 'issued', { by, documentSha256, signers: order });
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'contract.issued', subjectType: 'finance_account', subjectId: fa.reference, details: { contractId, documentSha256, isPlaceholder: template.is_placeholder } });
      if (!fa.phone) throw new ContractError('invalid_phone', 'Borrower has no phone number');
      notice = { phone: fa.phone, name: fa.full_name ?? 'there', token, reference: fa.reference };
      return { contractId, documentSha256 };
    });
    if (notice) await this.sendLink(notice);
    return result;
  }

  // ===================== Signer (public, by token) =====================

  /** What the signing page shows: the full wording, its hash and the terms this signer must acknowledge. */
  async view(token: string, ctx: SignerContext = {}) {
    const s = await this.sessionByToken(this.pool, token);
    if (s.status === 'open') {
      const seen = await this.pool.query(`SELECT 1 FROM contract_event WHERE session_id = $1 AND event = 'opened'`, [s.id]);
      if (!seen.rows.length) await this.ev(this.pool, s.contract_id, s.id, 'opened', { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null });
    }
    return {
      reference: s.reference,
      role: s.signer_role,
      signerName: s.signer_name,
      phone: s.phone ? maskPhone(s.phone) : null,
      status: s.status,
      isPlaceholder: s.is_placeholder,
      documentText: s.rendered_text,
      documentSha256: s.document_sha256,
      keyTerms: keyTerms(s.signer_role, s.field_values),
      otpVerified: this.otpFresh(s),
    };
  }

  async requestOtp(token: string): Promise<{ sentTo: string }> {
    const s = await this.openSession(token);
    const recent = await this.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contract_event WHERE session_id = $1 AND event = 'otp_sent' AND at > $2`,
      [s.id, new Date(this.clock().getTime() - 15 * 60_000)],
    );
    if (recent.rows[0]!.n >= OTP_MAX_SENDS_PER_15_MIN) throw new ContractError('otp_rate_limited');
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    await this.pool.query(
      `UPDATE signing_session SET otp_hash = $2, otp_expires_at = $3, otp_attempts = 0, otp_verified_at = NULL WHERE id = $1`,
      [s.id, this.otpHash(s.id, code), new Date(this.clock().getTime() + OTP_TTL_MS)],
    );
    await this.ev(this.pool, s.contract_id, s.id, 'otp_sent', {});
    await this.messaging.send('sms', s.phone!, 'contract_sign_otp', { code, reference: s.reference });
    return { sentTo: maskPhone(s.phone!) };
  }

  async verifyOtp(token: string, code: string): Promise<void> {
    const outcome = await inTx(this.pool, async (tx) => {
      const s = await this.sessionByToken(tx, token, true);
      if (s.status !== 'open') return 'link_invalid' as const;
      if (!s.otp_hash || !s.otp_expires_at) return 'otp_required' as const;
      if (s.otp_attempts >= OTP_MAX_ATTEMPTS) return 'otp_locked' as const;
      if (s.otp_expires_at <= this.clock()) return 'otp_required' as const;
      const ok = /^\d{6}$/.test(code) && safeEq(this.otpHash(s.id, code), s.otp_hash);
      if (!ok) {
        await tx.query('UPDATE signing_session SET otp_attempts = otp_attempts + 1 WHERE id = $1', [s.id]);
        await this.ev(tx, s.contract_id, s.id, 'otp_failed', { attempt: s.otp_attempts + 1 });
        return s.otp_attempts + 1 >= OTP_MAX_ATTEMPTS ? ('otp_locked' as const) : ('otp_invalid' as const);
      }
      await tx.query('UPDATE signing_session SET otp_verified_at = $2, otp_hash = NULL WHERE id = $1', [s.id, this.clock()]);
      await this.ev(tx, s.contract_id, s.id, 'otp_verified', {});
      return null;
    });
    if (outcome) throw new ContractError(outcome);
  }

  /**
   * Signs. Requires a recent OTP, the exact document hash the page displayed, every key term
   * acknowledged, an explicit intention, a typed name and/or a drawn signature. A guarantor
   * signing from the borrower's device is refused and the contract is flagged.
   */
  async sign(
    token: string,
    input: {
      documentSha256: string;
      acknowledged: string[];
      typedName: string;
      intentToSign: boolean;
      signaturePng?: Buffer | null;
    },
    ctx: SignerContext,
  ): Promise<{ status: 'signed'; next: 'guarantor' | 'company' }> {
    let nextNotice: { phone: string; name: string; token: string; reference: string } | null = null;
    const result = await inTx(this.pool, async (tx) => {
      const s = await this.sessionByToken(tx, token, true);
      if (s.status !== 'open') throw new ContractError('link_invalid');
      if (!this.otpFresh(s)) throw new ContractError('otp_required');
      if (input.documentSha256 !== s.document_sha256) throw new ContractError('document_changed');
      const required = keyTerms(s.signer_role, s.field_values).map((t) => t.key);
      if (!input.intentToSign || required.some((k) => !input.acknowledged.includes(k))) throw new ContractError('terms_not_acknowledged');
      if (input.typedName.trim().length < 2 && !input.signaturePng) throw new ContractError('signature_missing');

      // The signing page always sends its device id; without one the independence check cannot run.
      if (!ctx.deviceId || !/^[A-Za-z0-9_-]{16,100}$/.test(ctx.deviceId)) throw new ContractError('device_required');
      const deviceHash = sha256(`device:${ctx.deviceId}`);
      if (s.signer_role === 'guarantor') {
        const borrower = (
          await tx.query<{ device_id_hash: string | null; evidence: { ip?: string } | null }>(
            `SELECT device_id_hash, evidence FROM signing_session WHERE contract_id = $1 AND signer_role = 'borrower'`,
            [s.contract_id],
          )
        ).rows[0]!;
        if (borrower.device_id_hash === deviceHash) {
          await this.ev(tx, s.contract_id, s.id, 'flag_same_device_as_borrower', { ip: ctx.ip ?? null });
          await recordAudit(tx, { actorKind: 'anonymous', action: 'contract.guarantor_same_device', subjectType: 'contract', subjectId: s.contract_id, ...ctx });
          return { refused: true as const };
        }
        if (borrower.evidence?.ip && ctx.ip && borrower.evidence.ip === ctx.ip) {
          await this.ev(tx, s.contract_id, s.id, 'flag_same_network_as_borrower', { ip: ctx.ip });
        }
      }

      const now = this.clock();
      const evidence = {
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        deviceIdHash: deviceHash,
        documentSha256: s.document_sha256,
        acknowledged: required.map((k) => ({ key: k, text: keyTerms(s.signer_role, s.field_values).find((t) => t.key === k)!.text })),
        intentToSign: true,
        typedName: input.typedName.trim(),
        signaturePngSha256: input.signaturePng ? sha256(input.signaturePng) : null,
        otpVerifiedAt: s.otp_verified_at?.toISOString() ?? null,
        signedAt: now.toISOString(),
      };
      await tx.query(
        `UPDATE signing_session SET status = 'signed', signed_at = $2, device_id_hash = $3, evidence = $4, signature_image = $5, token_hash = NULL
          WHERE id = $1`,
        [s.id, now, deviceHash, JSON.stringify(evidence), input.signaturePng ?? null],
      );
      await this.ev(tx, s.contract_id, s.id, 'signed', { role: s.signer_role, documentSha256: s.document_sha256 });
      await tx.query(`UPDATE contract SET status = 'partially_signed' WHERE id = $1 AND status = 'issued'`, [s.contract_id]);

      const next = (
        await tx.query<{ id: string; signer_role: 'guarantor' | 'company'; signer_name: string; phone: string | null }>(
          `SELECT id, signer_role, signer_name, phone FROM signing_session
            WHERE contract_id = $1 AND status = 'waiting' ORDER BY signer_order LIMIT 1`,
          [s.contract_id],
        )
      ).rows[0]!;
      if (next.signer_role === 'guarantor') {
        const t = randomToken();
        await tx.query(
          `UPDATE signing_session SET status = 'open', token_hash = $2, link_sent_at = $3, expires_at = $4 WHERE id = $1`,
          [next.id, sha256(t), now, this.expiry()],
        );
        await this.ev(tx, s.contract_id, next.id, 'link_sent', {});
        nextNotice = { phone: next.phone!, name: next.signer_name, token: t, reference: s.reference };
      } else {
        await tx.query(`UPDATE signing_session SET status = 'open' WHERE id = $1`, [next.id]);
      }
      return { refused: false as const, next: next.signer_role };
    });
    if (result.refused) {
      throw new ContractError('same_device_as_borrower', 'A guarantor must sign on their own phone, not the borrower’s');
    }
    if (nextNotice) await this.sendLink(nextNotice);
    return { status: 'signed', next: result.next };
  }

  async decline(token: string, reason: string, ctx: SignerContext = {}): Promise<void> {
    await inTx(this.pool, async (tx) => {
      const s = await this.sessionByToken(tx, token, true);
      if (s.status !== 'open') throw new ContractError('link_invalid');
      await tx.query(`UPDATE signing_session SET status = 'declined', token_hash = NULL WHERE id = $1`, [s.id]);
      await tx.query(`UPDATE signing_session SET status = 'cancelled', token_hash = NULL WHERE contract_id = $1 AND status IN ('waiting', 'open')`, [s.contract_id]);
      await tx.query(`UPDATE contract SET status = 'rejected', closed_reason = $2 WHERE id = $1`, [s.contract_id, `${s.signer_role} declined: ${reason}`]);
      await this.ev(tx, s.contract_id, s.id, 'declined', { role: s.signer_role, reason, ip: ctx.ip ?? null });
    });
  }

  // ===================== Company signature and execution =====================

  /** A manager signs for the company from their own session; this executes and archives the contract. */
  async countersign(contractId: string, managerId: string, managerName: string, ctx: SignerContext = {}) {
    const executed = await inTx(this.pool, async (tx) => {
      const c = await lockContract(tx, contractId);
      if (c.status !== 'partially_signed') throw new ContractError('invalid_status', `Contract is ${c.status}`);
      const s = (
        await tx.query<{ id: string; status: string; signer_role: string }>(
          `SELECT id, status, signer_role FROM signing_session WHERE contract_id = $1 AND status IN ('waiting', 'open') ORDER BY signer_order LIMIT 1`,
          [contractId],
        )
      ).rows[0];
      if (!s || s.signer_role !== 'company' || s.status !== 'open') throw new ContractError('not_your_turn', 'Other signers have not finished');
      const signer = (await tx.query<{ person_id: string }>('SELECT person_id FROM finance_account WHERE id = $1', [c.finance_account_id])).rows[0]!;
      if (signer.person_id === managerId) throw new ContractError('same_person', 'You cannot countersign your own agreement');

      const now = this.clock();
      const evidence = {
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        staffPersonId: managerId,
        signedAs: managerName,
        acknowledged: keyTerms('company', {}).map((t) => ({ key: t.key, text: t.text })),
        documentSha256: c.document_sha256,
        signedAt: now.toISOString(),
      };
      await tx.query(
        `UPDATE signing_session SET status = 'signed', signer_person_id = $2, signed_at = $3, evidence = $4 WHERE id = $1`,
        [s.id, managerId, now, JSON.stringify(evidence)],
      );
      await this.ev(tx, contractId, s.id, 'signed', { role: 'company', by: managerId });
      return this.executeTx(tx, contractId, c.document_sha256, c.rendered_text, c.reference, c.finance_account_id, managerId);
    });
    return executed;
  }

  private async executeTx(
    tx: Queryable,
    contractId: string,
    documentSha256: string,
    text: string,
    reference: string,
    financeAccountId: string,
    by: string,
  ) {
    const now = this.clock();
    const sessions = (
      await tx.query<{ signer_order: number; signer_role: string; signer_name: string; phone: string | null; signed_at: Date; evidence: Record<string, unknown> }>(
        `SELECT signer_order, signer_role, signer_name, phone, signed_at, evidence FROM signing_session WHERE contract_id = $1 ORDER BY signer_order`,
        [contractId],
      )
    ).rows;
    const events = (
      await tx.query<{ at: Date; event: string; details: Record<string, unknown> }>(
        `SELECT at, event, details FROM contract_event WHERE contract_id = $1 ORDER BY id`,
        [contractId],
      )
    ).rows;
    const certificate = {
      kind: 'execution_certificate',
      note: 'SHA-256 values are tamper evidence: they show the document has not changed since signing. They are not a qualified digital signature.',
      contractId,
      reference,
      documentSha256,
      executedAt: now.toISOString(),
      signers: sessions.map((s) => ({
        order: s.signer_order,
        role: s.signer_role,
        name: s.signer_name,
        phone: s.phone ? maskPhone(s.phone) : null,
        signedAt: s.signed_at.toISOString(),
        evidence: s.evidence,
      })),
      events: events.map((e) => ({ at: e.at.toISOString(), event: e.event, details: e.details })),
    };
    const certBody = Buffer.from(JSON.stringify(certificate, null, 2));
    const base = `contracts/${reference}/${contractId}`;
    const doc = await this.archive(`${base}/agreement.txt`, Buffer.from(text), 'text/plain; charset=utf-8');
    if (doc.sha256 !== documentSha256) throw new Error('Archived document hash does not match the issued hash');
    // Timestamped key: if this transaction rolls back after archiving, a retry writes a new object
    // instead of colliding with the stray one; only the committed key is recorded.
    const cert = await this.archive(`${base}/execution-certificate-${now.toISOString().replace(/[:.]/g, '-')}.json`, certBody, 'application/json');

    await tx.query(
      `UPDATE contract SET status = 'fully_executed', executed_at = $2, archive_document_key = $3, archive_certificate_key = $4, certificate_sha256 = $5
        WHERE id = $1`,
      [contractId, now, doc.key, cert.key, cert.sha256],
    );
    await this.ev(tx, contractId, null, 'executed', { certificateSha256: cert.sha256 });
    await tx.query(`UPDATE finance_account SET status = 'contracted' WHERE id = $1 AND status = 'approved'`, [financeAccountId]);
    await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'contract.executed', subjectType: 'finance_account', subjectId: reference, details: { contractId, documentSha256, certificateSha256: cert.sha256 } });
    return { contractId, documentSha256, certificateSha256: cert.sha256, documentKey: doc.key, certificateKey: cert.key };
  }

  /** Write-once archive. A retry after a crash finds the object already there and checks it matches. */
  private async archive(key: string, body: Buffer, contentType: string) {
    try {
      return await this.documents.put(key, body, contentType);
    } catch (err) {
      const existing = await this.documents.get(key).catch(() => null);
      if (existing && sha256(existing) === sha256(body)) return { key, sha256: sha256(body) };
      throw err;
    }
  }

  // ===================== Staff controls =====================

  async revoke(contractId: string, by: string, reason: string) {
    await inTx(this.pool, async (tx) => {
      const c = await lockContract(tx, contractId);
      if (!['issued', 'partially_signed'].includes(c.status)) throw new ContractError('invalid_status', `Contract is ${c.status}`);
      await tx.query(`UPDATE signing_session SET status = 'cancelled', token_hash = NULL WHERE contract_id = $1 AND status IN ('waiting', 'open')`, [contractId]);
      await tx.query(`UPDATE contract SET status = 'revoked', closed_reason = $2 WHERE id = $1`, [contractId, reason]);
      await this.ev(tx, contractId, null, 'revoked', { by, reason });
      await recordAudit(tx, { actorId: by, actorKind: 'person', action: 'contract.revoked', subjectType: 'finance_account', subjectId: c.reference, details: { contractId, reason } });
    });
  }

  /** New link for whoever is due to sign now (expired or lost SMS). The previous link stops working. */
  async resendLink(contractId: string, by: string) {
    const notice = await inTx(this.pool, async (tx) => {
      const c = await lockContract(tx, contractId);
      if (!['issued', 'partially_signed'].includes(c.status)) throw new ContractError('invalid_status');
      const s = (
        await tx.query<{ id: string; signer_role: string; signer_name: string; phone: string | null }>(
          `SELECT id, signer_role, signer_name, phone FROM signing_session WHERE contract_id = $1 AND status IN ('open', 'expired') ORDER BY signer_order LIMIT 1`,
          [contractId],
        )
      ).rows[0];
      if (!s || s.signer_role === 'company' || !s.phone) throw new ContractError('not_your_turn', 'Nobody outside the company is due to sign');
      const t = randomToken();
      await tx.query(
        `UPDATE signing_session SET status = 'open', token_hash = $2, link_sent_at = $3, expires_at = $4, otp_hash = NULL, otp_verified_at = NULL, otp_attempts = 0
          WHERE id = $1`,
        [s.id, sha256(t), this.clock(), this.expiry()],
      );
      await this.ev(tx, contractId, s.id, 'link_resent', { by });
      return { phone: s.phone, name: s.signer_name, token: t, reference: c.reference };
    });
    await this.sendLink(notice);
  }

  async forAccount(financeAccountId: string) {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM contract WHERE finance_account_id = $1 ORDER BY issued_at DESC`,
      [financeAccountId],
    );
    const out = [];
    for (const r of rows) {
      const c = (
        await this.pool.query(
          `SELECT id, status, document_sha256 AS "documentSha256", is_placeholder AS "isPlaceholder", issued_at AS "issuedAt",
                  executed_at AS "executedAt", certificate_sha256 AS "certificateSha256", closed_reason AS "closedReason",
                  archive_document_key AS "documentKey", archive_certificate_key AS "certificateKey"
             FROM contract WHERE id = $1`,
          [r.id],
        )
      ).rows[0];
      const signers = (
        await this.pool.query<{ signer_order: number; signer_role: string; signer_name: string; phone: string | null; status: string; signed_at: Date | null; expires_at: Date | null }>(
          `SELECT signer_order, signer_role, signer_name, phone, status, signed_at, expires_at FROM signing_session WHERE contract_id = $1 ORDER BY signer_order`,
          [r.id],
        )
      ).rows.map((s) => ({
        order: s.signer_order,
        role: s.signer_role,
        name: s.signer_name,
        phone: s.phone ? maskPhone(s.phone) : null,
        status: s.status === 'open' && s.expires_at && s.expires_at <= this.clock() ? 'expired' : s.status,
        signedAt: s.signed_at,
      }));
      const flags = (
        await this.pool.query<{ event: string }>(`SELECT event FROM contract_event WHERE contract_id = $1 AND event LIKE 'flag_%'`, [r.id])
      ).rows.map((f) => f.event);
      out.push({ ...c, signers, flags });
    }
    return out;
  }

  // ===================== internals =====================

  /** Events use the service clock, so time windows (OTP send limits) and the certificate agree. */
  private ev(db: Queryable, contractId: string, sessionId: string | null, name: string, details: Record<string, unknown>) {
    return event(db, contractId, sessionId, name, details, this.clock());
  }

  private expiry() {
    return new Date(this.clock().getTime() + this.linkTtlMs);
  }

  private otpHash(sessionId: string, code: string) {
    return createHmac('sha256', this.config.otpPepper).update(`sign:${sessionId}:${code}`).digest('hex');
  }

  private otpFresh(s: SessionRow) {
    return !!s.otp_verified_at && this.clock().getTime() - s.otp_verified_at.getTime() < OTP_VALID_FOR_SIGNING_MS;
  }

  private async sendLink(n: { phone: string; name: string; token: string; reference: string }) {
    await this.messaging.send('sms', n.phone, 'contract_sign_link', {
      name: n.name,
      reference: n.reference,
      url: `${this.config.signingBaseUrl}#${n.token}`,
    });
  }

  private async openSession(token: string): Promise<SessionRow> {
    const s = await this.sessionByToken(this.pool, token);
    if (s.status !== 'open') throw new ContractError('link_invalid');
    return s;
  }

  private async sessionByToken(db: Queryable, token: string, forUpdate = false): Promise<SessionRow> {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new ContractError('link_invalid');
    const { rows } = await db.query<SessionRow>(
      `SELECT s.id, s.contract_id, s.signer_order, s.signer_role, s.guarantor_id, s.signer_name, s.phone, s.status, s.expires_at,
              s.otp_hash, s.otp_expires_at, s.otp_attempts, s.otp_verified_at,
              c.status AS contract_status, c.document_sha256, c.rendered_text, c.field_values, c.is_placeholder, f.reference
         FROM signing_session s JOIN contract c ON c.id = s.contract_id JOIN finance_account f ON f.id = c.finance_account_id
        WHERE s.token_hash = $1 ${forUpdate ? 'FOR UPDATE OF s' : ''}`,
      [sha256(token)],
    );
    const s = rows[0];
    if (!s || !['issued', 'partially_signed'].includes(s.contract_status)) throw new ContractError('link_invalid');
    if (s.status === 'open' && s.expires_at && s.expires_at <= this.clock()) throw new ContractError('link_invalid', 'This link has expired');
    return s;
  }
}

// ---------------- helpers ----------------

function fieldValues(
  fa: { reference: string; full_name: string | null; phone: string | null },
  terms: TermSet,
  guarantors: { full_name: string }[],
  issueDate: string,
): Record<Placeholder, string> {
  const schedule = generateSchedule(terms, issueDate);
  const total = schedule.reduce((a, i) => a + i.principal + i.interest, 0n);
  const first = schedule[0]!;
  const n = (k: bigint) => formatNaira(kobo(k));
  const pct = (bps: number) => `${(bps / 100).toFixed(2).replace(/\.00$/, '')}%`;
  const maxLiability = (total * BigInt(terms.guarantorMaxLiabilityBps)) / 10_000n;
  return {
    'company.name': brand.name,
    'company.supportPhone': brand.supportPhone,
    'contract.reference': fa.reference,
    'contract.issueDate': issueDate,
    'borrower.name': fa.full_name ?? 'the borrower',
    'borrower.phone': fa.phone ?? '',
    'asset.description': 'one motorcycle, details recorded at handover',
    'asset.price': n(BigInt(terms.assetPriceKobo)),
    'deposit.amount': n(depositOf(terms)),
    'financed.amount': n(financedPrincipalOf(terms)),
    'instalment.amount': n(first.principal + first.interest),
    'instalment.count': String(terms.tenorPeriods),
    'instalment.frequency': terms.frequency,
    'total.payable': n(total),
    'interest.annualRate': pct(terms.annualInterestBps),
    'interest.method': terms.interestMethod === 'flat' ? 'flat' : 'reducing balance',
    'penalty.dailyRate': pct(terms.penaltyBpsPerDay),
    'penalty.graceDays': String(terms.graceDays),
    'arrears.reviewDays': String(terms.repossessionReviewDaysOverdue),
    'arrears.reactivationDays': String(terms.reactivationWindowDays),
    'guarantors.list': guarantors.length
      ? `This agreement is guaranteed by ${guarantors.map((g) => g.full_name).join(', ')}, each up to ${n(maxLiability)}.`
      : 'No guarantor is required.',
    'guarantor.maxLiability': n(maxLiability),
    'schedule.summary': `The first instalment is due one ${terms.frequency === 'daily' ? 'day' : terms.frequency === 'weekly' ? 'week' : 'month'} after handover; the full schedule is given to the Hirer at handover.`,
  };
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

function safeEq(a: string, b: string) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

async function event(
  db: Queryable,
  contractId: string,
  sessionId: string | null,
  name: string,
  details: Record<string, unknown>,
  at: Date,
) {
  await db.query(`INSERT INTO contract_event (contract_id, session_id, event, details, at) VALUES ($1, $2, $3, $4, $5)`, [
    contractId,
    sessionId,
    name,
    JSON.stringify(details),
    at,
  ]);
}

async function lockAccount(tx: Queryable, id: string) {
  const { rows } = await tx.query<{
    id: string;
    reference: string;
    status: string;
    product_code: string;
    person_id: string;
    current_snapshot_id: string | null;
    full_name: string | null;
    phone: string | null;
  }>(
    `SELECT f.id, f.reference, f.status, f.product_code, f.person_id, f.current_snapshot_id, p.full_name, p.phone
       FROM finance_account f JOIN person p ON p.id = f.person_id WHERE f.id = $1 FOR UPDATE OF f`,
    [id],
  );
  if (!rows[0]) throw new ContractError('not_found');
  return rows[0];
}

async function lockContract(tx: Queryable, id: string) {
  const { rows } = await tx.query<{ id: string; status: string; document_sha256: string; rendered_text: string; finance_account_id: string; reference: string }>(
    `SELECT c.id, c.status, c.document_sha256, c.rendered_text, c.finance_account_id, f.reference
       FROM contract c JOIN finance_account f ON f.id = c.finance_account_id WHERE c.id = $1 FOR UPDATE OF c`,
    [id],
  );
  if (!rows[0]) throw new ContractError('not_found');
  return rows[0];
}

async function inTx<T>(pool: PoolLike, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
