import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import pg from 'pg';
import { SandboxCollections, SandboxMessaging, type Collections, type Messaging } from '@project/adapters';
import { CollectionsService } from '@project/finance';
import { IdentityService } from '@project/identity';
import { APP_CONFIG, type AppConfig } from './config.js';

export const PG_POOL = Symbol('PG_POOL');
export const MESSAGING = Symbol('MESSAGING');
export const COLLECTIONS = Symbol('COLLECTIONS');

export interface InfraOverrides {
  pool?: pg.Pool;
  messaging?: Messaging;
  collections?: Collections;
}

/**
 * Process-wide infrastructure: config, database pool, provider adapters, domain services.
 * Build with InfraModule.forRoot(config) so tests can supply their own pool and adapters.
 */
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  static forRoot(config: AppConfig, overrides: InfraOverrides = {}) {
    const pool = overrides.pool ?? new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });
    const messaging = overrides.messaging ?? new SandboxMessaging();
    const collections = overrides.collections ?? new SandboxCollections(config.COLLECTIONS_WEBHOOK_SECRET);
    return {
      module: InfraModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: PG_POOL, useValue: pool },
        { provide: MESSAGING, useValue: messaging },
        { provide: COLLECTIONS, useValue: collections },
        {
          provide: IdentityService,
          useValue: new IdentityService(pool, messaging, {
            issuer: config.AUTH_ISSUER,
            jwtSecret: config.AUTH_JWT_SECRET,
            otpPepper: config.AUTH_OTP_PEPPER,
            fieldKey: config.AUTH_FIELD_KEY,
          }),
        },
        { provide: CollectionsService, useValue: new CollectionsService(pool, collections) },
      ],
      exports: [APP_CONFIG, PG_POOL, MESSAGING, COLLECTIONS, IdentityService, CollectionsService],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
