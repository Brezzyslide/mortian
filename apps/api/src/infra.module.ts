import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { SandboxMessaging, type Messaging } from '@project/adapters';
import { IdentityService } from '@project/identity';
import { APP_CONFIG, type AppConfig } from './config.js';

export const PG_POOL = Symbol('PG_POOL');
export const MESSAGING = Symbol('MESSAGING');

/**
 * Process-wide infrastructure: config, database pool, provider adapters, identity service.
 * Build with InfraModule.forRoot(config) so tests can supply their own pool and config.
 */
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  static forRoot(config: AppConfig, overrides: { pool?: pg.Pool; messaging?: Messaging } = {}) {
    const pool = overrides.pool ?? new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
    const messaging = overrides.messaging ?? new SandboxMessaging();
    return {
      module: InfraModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: PG_POOL, useValue: pool },
        { provide: MESSAGING, useValue: messaging },
        {
          provide: IdentityService,
          useValue: new IdentityService(pool, messaging, {
            issuer: config.AUTH_ISSUER,
            jwtSecret: config.AUTH_JWT_SECRET,
            otpPepper: config.AUTH_OTP_PEPPER,
            fieldKey: config.AUTH_FIELD_KEY,
          }),
        },
      ],
      exports: [APP_CONFIG, PG_POOL, MESSAGING, IdentityService],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
