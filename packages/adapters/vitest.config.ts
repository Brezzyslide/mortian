import { defineConfig } from 'vitest/config';

// Database round-trips and password hashing are slow on shared CI machines; the 5 s default is
// for pure unit tests and made CI fail on timing, not on correctness.
export default defineConfig({ test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 } });
