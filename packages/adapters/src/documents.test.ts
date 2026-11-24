import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FolderDocumentStore } from './documents.js';

describe('FolderDocumentStore', () => {
  let dir: string;
  let store: FolderDocumentStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docs-'));
    store = new FolderDocumentStore(dir);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('stores and reads back, surviving a new instance', async () => {
    const r = await store.put('contracts/a/b.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await new FolderDocumentStore(dir).get('contracts/a/b.pdf')).toString()).toBe('pdf');
  });

  it('refuses to overwrite an existing key', async () => {
    await store.put('k.pdf', Buffer.from('one'), 'application/pdf');
    await expect(store.put('k.pdf', Buffer.from('two'), 'application/pdf')).rejects.toThrow(/already exists/);
    expect((await store.get('k.pdf')).toString()).toBe('one');
  });

  it('rejects keys that escape the folder', async () => {
    await expect(store.put('../outside.pdf', Buffer.from('x'), 'application/pdf')).rejects.toThrow(/escapes/);
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/escapes/);
  });

  it('reports a missing key as not found', async () => {
    await expect(store.get('nope.pdf')).rejects.toThrow(/not found/);
  });
});
