import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const keys = {
  // What AWS Secrets Manager generates: long alphanumeric strings.
  AUTH_JWT_SECRET: 'a'.repeat(32) + 'B'.repeat(32),
  AUTH_OTP_PEPPER: 'c'.repeat(64),
  AUTH_FIELD_KEY: 'D'.repeat(64),
  COLLECTIONS_WEBHOOK_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('accepts database parts instead of a URL, and Secrets Manager style keys', () => {
    const c = loadConfig({
      ...keys,
      APP_ENV: 'staging',
      DB_HOST: 'db.internal',
      DB_NAME: 'app',
      DB_USER: 'app',
      DB_PASSWORD: 'p',
      DB_SSL_CA_FILE: '/etc/rds/global-bundle.pem',
    });
    expect(c.DB_PORT).toBe(5432);
    expect(c.AUTH_FIELD_KEY).toHaveLength(32);
  });

  it('uses a 32-byte base64 field key unchanged', () => {
    const raw = Buffer.alloc(32, 7);
    const c = loadConfig({ ...keys, AUTH_FIELD_KEY: raw.toString('base64'), DATABASE_URL: 'postgres://x' });
    expect(c.AUTH_FIELD_KEY.equals(raw)).toBe(true);
  });

  it('requires verified TLS to the database in staging and production', () => {
    expect(() =>
      loadConfig({ ...keys, APP_ENV: 'staging', DB_HOST: 'h', DB_NAME: 'n', DB_USER: 'u', DB_PASSWORD: 'p' }),
    ).toThrow(/DB_SSL_CA_FILE/);
  });

  it('requires some way to reach the database', () => {
    expect(() => loadConfig({ ...keys })).toThrow(/DATABASE_URL/);
  });

  it('refuses short keys and sandbox providers in production', () => {
    expect(() => loadConfig({ ...keys, AUTH_JWT_SECRET: 'short', DATABASE_URL: 'postgres://x' })).toThrow(/AUTH_JWT_SECRET/);
    expect(() =>
      loadConfig({ ...keys, APP_ENV: 'production', DATABASE_URL: 'postgres://x', DB_SSL_CA_FILE: '/ca.pem' }),
    ).toThrow(/sandbox/);
  });
});
