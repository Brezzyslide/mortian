import { createHash, randomUUID } from 'node:crypto';
import type { DocumentStore } from '@project/adapters';
import { recordAudit, type PoolLike } from '@project/identity';

export const DOCUMENT_KINDS = ['national_id', 'drivers_licence', 'voters_card', 'passport', 'proof_of_address', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** Uploads a customer can have waiting for review at once; stops one account filling the bucket. */
export const MAX_PENDING_DOCUMENTS = 10;

export class DocumentError extends Error {
  constructor(
    readonly code: 'not_found' | 'unsupported_type' | 'too_large' | 'empty' | 'duplicate' | 'too_many_pending' | 'already_reviewed' | 'own_document',
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * The file type comes from the bytes, never from what the client says. Only JPEG, PNG and PDF
 * are accepted.
 */
export function sniffType(body: Buffer): 'image/jpeg' | 'image/png' | 'application/pdf' | null {
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg';
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body.length >= 5 && body.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export interface CustomerDocument {
  id: string;
  kind: DocumentKind;
  contentType: string;
  sizeBytes: number;
  status: 'submitted' | 'accepted' | 'rejected';
  uploadedAt: Date;
  reviewedAt: Date | null;
  reviewNote: string | null;
}

const COLUMNS = `id, kind, content_type AS "contentType", size_bytes AS "sizeBytes", status, uploaded_at AS "uploadedAt",
                 reviewed_at AS "reviewedAt", review_note AS "reviewNote"`;

/**
 * ID and supporting documents. Files go to a dedicated, encrypted store (not the contracts
 * archive, which locks files for years). The database keeps the hash, so a file can be checked
 * against what was reviewed.
 */
export class CustomerDocumentService {
  constructor(
    private readonly pool: PoolLike,
    private readonly store: DocumentStore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async upload(personId: string, kind: DocumentKind, body: Buffer): Promise<CustomerDocument> {
    if (body.length === 0) throw new DocumentError('empty');
    if (body.length > MAX_DOCUMENT_BYTES) throw new DocumentError('too_large', 'Files can be at most 8 MB');
    const contentType = sniffType(body);
    if (!contentType) throw new DocumentError('unsupported_type', 'Upload a photo (JPEG or PNG) or a PDF');
    const sha256 = createHash('sha256').update(body).digest('hex');

    const pending = await this.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM customer_document WHERE person_id = $1 AND status = 'submitted'`, [personId]);
    if (pending.rows[0]!.n >= MAX_PENDING_DOCUMENTS) throw new DocumentError('too_many_pending', 'Wait for your documents to be reviewed before adding more');
    const dup = await this.pool.query('SELECT 1 FROM customer_document WHERE person_id = $1 AND sha256 = $2', [personId, sha256]);
    if (dup.rows[0]) throw new DocumentError('duplicate', 'You have already uploaded this file');

    // Key carries no personal data: person id and a random id only.
    const ext = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
    const key = `kyc/${personId}/${randomUUID()}.${ext}`;
    await this.store.put(key, body, contentType);
    try {
      const { rows } = await this.pool.query<CustomerDocument>(
        `INSERT INTO customer_document (person_id, kind, content_type, size_bytes, sha256, storage_key, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [personId, kind, contentType, body.length, sha256, key, this.clock()],
      );
      await recordAudit(this.pool, { actorId: personId, actorKind: 'person', action: 'document.uploaded', subjectType: 'customer_document', subjectId: rows[0]!.id, details: { kind, sha256 } });
      return rows[0]!;
    } catch (e) {
      // A double tap can race past the duplicate check; the unique index decides.
      if ((e as { code?: string }).code === '23505') throw new DocumentError('duplicate', 'You have already uploaded this file');
      throw e;
    }
  }

  async forPerson(personId: string): Promise<CustomerDocument[]> {
    const { rows } = await this.pool.query<CustomerDocument>(`SELECT ${COLUMNS} FROM customer_document WHERE person_id = $1 ORDER BY uploaded_at DESC`, [personId]);
    return rows;
  }

  /** Staff: the file itself, checked against the hash recorded at upload. */
  async file(documentId: string, staffId: string): Promise<{ body: Buffer; contentType: string; kind: string }> {
    const { rows } = await this.pool.query<{ storage_key: string; sha256: string; content_type: string; kind: string }>(
      'SELECT storage_key, sha256, content_type, kind FROM customer_document WHERE id = $1',
      [documentId],
    );
    const d = rows[0];
    if (!d) throw new DocumentError('not_found');
    const body = await this.store.get(d.storage_key);
    if (createHash('sha256').update(body).digest('hex') !== d.sha256) throw new Error(`Stored file for document ${documentId} does not match its hash`);
    // Who looked at whose ID is recorded.
    await recordAudit(this.pool, { actorId: staffId, actorKind: 'person', action: 'document.viewed', subjectType: 'customer_document', subjectId: documentId });
    return { body, contentType: d.content_type, kind: d.kind };
  }

  async review(documentId: string, staffId: string, decision: 'accepted' | 'rejected', note: string | null): Promise<CustomerDocument> {
    const d = (await this.pool.query<{ person_id: string; status: string }>('SELECT person_id, status FROM customer_document WHERE id = $1', [documentId])).rows[0];
    if (!d) throw new DocumentError('not_found');
    if (d.person_id === staffId) throw new DocumentError('own_document', 'Staff cannot review their own documents');
    if (d.status !== 'submitted') throw new DocumentError('already_reviewed');
    if (decision === 'rejected' && (!note || note.trim().length < 5)) throw new DocumentError('empty', 'Say why it was rejected, so the customer can fix it');
    const { rows } = await this.pool.query<CustomerDocument>(
      `UPDATE customer_document SET status = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5
        WHERE id = $1 AND status = 'submitted' RETURNING ${COLUMNS}`,
      [documentId, decision, staffId, this.clock(), note],
    );
    if (!rows[0]) throw new DocumentError('already_reviewed');
    await recordAudit(this.pool, { actorId: staffId, actorKind: 'person', action: `document.${decision}`, subjectType: 'customer_document', subjectId: documentId, details: { note } });
    return rows[0];
  }
}
