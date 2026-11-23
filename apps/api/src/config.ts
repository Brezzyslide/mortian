import { z } from 'zod';

const base64Key = (bytes: number, exact: boolean) =>
  z
    .string()
    .transform((s) => Buffer.from(s, 'base64'))
    .refine((b) => (exact ? b.length === bytes : b.length >= bytes), {
      message: `must be base64 of ${exact ? 'exactly' : 'at least'} ${bytes} bytes`,
    });

const schema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().default(3000),
    DATABASE_URL: z.string().min(1),
    MIGRATE_ON_BOOT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    AUTH_ISSUER: z.string().default('PROJECT_NAME'),
    AUTH_JWT_SECRET: base64Key(32, false),
    AUTH_OTP_PEPPER: base64Key(32, false),
    AUTH_FIELD_KEY: base64Key(32, true),
    MESSAGING_PROVIDER: z.enum(['sandbox']).default('sandbox'),
    COLLECTIONS_PROVIDER: z.enum(['sandbox']).default('sandbox'),
    COLLECTIONS_WEBHOOK_SECRET: z.string().min(16),
  })
  .superRefine((c, ctx) => {
    if (c.APP_ENV === 'production' && c.COLLECTIONS_PROVIDER === 'sandbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['COLLECTIONS_PROVIDER'],
        message: 'sandbox collections is not allowed in production: no real money would be collected',
      });
    }
    if (c.APP_ENV === 'production' && c.MESSAGING_PROVIDER === 'sandbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['MESSAGING_PROVIDER'],
        message: 'sandbox messaging is not allowed in production: OTPs would never reach users',
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

/** Fails fast at startup with every missing or malformed variable listed. Values are never logged. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return parsed.data;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
