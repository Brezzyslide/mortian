import { describe, expect, it } from 'vitest';
import { InvalidWebhookPayloadError, InvalidWebhookSignatureError } from '../ports.js';
import { SANDBOX_SIGNATURE_HEADER, SandboxCollections } from './collections.js';

const adapter = new SandboxCollections('test-webhook-secret-123');
const event = { reference: 'PAY-1', accountNumber: '9912345678', amountKobo: '500000', paidAt: '2026-11-23T08:00:00Z' };

describe('SandboxCollections.parseWebhook', () => {
  it('accepts a correctly signed payment and parses amount as exact kobo', () => {
    const { body, headers } = adapter.buildWebhook(event);
    const p = adapter.parseWebhook(body, headers)!;
    expect(p.amount).toBe(500000n);
    expect(p.virtualAccountNumber).toBe('9912345678');
    expect(p.paidAt.toISOString()).toBe('2026-11-23T08:00:00.000Z');
  });

  it('rejects a missing, malformed or wrong signature', () => {
    const { body } = adapter.buildWebhook(event);
    expect(() => adapter.parseWebhook(body, {})).toThrow(InvalidWebhookSignatureError);
    expect(() => adapter.parseWebhook(body, { [SANDBOX_SIGNATURE_HEADER]: 'abc' })).toThrow(InvalidWebhookSignatureError);
    const other = new SandboxCollections('a-different-secret-456');
    expect(() => adapter.parseWebhook(body, other.buildWebhook(event).headers)).toThrow(InvalidWebhookSignatureError);
  });

  it('rejects a body altered after signing, even by one byte', () => {
    const { body, headers } = adapter.buildWebhook(event);
    const tampered = Buffer.from(body.toString().replace('500000', '900000'));
    expect(() => adapter.parseWebhook(tampered, headers)).toThrow(InvalidWebhookSignatureError);
  });

  it.each([
    ['amountKobo', '0'],
    ['amountKobo', '-5'],
    ['amountKobo', '12.50'],
    ['accountNumber', '123'],
    ['reference', 'has spaces'],
    ['paidAt', 'yesterday'],
  ])('rejects bad %s = %s', (field, value) => {
    const { body, headers } = adapter.buildWebhook({ ...event, [field]: value });
    expect(() => adapter.parseWebhook(body, headers)).toThrow(InvalidWebhookPayloadError);
  });

  it('ignores non-payment events', () => {
    const body = Buffer.from(JSON.stringify({ event: 'account.updated' }));
    expect(adapter.parseWebhook(body, { [SANDBOX_SIGNATURE_HEADER]: adapter.sign(body) })).toBeNull();
  });

  it('issues sandbox account numbers in the 99 range', async () => {
    const va = await adapter.createVirtualAccount('fa-1');
    expect(va.accountNumber).toMatch(/^99\d{8}$/);
  });
});
