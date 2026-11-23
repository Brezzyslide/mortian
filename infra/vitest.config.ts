import { defineConfig } from 'vitest/config';

// cdk.out holds a staged copy of the repo for the container image; never run tests from it.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 120_000 } });
