import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC emits decorator metadata, which esbuild (vitest's default) does not; Nest relies on it.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 60_000 },
});
