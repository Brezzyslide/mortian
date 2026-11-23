import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served under /console/ on the same CloudFront address as the API, so calls to /v1 are same-origin.
export default defineConfig({
  base: '/console/',
  plugins: [react()],
  build: { target: 'es2020', sourcemap: true },
  server: { proxy: { '/v1': 'http://localhost:3000' } },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
  },
});
