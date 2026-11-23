import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { DocumentStore, StoredDocument } from './ports.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** For tests and local development. Not durable. */
export class MemoryDocumentStore implements DocumentStore {
  readonly info = { port: 'DocumentStore', provider: 'memory', mode: 'sandbox' } as const;
  readonly objects = new Map<string, { body: Buffer; contentType: string }>();

  async put(key: string, body: Buffer, contentType: string): Promise<StoredDocument> {
    if (this.objects.has(key)) throw new Error(`Document ${key} already exists`);
    this.objects.set(key, { body: Buffer.from(body), contentType });
    return { key, sha256: sha256(body) };
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`Document ${key} not found`);
    return Buffer.from(o.body);
  }
}

/**
 * The contracts archive bucket (Object Lock, see infra core stack). Writes are conditional
 * (If-None-Match), so an existing key is never overwritten, and S3 verifies the SHA-256 on upload.
 */
export class S3DocumentStore implements DocumentStore {
  readonly info = { port: 'DocumentStore', provider: 's3', mode: 'live' } as const;
  constructor(
    private readonly bucket: string,
    private readonly client: S3Client = new S3Client({}),
  ) {}

  async put(key: string, body: Buffer, contentType: string): Promise<StoredDocument> {
    const hash = sha256(body);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
      }),
    );
    return { key, sha256: hash };
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
}
