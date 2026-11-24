import { defineConfig } from 'vitest/config';

// Database round-trips are slow on shared CI machines; the 5 s default is for pure unit tests.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } });
