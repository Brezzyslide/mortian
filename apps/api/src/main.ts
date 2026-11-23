import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pg from 'pg';
import { runMigrations } from '@project/db';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

export async function createApp(config = loadConfig(), overrides: Parameters<typeof AppModule.forRoot>[1] = {}) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config, overrides), {
    logger: config.APP_ENV === 'test' ? false : ['error', 'warn', 'log'],
    rawBody: true, // webhook signatures are verified over the exact bytes received
  });
  app.setGlobalPrefix('v1');
  app.set('trust proxy', 1); // behind the AWS load balancer: req.ip is the client, not the ALB
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: '100kb' });
  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.MIGRATE_ON_BOOT) {
    const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
    await runMigrations(pool);
    await pool.end();
  }
  const app = await createApp(config);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  void main();
}
