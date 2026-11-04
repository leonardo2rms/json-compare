import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { API_VERSION, type ConnectionInput } from '../src/lib/redisTypes';
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

// --- Static app (production) ----------------------------------------------
if (existsSync(join(dist, 'index.html'))) {
  await app.register(fastifyStatic, { root: dist });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
} else {
  app.log.warn('dist/ not found – run `npm run build` to serve the app from this server (the Vite dev server works without it)');
}

try {
  await app.listen({ host: HOST, port: PORT });
  console.log(`\n  JSON Compare API  http://${HOST}:${PORT}${existsSync(join(dist, 'index.html')) ? '  (app + API)' : '  (API only – run Vite for the UI)'}`);
  console.log(`  Connections file  ${configFile}\n  Redis access is read-only.\n`);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Set PORT=<number> to use another one.`);
  else console.error(e);
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    closeAll();
    void app.close().then(() => process.exit(0));
  });
}
