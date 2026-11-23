import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';

/**
 * Root module. Domain modules (identity, finance, ledger, contracts, dispatch,
 * payments, notifications, audit) are added here in Phase 1, each exposing only
 * its public service to the others.
 */
@Module({
  controllers: [HealthController],
})
export class AppModule {}
