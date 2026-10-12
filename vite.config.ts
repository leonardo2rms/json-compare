import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ['src/**/*.test.ts'] },
});
