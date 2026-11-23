import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import type pg from 'pg';
import type { Messaging } from '@project/adapters';
import { AdminController } from './admin/admin.controller.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import type { AppConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { AuthErrorFilter } from './http.js';
import { InfraModule } from './infra.module.js';

/**
 * Root module. Further domain modules (finance, contracts, dispatch, payments, notifications)
 * are added here, each exposing only its public service to the others.
 */
@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: { pool?: pg.Pool; messaging?: Messaging } = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [InfraModule.forRoot(config, overrides)],
      controllers: [HealthController, AuthController, AdminController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: AuthErrorFilter },
      ],
    };
  }
}
