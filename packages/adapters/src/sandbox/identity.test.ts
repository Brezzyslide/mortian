import { describe, expect, it } from 'vitest';
import { SandboxIdentityVerification } from './identity.js';

const base = { personId: 'P-1', phone: '+2348000000000', fullName: 'Test Person', dateOfBirth: '1990-01-01' };

describe('SandboxIdentityVerification', () => {
  const adapter = new SandboxIdentityVerification();

  it('declares itself as sandbox', () => {
    expect(adapter.info.mode).toBe('sandbox');
  });

  it.each([
    ['12345678901', 'verified'],
    ['12345678900', 'failed'],
    ['12345678909', 'manual_review'],
  ])('NIN %s → %s', async (nin, outcome) => {
    expect((await adapter.verify({ ...base, nin })).outcome).toBe(outcome);
  });

  it('fails without an identifier', async () => {
    expect((await adapter.verify(base)).outcome).toBe('failed');
  });
});
