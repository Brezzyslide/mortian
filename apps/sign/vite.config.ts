import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /sign/ on the same address as the API. Small bundle: signers are on low-cost phones.
export default defineConfig({
  base: '/sign/',
  plugins: [react()],
  build: { target: 'es2019', sourcemap: true },
  server: { proxy: { '/v1': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], setupFiles: ['src/test-setup.ts'], testTimeout: 30_000 },
});
