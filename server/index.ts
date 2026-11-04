import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFile } from './config';
import { startServer } from './app';

// Command-line entry: `npm start` (app + API) and `npm run dev` (API only, with --api-only).
const PORT = Number(process.env.PORT) || 8787;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiOnly = process.argv.includes('--api-only');

try {
  const server = await startServer({ port: PORT, root, apiOnly });
  console.log(`\n  JSON Compare API  ${server.url}${server.servesApp ? '  (app + API)' : '  (API only)'}`);
  if (apiOnly) console.log('  Open the app at the address Vite prints (usually http://localhost:5173)');
  if (server.dist === 'stale') console.warn('\n  !! dist/ is OUT OF DATE (the sources changed after the last build). The app is NOT being served.\n  !! Run `npm start` (rebuilds first) or `npm run build`.\n');
  console.log(`  Connections file  ${configFile}\n  Redis access is read-only.\n`);

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => void server.close().then(() => process.exit(0)));
  }
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use (is another copy still running?). Stop it, or set PORT=<number>.`);
  else console.error(e);
  process.exit(1);
}
