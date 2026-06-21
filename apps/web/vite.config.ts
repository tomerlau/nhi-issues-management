import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The dev proxy forwards `/api` calls to the backend so the browser only ever
// talks to the Vite origin. This avoids enabling CORS on the backend locally.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
