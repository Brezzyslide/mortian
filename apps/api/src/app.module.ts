import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AdminController } from './admin/admin.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { BigIntInterceptor } from './bigint.interceptor.js';
import type { AppConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { AuthErrorFilter } from './http.js';
import { InfraModule, type InfraOverrides } from './infra.module.js';
import { ArrearsAdminController } from './lending/arrears-admin.controller.js';
import { LendingAdminController } from './lending/lending-admin.controller.js';
import { MeAccountsController } from './lending/me-accounts.controller.js';
import { PaymentsAdminController } from './payments/payments-admin.controller.js';
import { WebhooksController } from './payments/webhooks.controller.js';

/**
 * Root module. Further domain modules (finance, contracts, dispatch, payments, notifications)
 * are added here, each exposing only its public service to the others.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: InfraOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config, overrides)],
      controllers: [
        HealthController,
        AuthController,
        AdminController,
        WebhooksController,
        PaymentsAdminController,
        LendingAdminController,
        ArrearsAdminController,
        MeAccountsController,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AuthErrorFilter },
        { provide: APP_INTERCEPTOR, useClass: BigIntInterceptor },
      ],
    };
  }
}
