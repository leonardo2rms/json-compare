import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUILD_INFO_FILE, hashSources } from './server/buildInfo';

/** Stamps dist/ with a fingerprint of the sources, so the server can tell when the build is out of date. */
function buildInfo(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  return {
    name: 'build-info',
    apply: 'build',
    configResolved(c) {
      root = c.root;
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      writeFileSync(resolve(outDir, BUILD_INFO_FILE), JSON.stringify({ sourceHash: hashSources(root), builtAt: new Date().toISOString() }));
    },
  };
}

export default defineConfig({
  plugins: [react(), buildInfo()],
  worker: { format: 'es' },
  // The local API server (npm run dev starts it too). Same-origin from the app's point of view.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  preview: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  build: { chunkSizeWarningLimit: 4000 },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
