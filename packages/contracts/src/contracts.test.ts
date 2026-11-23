import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { MemoryDocumentStore, SandboxCollections, SandboxMessaging } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { CollectionsService, LendingService, MOTORCYCLE_PLACEHOLDER_TIERS } from '@project/finance';
import { ContractError, ContractsService } from './service.js';
import { render, unknownPlaceholders } from './template.js';

let db: TestDatabase;
let now = new Date('2026-12-01T09:00:00Z');
const clock = () => now;
let messaging: SandboxMessaging;
let docs: MemoryDocumentStore;
let contracts: ContractsService;
const lending = () => new LendingService(db.pool, clock); // default: signed contract required
let underwriter: string;
let manager: string;
let n = 0;

beforeAll(async () => {
  db = await createTestDatabase();
  const p = await db.pool.query(`INSERT INTO person (email, full_name) VALUES ('uw@x.com', 'Uche'), ('mgr@x.com', 'Mary Manager') RETURNING id`);
  underwriter = p.rows[0].id;
  manager = p.rows[1].id;
  for (const [tier, config] of Object.entries(MOTORCYCLE_PLACEHOLDER_TIERS)) {
    await lending().publishTier('motorcycle_ride_to_own', tier, config, { actorId: null, isPlaceholder: true });
  }
});
afterAll(async () => db?.drop());
beforeEach(async () => {
  messaging = new SandboxMessaging();
  docs = new MemoryDocumentStore();
  contracts = new ContractsService(db.pool, messaging, docs, { otpPepper: randomBytes(32), signingBaseUrl: 'https://app.test/sign/' }, clock);
  await contracts.seedPlaceholderTemplate(manager);
});

const phone = () => `+234806${String(++n).padStart(7, '0')}`;
const local = (e164: string) => `0${e164.slice(4)}`;
const device = () => randomBytes(16).toString('hex');

/** Approved account (tier B needs 1 guarantor) with one guarantor added. */
async function approvedAccount(withGuarantor = true) {
  const bPhone = phone();
  const person = await db.pool.query(`INSERT INTO person (phone, full_name) VALUES ($1, 'Bola Rider') RETURNING id`, [bPhone]);
  const fa = await new CollectionsService(db.pool, new SandboxCollections('contracts-test-secret')).openAccount(person.rows[0].id, 'motorcycle_ride_to_own');
  await lending().approve({ financeAccountId: fa.id, tier: 'B', assetPriceKobo: '150000000', underwriterId: underwriter });
  const gPhone = phone();
  if (withGuarantor) await contracts.addGuarantor(fa.id, { fullName: 'Gbenga Guarantor', phone: local(gPhone), relationship: 'brother' }, underwriter);
  return { ...fa, bPhone, gPhone };
}

const tokenFor = (to: string) =>
  [...messaging.sent].reverse().find((m) => m.to === to && m.templateId === 'contract_sign_link')!.vars['url']!.split('#')[1]!;
const otpFor = (to: string) => [...messaging.sent].reverse().find((m) => m.to === to && m.templateId === 'contract_sign_otp')!.vars['code']!;

async function signAs(to: string, deviceId = device()) {
  const token = tokenFor(to);
  const v = await contracts.view(token);
  await contracts.requestOtp(token);
  await contracts.verifyOtp(token, otpFor(to));
  return contracts.sign(
    token,
    { documentSha256: v.documentSha256, acknowledged: v.keyTerms.map((t) => t.key), typedName: v.signerName, intentToSign: true },
    { ip: '10.0.0.1', userAgent: 'test', deviceId },
  );
}

describe('templates', () => {
  it('rejects unknown placeholders and missing values', () => {
    expect(unknownPlaceholders('Hi {{borrower.name}} {{borrower.salary}}')).toEqual(['borrower.salary']);
    expect(() => render('Hi {{borrower.name}}', {})).toThrow(/Missing/);
  });

  it('needs a second person to approve, and approved wording is frozen', async () => {
    const t = await contracts.createTemplate('phone_financing', 'Phone agreement', 'Agreement {{contract.reference}}', underwriter);
    await expect(contracts.approveTemplate(t.id, underwriter, 'reviewed')).rejects.toMatchObject({ code: 'same_person' });
    await contracts.approveTemplate(t.id, manager, 'Reviewed by counsel 2026-12-01');
    await expect(db.pool.query(`UPDATE contract_template SET body = 'changed' WHERE id = $1`, [t.id])).rejects.toThrow(/immutable/);
    await expect(contracts.createTemplate('phone_financing', 'x', '{{nope}}', underwriter)).rejects.toMatchObject({ code: 'invalid_template' });
  });
});

describe('guarantors', () => {
  it('a borrower cannot guarantee themselves, and numbers must be Nigerian mobiles', async () => {
    const fa = await approvedAccount(false);
    await expect(contracts.addGuarantor(fa.id, { fullName: 'Self', phone: local(fa.bPhone), relationship: 'self' }, underwriter)).rejects.toMatchObject({ code: 'guarantor_is_borrower' });
    await expect(contracts.addGuarantor(fa.id, { fullName: 'X', phone: '+447911123456', relationship: 'friend' }, underwriter)).rejects.toMatchObject({ code: 'invalid_phone' });
  });

  it('a contract cannot be issued without the required guarantors', async () => {
    const fa = await approvedAccount(false);
    await expect(contracts.issue(fa.id, underwriter)).rejects.toMatchObject({ code: 'guarantors_missing' });
  });
});

describe('signing in order, end to end', () => {
  it('borrower, then guarantor, then a manager; executes, archives and unlocks activation', async () => {
    const fa = await approvedAccount();
    await expect(lending().activate(fa.id, manager, '2026-12-01')).rejects.toThrow(/fully signed/);

    const { contractId, documentSha256 } = await contracts.issue(fa.id, underwriter);
    expect(messaging.lastTo(fa.bPhone)!.vars['url']).toMatch(/^https:\/\/app\.test\/sign\/#[A-Za-z0-9_-]{40,}$/);
    expect(messaging.sent.some((m) => m.to === fa.gPhone)).toBe(false); // guarantor waits for the borrower

    const view = await contracts.view(tokenFor(fa.bPhone));
    expect(view.isPlaceholder).toBe(true);
    expect(view.documentText).toContain('₦1,500,000.00');
    expect(createHash('sha256').update(view.documentText).digest('hex')).toBe(documentSha256);

    expect((await signAs(fa.bPhone)).next).toBe('guarantor');
    const g = await contracts.view(tokenFor(fa.gPhone));
    expect(g.keyTerms.map((t) => t.key)).toContain('guarantor_liability');
    expect((await signAs(fa.gPhone)).next).toBe('company');

    const r = await contracts.countersign(contractId, manager, 'Mary Manager');
    expect(r.documentKey).toContain(fa.reference);
    expect(docs.objects.get(r.documentKey)!.body.toString()).toBe(view.documentText);
    const cert = JSON.parse(docs.objects.get(r.certificateKey)!.body.toString());
    expect(cert.signers.map((s: { role: string }) => s.role)).toEqual(['borrower', 'guarantor', 'company']);
    expect(cert.note).toMatch(/not a qualified digital signature/);
    expect(createHash('sha256').update(docs.objects.get(r.certificateKey)!.body).digest('hex')).toBe(r.certificateSha256);
    const pdf = docs.objects.get(r.pdfKey)!;
    expect(pdf.contentType).toBe('application/pdf');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(createHash('sha256').update(pdf.body).digest('hex')).toBe(r.pdfSha256);
    expect(cert.pdf).toMatchObject({ key: r.pdfKey, sha256: r.pdfSha256 });
    // once executed, the archive pointers cannot be repointed
    await expect(db.pool.query(`UPDATE contract SET archive_pdf_key = 'contracts/forged.pdf' WHERE id = $1`, [contractId])).rejects.toThrow(/archive is immutable/);
    await expect(db.pool.query(`UPDATE contract SET pdf_sha256 = $2 WHERE id = $1`, [contractId, 'd'.repeat(64)])).rejects.toThrow(/archive is immutable/);
    expect((await contracts.forAccount(fa.id))[0]).toMatchObject({ pdfKey: r.pdfKey, pdfSha256: r.pdfSha256 });

    const status = (await db.pool.query('SELECT status FROM finance_account WHERE id = $1', [fa.id])).rows[0].status;
    expect(status).toBe('contracted');
    // deposit then activate
    const va = await new CollectionsService(db.pool, new SandboxCollections('contracts-test-secret')).provisionVirtualAccount(fa.id, 'Bola');
    const p = new SandboxCollections('contracts-test-secret').buildWebhook({ reference: `DEP-${n}`, accountNumber: va.accountNumber, amountKobo: '30000000', paidAt: now.toISOString() });
    await new CollectionsService(db.pool, new SandboxCollections('contracts-test-secret')).ingestWebhook(p.body, p.headers);
    await expect(lending().activate(fa.id, manager, '2026-12-01')).resolves.toMatchObject({ instalments: 52 });
  });
});

describe('signing safeguards', () => {
  it('refuses a guarantor signing on the borrower’s device, and flags the contract', async () => {
    const fa = await approvedAccount();
    const { contractId } = await contracts.issue(fa.id, underwriter);
    const shared = device();
    await signAs(fa.bPhone, shared);
    await expect(signAs(fa.gPhone, shared)).rejects.toMatchObject({ code: 'same_device_as_borrower' });
    const [c] = await contracts.forAccount(fa.id);
    expect(c!.id).toBe(contractId);
    expect(c!.flags).toContain('flag_same_device_as_borrower');
    // the real guarantor, on their own phone, can still sign with the same link
    await expect(signAs(fa.gPhone)).resolves.toMatchObject({ next: 'company' });
  });

  it('needs an OTP, the exact document hash, every key term and a device id', async () => {
    const fa = await approvedAccount();
    await contracts.issue(fa.id, underwriter);
    const token = tokenFor(fa.bPhone);
    const v = await contracts.view(token);
    const base = { documentSha256: v.documentSha256, acknowledged: v.keyTerms.map((t) => t.key), typedName: 'Bola', intentToSign: true };
    const ctx = { deviceId: device() };
    await expect(contracts.sign(token, base, ctx)).rejects.toMatchObject({ code: 'otp_required' });
    await contracts.requestOtp(token);
    await contracts.verifyOtp(token, otpFor(fa.bPhone));
    await expect(contracts.sign(token, { ...base, documentSha256: 'a'.repeat(64) }, ctx)).rejects.toMatchObject({ code: 'document_changed' });
    await expect(contracts.sign(token, { ...base, acknowledged: base.acknowledged.slice(1) }, ctx)).rejects.toMatchObject({ code: 'terms_not_acknowledged' });
    await expect(contracts.sign(token, { ...base, intentToSign: false }, ctx)).rejects.toMatchObject({ code: 'terms_not_acknowledged' });
    await expect(contracts.sign(token, base, {})).rejects.toMatchObject({ code: 'device_required' });
    await expect(contracts.sign(token, base, ctx)).resolves.toBeDefined();
    await expect(contracts.view(token)).rejects.toMatchObject({ code: 'link_invalid' }); // single use
  });

  it('locks the OTP after 5 wrong codes and limits sends', async () => {
    const fa = await approvedAccount();
    await contracts.issue(fa.id, underwriter);
    const token = tokenFor(fa.bPhone);
    await contracts.requestOtp(token);
    for (let i = 0; i < 4; i++) await expect(contracts.verifyOtp(token, '000000')).rejects.toMatchObject({ code: expect.stringMatching(/otp_invalid|otp_locked/) });
    await expect(contracts.verifyOtp(token, '000000')).rejects.toMatchObject({ code: 'otp_locked' });
    await contracts.requestOtp(token);
    await contracts.requestOtp(token);
    await expect(contracts.requestOtp(token)).rejects.toMatchObject({ code: 'otp_rate_limited' });
  });

  it('links expire after 72 hours; a resend replaces the old link', async () => {
    const fa = await approvedAccount();
    const { contractId } = await contracts.issue(fa.id, underwriter);
    const old = tokenFor(fa.bPhone);
    now = new Date(now.getTime() + 73 * 3_600_000);
    await expect(contracts.view(old)).rejects.toMatchObject({ code: 'link_invalid' });
    await contracts.resendLink(contractId, underwriter);
    const fresh = tokenFor(fa.bPhone);
    expect(fresh).not.toBe(old);
    await expect(contracts.view(fresh)).resolves.toBeDefined();
    await expect(contracts.view(old)).rejects.toMatchObject({ code: 'link_invalid' });
  });

  it('the borrower cannot countersign for the company, and nobody signs out of order', async () => {
    const fa = await approvedAccount();
    const { contractId } = await contracts.issue(fa.id, underwriter);
    await signAs(fa.bPhone);
    await expect(contracts.countersign(contractId, manager, 'Mary')).rejects.toMatchObject({ code: 'not_your_turn' });
    await signAs(fa.gPhone);
    const borrowerPerson = (await db.pool.query('SELECT person_id FROM finance_account WHERE id = $1', [fa.id])).rows[0].person_id;
    await expect(contracts.countersign(contractId, borrowerPerson, 'Bola')).rejects.toMatchObject({ code: 'same_person' });
  });

  it('a decline rejects the contract; a new one can be issued; wording can never change', async () => {
    const fa = await approvedAccount();
    const { contractId } = await contracts.issue(fa.id, underwriter);
    await expect(contracts.issue(fa.id, underwriter)).rejects.toThrow(/contract_one_live/);
    await contracts.decline(tokenFor(fa.bPhone), 'Price is wrong');
    await expect(db.pool.query(`UPDATE contract SET rendered_text = 'x' WHERE id = $1`, [contractId])).rejects.toThrow(/immutable/);
    await expect(db.pool.query(`UPDATE contract SET status = 'issued' WHERE id = $1`, [contractId])).rejects.toThrow(/closed contract/);
    await expect(contracts.issue(fa.id, underwriter)).resolves.toBeDefined();
  });
});

describe('errors', () => {
  it('ContractError carries a code', () => {
    expect(new ContractError('link_invalid').code).toBe('link_invalid');
  });
});
