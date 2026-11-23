import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Customer app, served under /app/ on the same address as the API. Kept small for low-cost phones.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: { target: 'es2019', sourcemap: true },
  server: { proxy: { '/v1': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'], setupFiles: ['src/test-setup.ts'] },
});
