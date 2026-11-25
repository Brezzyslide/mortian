import { join } from 'node:path';
import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createHash } from 'node:crypto';
import pg from 'pg';
import {
  FolderDocumentStore,
  MemoryDocumentStore,
  S3DocumentStore,
  SandboxCheckout,
  SandboxCollections,
  SandboxPayouts,
  SandboxRoutes,
  SandboxMessaging,
  type Checkout,
  type Collections,
  type DocumentStore,
  type Messaging,
  type Payouts,
  type Routes,
} from '@project/adapters';
import { ContractsService } from '@project/contracts';
import { DispatchService, PayoutService } from '@project/dispatch';
import { ArrearsService, AssetService, CollectionsService, CustomerDocumentService, LendingService } from '@project/finance';
import { IdentityService, StaffAdminService } from '@project/identity';
import { APP_CONFIG, type AppConfig } from './config.js';
import { createPool } from './db.js';

export const PG_POOL = Symbol('PG_POOL');
export const MESSAGING = Symbol('MESSAGING');
export const COLLECTIONS = Symbol('COLLECTIONS');
export const CHECKOUT = Symbol('CHECKOUT');
export const PAYOUTS = Symbol('PAYOUTS');

export interface InfraOverrides {
  pool?: pg.Pool;
  messaging?: Messaging;
  collections?: Collections;
  documents?: DocumentStore;
  kycDocuments?: DocumentStore;
  checkout?: Checkout;
  routes?: Routes;
  payouts?: Payouts;
}

export const DOCUMENTS = Symbol('DOCUMENTS');
export const KYC_DOCUMENTS = Symbol('KYC_DOCUMENTS');

/**
 * Process-wide infrastructure: config, database pool, provider adapters, domain services.
 * Build with InfraModule.forRoot(config) so tests can supply their own pool and adapters.
 */
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  static forRoot(config: AppConfig, overrides: InfraOverrides = {}) {
    const pool = overrides.pool ?? createPool(config);
    const messaging = overrides.messaging ?? new SandboxMessaging();
    const collections = overrides.collections ?? new SandboxCollections(config.COLLECTIONS_WEBHOOK_SECRET);
    // Paystack signs every webhook with the one secret key, so checkout shares the collections secret.
    const checkout = overrides.checkout ?? new SandboxCheckout(config.COLLECTIONS_WEBHOOK_SECRET);
    // Paystack again signs transfer webhooks with the same secret key.
    const payouts = overrides.payouts ?? new SandboxPayouts(config.COLLECTIONS_WEBHOOK_SECRET);
    const dispatch = new DispatchService(pool, overrides.routes ?? new SandboxRoutes(), checkout, messaging, {
      // A key of its own, derived so no new secret is needed: delivery codes never reuse the OTP pepper directly.
      codePepper: createHash('sha256').update('dispatch-codes:').update(config.AUTH_OTP_PEPPER).digest(),
    });
    const lending = new LendingService(pool, undefined, {
      requireSignedContract: config.REQUIRE_SIGNED_CONTRACT,
      requireAsset: config.REQUIRE_ASSET_AT_HANDOVER,
    });
    const localStore = (sub: string) =>
      config.LOCAL_DOCUMENTS_DIR ? new FolderDocumentStore(join(config.LOCAL_DOCUMENTS_DIR, sub)) : new MemoryDocumentStore();
    const documents =
      overrides.documents ?? (config.CONTRACTS_BUCKET ? new S3DocumentStore(config.CONTRACTS_BUCKET) : localStore('contracts'));
    const kycDocuments =
      overrides.kycDocuments ?? (config.KYC_BUCKET ? new S3DocumentStore(config.KYC_BUCKET) : localStore('kyc'));
    const contracts = new ContractsService(pool, messaging, documents, {
      otpPepper: config.AUTH_OTP_PEPPER,
      signingBaseUrl: config.SIGNING_BASE_URL ?? null,
    });
    return {
      module: InfraModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: PG_POOL, useValue: pool },
        { provide: MESSAGING, useValue: messaging },
        { provide: COLLECTIONS, useValue: collections },
        { provide: CHECKOUT, useValue: checkout },
        { provide: DispatchService, useValue: dispatch },
        { provide: PAYOUTS, useValue: payouts },
        { provide: PayoutService, useValue: new PayoutService(pool, payouts, messaging) },
        {
          provide: IdentityService,
          useValue: new IdentityService(pool, messaging, {
            issuer: config.AUTH_ISSUER,
            jwtSecret: config.AUTH_JWT_SECRET,
            otpPepper: config.AUTH_OTP_PEPPER,
            fieldKey: config.AUTH_FIELD_KEY,
          }),
        },
        { provide: StaffAdminService, useValue: new StaffAdminService(pool) },
        { provide: CollectionsService, useValue: new CollectionsService(pool, collections) },
        { provide: LendingService, useValue: lending },
        { provide: DOCUMENTS, useValue: documents },
        { provide: KYC_DOCUMENTS, useValue: kycDocuments },
        { provide: CustomerDocumentService, useValue: new CustomerDocumentService(pool, kycDocuments) },
        { provide: ContractsService, useValue: contracts },
        { provide: ArrearsService, useValue: new ArrearsService(pool, lending, messaging) },
        { provide: AssetService, useValue: new AssetService(pool) },
      ],
      exports: [APP_CONFIG, PG_POOL, MESSAGING, COLLECTIONS, IdentityService, StaffAdminService, CollectionsService, LendingService, ArrearsService, AssetService, ContractsService, CustomerDocumentService, DispatchService, PayoutService, CHECKOUT, PAYOUTS, DOCUMENTS, KYC_DOCUMENTS],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
