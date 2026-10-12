import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  // The local API server (npm run dev starts it too). Same-origin from the app's point of view.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
