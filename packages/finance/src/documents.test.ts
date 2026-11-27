import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryDocumentStore } from '@project/adapters';
import { createTestDatabase, type TestDatabase } from '@project/db';
import { CustomerDocumentService, MAX_PENDING_DOCUMENTS, sniffType } from './documents.js';

let db: TestDatabase;
let store: MemoryDocumentStore;
let docs: CustomerDocumentService;
let customer: string;
let staff: string;
let n = 0;

const jpeg = (tag = String(++n)) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo-${tag}`)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`png-${++n}`)]);
const pdf = () => Buffer.from(`%PDF-1.7 doc ${++n}`);

beforeAll(async () => {
  db = await createTestDatabase();
  const p = await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000001') RETURNING id`);
  customer = p.rows[0].id;
  staff = (await db.pool.query(`INSERT INTO person (email) VALUES ('uw@x.com') RETURNING id`)).rows[0].id;
  store = new MemoryDocumentStore();
  docs = new CustomerDocumentService(db.pool, store);
});
afterAll(async () => db?.drop());

describe('customer documents', () => {
  it('accepts JPEG, PNG and PDF by their bytes, whatever they are called', async () => {
    expect(sniffType(jpeg())).toBe('image/jpeg');
    expect(sniffType(png())).toBe('image/png');
    expect(sniffType(pdf())).toBe('application/pdf');
    expect(sniffType(Buffer.from('<html><script>alert(1)</script>'))).toBeNull();
    expect(sniffType(Buffer.from('GIF89a'))).toBeNull();

    const d = await docs.upload(customer, 'national_id', jpeg());
    expect(d).toMatchObject({ kind: 'national_id', contentType: 'image/jpeg', status: 'submitted' });
    const row = (await db.pool.query('SELECT storage_key, sha256 FROM customer_document WHERE id = $1', [d.id])).rows[0];
    expect(row.storage_key).toMatch(new RegExp(`^kyc/${customer}/[0-9a-f-]{36}\\.jpg$`));
    expect(store.objects.get(row.storage_key)!.contentType).toBe('image/jpeg');
  });

  it('refuses empty, oversized, unknown and repeated files', async () => {
    await expect(docs.upload(customer, 'passport', Buffer.alloc(0))).rejects.toMatchObject({ code: 'empty' });
    await expect(docs.upload(customer, 'passport', Buffer.concat([pdf(), Buffer.alloc(8 * 1024 * 1024)]))).rejects.toMatchObject({ code: 'too_large' });
    await expect(docs.upload(customer, 'passport', Buffer.from('MZ executable'))).rejects.toMatchObject({ code: 'unsupported_type' });
    const same = jpeg('same');
    await docs.upload(customer, 'drivers_licence', same);
    await expect(docs.upload(customer, 'drivers_licence', same)).rejects.toMatchObject({ code: 'duplicate' });
  });

  it('a new upload of the same type replaces the pending one; customers stop seeing it, staff still can', async () => {
    const p = (await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000011') RETURNING id`)).rows[0].id;
    const first = await docs.upload(p, 'national_id', jpeg('first'));
    const second = await docs.upload(p, 'national_id', jpeg('second'));
    expect((await docs.forPerson(p)).map((d) => d.id)).toEqual([second.id]);
    const all = await docs.forPerson(p, { includeReplaced: true });
    expect(all.find((d) => d.id === first.id)).toMatchObject({ status: 'replaced' });
    expect((await db.pool.query('SELECT replaced_by FROM customer_document WHERE id = $1', [first.id])).rows[0].replaced_by).toBe(second.id);
    const audit = await db.pool.query(`SELECT details FROM audit_event WHERE action = 'document.uploaded' AND subject_id = $1`, [second.id]);
    expect(audit.rows[0].details.replaces).toEqual([first.id]);
    // the replaced file is kept
    expect((await docs.file(first.id, staff)).contentType).toBe('image/jpeg');
    // a replaced upload can no longer be reviewed
    await expect(docs.review(first.id, staff, 'accepted', null)).rejects.toMatchObject({ code: 'already_reviewed' });
  });

  it('does not replace reviewed uploads, other types, or "other" documents', async () => {
    const p = (await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000012') RETURNING id`)).rows[0].id;
    const accepted = await docs.upload(p, 'national_id', jpeg('a1'));
    await docs.review(accepted.id, staff, 'accepted', null);
    const licence = await docs.upload(p, 'drivers_licence', jpeg('l1'));
    const o1 = await docs.upload(p, 'other', jpeg('o1'));
    const o2 = await docs.upload(p, 'other', jpeg('o2'));
    await docs.upload(p, 'national_id', jpeg('a2'));
    const status = Object.fromEntries((await docs.forPerson(p, { includeReplaced: true })).map((d) => [d.id, d.status]));
    expect(status[accepted.id]).toBe('accepted');
    expect(status[licence.id]).toBe('submitted');
    expect([status[o1.id], status[o2.id]]).toEqual(['submitted', 'submitted']);
  });

  it('two uploads of the same type at once leave exactly one pending', async () => {
    const p = (await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000013') RETURNING id`)).rows[0].id;
    await Promise.allSettled([docs.upload(p, 'passport', jpeg('x1')), docs.upload(p, 'passport', jpeg('x2'))]);
    const pending = (await docs.forPerson(p, { includeReplaced: true })).filter((d) => d.status === 'submitted');
    expect(pending).toHaveLength(1);
  });

  it('the database refuses a second pending upload of a type, and a replaced row without a pointer', async () => {
    const p = (await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000014') RETURNING id`)).rows[0].id;
    const d = await docs.upload(p, 'voters_card', jpeg('v1'));
    const ins = (n: string) =>
      db.pool.query(
        `INSERT INTO customer_document (person_id, kind, content_type, size_bytes, sha256, storage_key) VALUES ($1, 'voters_card', 'image/jpeg', 10, $2, $3)`,
        [p, n.repeat(64).slice(0, 64), `kyc/${p}/${n}.jpg`],
      );
    await expect(ins('a')).rejects.toThrow(/one_pending_per_kind/);
    await expect(db.pool.query(`UPDATE customer_document SET status = 'replaced' WHERE id = $1`, [d.id])).rejects.toThrow(/replaced_check/);
  });

  it('caps how many can wait for review at once', async () => {
    const p = (await db.pool.query(`INSERT INTO person (phone) VALUES ('+2348060000002') RETURNING id`)).rows[0].id;
    for (let i = 0; i < MAX_PENDING_DOCUMENTS; i++) await docs.upload(p, 'other', jpeg());
    await expect(docs.upload(p, 'other', jpeg())).rejects.toMatchObject({ code: 'too_many_pending' });
  });

  it('staff review once, with a reason for a rejection; the file is checked against its hash', async () => {
    const d = await docs.upload(customer, 'proof_of_address', pdf());
    await expect(docs.review(d.id, customer, 'accepted', null)).rejects.toMatchObject({ code: 'own_document' });
    await expect(docs.review(d.id, staff, 'rejected', 'bad')).rejects.toMatchObject({ code: 'empty' });
    const r = await docs.review(d.id, staff, 'rejected', 'Utility bill is older than 3 months');
    expect(r).toMatchObject({ status: 'rejected', reviewNote: 'Utility bill is older than 3 months' });
    await expect(docs.review(d.id, staff, 'accepted', null)).rejects.toMatchObject({ code: 'already_reviewed' });
    await expect(db.pool.query(`UPDATE customer_document SET status = 'accepted' WHERE id = $1`, [d.id])).rejects.toThrow(/already reviewed/);

    const f = await docs.file(d.id, staff);
    expect(f.contentType).toBe('application/pdf');
    const viewed = await db.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'document.viewed' AND subject_id = $1`, [d.id]);
    expect(viewed.rows[0].n).toBe(1);

    // a file swapped in storage is detected, not served
    const key = (await db.pool.query('SELECT storage_key FROM customer_document WHERE id = $1', [d.id])).rows[0].storage_key;
    store.objects.set(key, { body: Buffer.from('%PDF-tampered'), contentType: 'application/pdf' });
    await expect(docs.file(d.id, staff)).rejects.toThrow(/does not match its hash/);
  });

  it('a customer sees their own documents and the reasons for rejections', async () => {
    const mine = await docs.forPerson(customer);
    expect(mine.length).toBeGreaterThanOrEqual(3);
    expect(mine.find((d) => d.status === 'rejected')!.reviewNote).toMatch(/older than 3 months/);
    expect(mine.every((d) => !('storageKey' in d) && !('sha256' in d))).toBe(true);
  });
});
