import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  base32Decode,
  base32Encode,
  decrypt,
  encrypt,
  hashPassword,
  hotp,
  matchTotp,
  verifyPassword,
} from './crypto.js';
import { maskPhone, normalizeNigerianMobile } from './phone.js';

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i → %s', (t, code) => {
    expect(hotp(secret, Math.floor(t / 30))).toBe(code);
  });

  it('accepts ±1 step and rejects further drift', () => {
    const at = new Date(1111111109 * 1000);
    const step = Math.floor(1111111109 / 30);
    expect(matchTotp(secret, hotp(secret, step - 1), at)).toBe(step - 1);
    expect(matchTotp(secret, hotp(secret, step + 1), at)).toBe(step + 1);
    expect(matchTotp(secret, hotp(secret, step + 2), at)).toBeNull();
    expect(matchTotp(secret, 'abcdef', at)).toBeNull();
  });

  it('round-trips base32', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
  });
});

describe('passwords', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterz', h)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password!!')).not.toBe(await hashPassword('same password!!'));
  });
});

describe('field encryption', () => {
  const key = randomBytes(32);
  it('round-trips and detects tampering', () => {
    const sealed = encrypt(key, 'JBSWY3DPEHPK3PXP');
    expect(decrypt(key, sealed)).toBe('JBSWY3DPEHPK3PXP');
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3]!, 'base64');
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString('base64');
    expect(() => decrypt(key, parts.join('.'))).toThrow();
    expect(() => decrypt(randomBytes(32), sealed)).toThrow();
  });
});

describe('Nigerian mobile numbers', () => {
  it.each([
    ['08031234567', '+2348031234567'],
    ['8031234567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+234 803 123 4567', '+2348031234567'],
    ['0703-123-4567', '+2347031234567'],
    ['09131234567', '+2349131234567'],
  ])('%s → %s', (input, out) => {
    expect(normalizeNigerianMobile(input)).toBe(out);
  });

  it.each(['0803123456', '08231234567', '+447911123456', '01234567890', 'abc'])('rejects %s', (input) => {
    expect(normalizeNigerianMobile(input)).toBeNull();
  });

  it('masks for display', () => {
    expect(maskPhone('+2348031234567')).toBe('+234 803 *** 4567');
  });
});
