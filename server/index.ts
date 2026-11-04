import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { API_VERSION, type ConnectionInput } from '../src/lib/redisTypes';
import { distStatus } from './buildInfo';
import { configFile, loadConnections, removeConnection, toInfo, upsertConnection, ValidationError } from './config';
import {
  browseKeys,
  closeAll,
  dropClient,
  friendlyError,
  getValue,
  NotFoundError,
  searchKeys,
  testConnection,
  TooLargeError,
  UnsupportedTypeError,
} from './redis';

const PORT = Number(process.env.PORT) || 8787;
const HOST = '127.0.0.1';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'warn' }, bodyLimit: 64 * 1024 });

// --- Local-only hardening -------------------------------------------------
// The server listens on loopback only, sends no CORS headers (so other sites
// cannot read responses), refuses unexpected Host headers (DNS rebinding) and
// requires a custom header on anything that changes state (forces a CORS
// preflight, which is never granted).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
app.addHook('onRequest', async (req, reply) => {
  const hostname = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  if (!LOCAL_HOSTS.has(hostname)) return reply.code(403).send({ error: 'Forbidden host' });
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-requested-with'] !== 'json-compare') {
    return reply.code(403).send({ error: 'Missing X-Requested-With header' });
  }
});

app.setErrorHandler((err, _req, reply) => {
  const e = err as Error & { statusCode?: number };
  if (e instanceof ValidationError) return reply.code(400).send({ error: e.message });
  if (e instanceof NotFoundError) return reply.code(404).send({ error: e.message });
  if (e instanceof UnsupportedTypeError) return reply.code(415).send({ error: e.message });
  if (e instanceof TooLargeError) return reply.code(413).send({ error: e.message });
  if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
  app.log.error(e);
  return reply.code(502).send({ error: friendlyError(e) });
});

async function requireConnection(id: string) {
  const conn = (await loadConnections()).find((c) => c.id === id);
  if (!conn) throw new NotFoundError('Unknown connection');
  return conn;
}

// --- API ------------------------------------------------------------------
app.get('/api/health', async () => ({ ok: true, readOnly: true, apiVersion: API_VERSION }));

app.get('/api/connections', async () => (await loadConnections()).map(toInfo));

app.post('/api/connections', async (req) => toInfo(await upsertConnection(req.body as ConnectionInput)));

app.put<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
  const body = { ...(req.body as ConnectionInput), id: req.params.id };
  await requireConnection(req.params.id);
  const stored = await upsertConnection(body);
  dropClient(stored.id); // pick up new host / credentials on next use
  return toInfo(stored);
});

app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req, reply) => {
  dropClient(req.params.id);
  if (!(await removeConnection(req.params.id))) return reply.code(404).send({ error: 'Unknown connection' });
  return { ok: true };
});

app.post<{ Params: { id: string } }>('/api/connections/:id/test', async (req) => testConnection(await requireConnection(req.params.id)));

/** Test a connection that has not been saved yet (the editor's "Test" button). */
app.post('/api/connections/test', async (req) => {
  const input = req.body as ConnectionInput;
  const existing = input.id ? (await loadConnections()).find((c) => c.id === input.id) : undefined;
  const conn = {
    id: `test-${Date.now()}`,
    name: input.name,
    env: input.env,
    host: input.host,
    port: input.port,
    tls: input.tls,
    db: input.db,
    auth: { type: 'password' as const, username: input.auth?.username || undefined, password: input.auth?.password || existing?.auth.password },
  };
  try {
    return await testConnection(conn);
  } finally {
    dropClient(conn.id);
  }
});

app.get<{ Params: { id: string }; Querystring: { q?: string; cursor?: string; literal?: string } }>('/api/connections/:id/keys', async (req) => {
  const conn = await requireConnection(req.params.id);
  return searchKeys(conn, req.query.q ?? '', req.query.cursor || '0', req.query.literal === '1');
});

app.get<{ Params: { id: string }; Querystring: { prefix?: string; partial?: string; cursor?: string; delimiter?: string } }>(
  '/api/connections/:id/browse',
  async (req) => {
    const conn = await requireConnection(req.params.id);
    const { prefix = '', partial = '', cursor = '0', delimiter = ':' } = req.query;
    if (!delimiter) throw new ValidationError('delimiter must not be empty');
    return browseKeys(conn, prefix, partial, cursor || '0', delimiter);
  },
);

app.get<{ Params: { id: string }; Querystring: { key?: string } }>('/api/connections/:id/value', async (req, reply) => {
  const key = req.query.key;
  if (!key) return reply.code(400).send({ error: 'Missing key' });
  const conn = await requireConnection(req.params.id);
  const { meta, body } = await getValue(conn, key);
  // The JSON travels as the raw body (no re-encoding); metadata goes in headers.
  return reply
    .header('x-redis-type', meta.type)
    .header('x-redis-ttl-ms', String(meta.ttlMs))
    .header('x-redis-bytes', String(meta.bytes))
    .header('cache-control', 'no-store')
    .type('text/plain; charset=utf-8')
    .send(body);
});

// --- Static app ------------------------------------------------------------
// The API server can also serve the built web app (npm start). It refuses to
// serve a build that no longer matches the sources: an old web app talking to
// this (newer) server is confusing – e.g. it still offers the old environment names.
const apiOnly = process.argv.includes('--api-only'); // used by `npm run dev`: Vite serves the app instead
const status = apiOnly ? 'missing' : distStatus(root);

const noticePage = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>JSON Compare</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;color:#1f2328}
code{background:#eef0f3;padding:2px 6px;border-radius:5px}h1{font-size:20px}</style>
<h1>${title}</h1>${body}`;

let appUrl = '';
if (status === 'ok') {
  await app.register(fastifyStatic, {
    root: dist,
    cacheControl: false,
    setHeaders: (res, path) => {
      // index.html must always be re-checked so a new build is picked up; hashed assets can be cached forever.
      res.header('cache-control', path.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
  appUrl = `http://${HOST}:${PORT}`;
} else {
  const stale = status === 'stale';
  const html = apiOnly
    ? noticePage(
        'This is the API server',
        '<p>The web app is served by Vite while you run <code>npm run dev</code>. Open the address that Vite printed in the terminal (usually <code>http://localhost:5173</code>).</p>',
      )
    : stale
      ? noticePage(
          'The built web app is out of date',
          '<p>The code changed since <code>dist/</code> was last built, so serving it would show an old version of the app.</p><p>Stop this server and run <code>npm start</code> (it rebuilds first), or <code>npm run build</code> and then start it again.</p>',
        )
      : noticePage(
          'The web app has not been built yet',
          '<p>Run <code>npm start</code> (it builds first), or use <code>npm run dev</code> for development.</p>',
        );
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.code(stale ? 503 : 200).type('text/html; charset=utf-8').send(html);
    return reply.code(404).send({ error: 'Not found' });
  });
  if (stale) console.warn('\n  !! dist/ is OUT OF DATE (the sources changed after the last build). The app is NOT being served.\n  !! Run `npm start` (rebuilds first) or `npm run build`.\n');
}

try {
  await app.listen({ host: HOST, port: PORT });
  console.log(`\n  JSON Compare API  http://${HOST}:${PORT}${appUrl ? '  (app + API)' : '  (API only)'}`);
  if (apiOnly) console.log('  Open the app at the address Vite prints (usually http://localhost:5173)');
  console.log(`  Connections file  ${configFile}\n  Redis access is read-only.\n`);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use (is another copy still running?). Stop it, or set PORT=<number>.`);
  else console.error(e);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    closeAll();
    void app.close().then(() => process.exit(0));
  });
}
