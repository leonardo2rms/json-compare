/**
 * Read-only Redis access. The only commands ever sent are PING, INFO(server),
 * SCAN, TYPE, PTTL, STRLEN, GET and JSON.GET – there is deliberately no code
 * path that can modify data.
 */
import { Redis } from 'ioredis';
import { resolveAuth } from './auth';
import type { StoredConnection } from './config';
import type { BrowseEntry, BrowseResult, KeyEntry, KeyMeta, KeySearchResult, TestResult } from '../src/lib/redisTypes';

const MAX_VALUE_BYTES = (Number(process.env.MAX_VALUE_MB) || 256) * 1024 * 1024;
const SCAN_COUNT = 500;
const SCAN_BUDGET_MS = 1500;
const SCAN_WANTED = 50;

export class NotFoundError extends Error {}
export class UnsupportedTypeError extends Error {}
export class TooLargeError extends Error {}

interface Entry {
  client: Redis;
  signature: string;
}
const clients = new Map<string, Entry>();

function signature(c: StoredConnection): string {
  return JSON.stringify([c.host, c.port, c.tls, c.db, c.auth]);
}

async function getClient(conn: StoredConnection): Promise<Redis> {
  const sig = signature(conn);
  const existing = clients.get(conn.id);
  if (existing && existing.signature === sig) return existing.client;
  if (existing) {
    existing.client.disconnect();
    clients.delete(conn.id);
  }
  const auth = await resolveAuth(conn);
  let everReady = false;
  let lastError: Error | undefined;
  const client = new Redis({
    host: conn.host,
    port: conn.port,
    db: conn.db,
    username: auth.username,
    password: auth.password,
    // Azure Cache for Redis needs SNI = hostname and validates its certificate.
    tls: conn.tls ? { servername: conn.host } : undefined,
    lazyConnect: true,
    connectTimeout: 10_000,
    maxRetriesPerRequest: 1,
    keepAlive: 30_000, // Azure drops idle connections after a few minutes
    // Fail fast on the very first connect (so the user sees the real error);
    // once connected, reconnect with backoff if the connection drops.
    retryStrategy: (times) => (everReady ? Math.min(times * 500, 5000) : null),
  });
  client.on('ready', () => (everReady = true));
  client.on('error', (e: Error) => {
    // Remember the cause (ioredis otherwise reports a generic "Connection is closed").
    lastError = e;
  });
  try {
    await client.connect();
  } catch (e) {
    client.disconnect();
    throw lastError && /closed/i.test((e as Error).message) ? lastError : e;
  }
  clients.set(conn.id, { client, signature: sig });
  return client;
}

export function dropClient(id: string): void {
  clients.get(id)?.client.disconnect();
  clients.delete(id);
}

export function closeAll(): void {
  for (const id of [...clients.keys()]) dropClient(id);
}

export async function testConnection(conn: StoredConnection): Promise<TestResult> {
  const t0 = Date.now();
  try {
    // Fresh client so edits to the config are really tested.
    dropClient(conn.id);
    const client = await getClient(conn);
    await client.ping();
    const info = await client.info('server');
    const version = /redis_version:(\S+)/.exec(info)?.[1];
    return { ok: true, message: 'Connected', serverVersion: version, latencyMs: Date.now() - t0 };
  } catch (e) {
    dropClient(conn.id);
    return { ok: false, message: friendlyError(e) };
  }
}

export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as NodeJS.ErrnoException)?.code;
  if (/WRONGPASS|invalid username-password/i.test(msg)) return 'Authentication failed (wrong username or password)';
  if (/NOAUTH/i.test(msg)) return 'The server requires a password';
  if (code === 'ENOTFOUND') return `Host not found: ${(e as { hostname?: string }).hostname ?? ''}`.trim();
  if (code === 'ECONNREFUSED') return 'Connection refused (is the host/port right? TLS on or off?)';
  if (code === 'ETIMEDOUT' || /timed? ?out/i.test(msg)) return 'Connection timed out (firewall / network, or TLS switched on for a non-TLS port?)';
  if (/certificate|SSL|TLS|wrong version number/i.test(msg)) return `TLS problem: ${msg}`;
  if (/Connection is closed/i.test(msg)) return 'Connection closed by the server';
  return msg;
}

/**
 * Plain text → `*text*`. Text containing glob characters is used as a pattern
 * unless `literal` is set (then the characters are matched as themselves).
 */
export function toMatchPattern(q: string, literal = false): string {
  const t = q.trim();
  if (!t) return '*';
  if (literal) return `*${escapeGlob(t)}*`;
  return /[*?[]/.test(t) ? t : `*${t}*`;
}

/**
 * Searches the keyspace with SCAN (never KEYS, which would block the server).
 * Stops after ~SCAN_WANTED hits or SCAN_BUDGET_MS and returns a cursor to continue.
 */
export async function searchKeys(conn: StoredConnection, q: string, cursor = '0', literal = false): Promise<KeySearchResult> {
  const client = await getClient(conn);
  const match = toMatchPattern(q, literal);
  const found = new Set<string>();
  const t0 = Date.now();
  let cur = cursor;
  do {
    const [next, batch] = (await client.scan(cur, 'MATCH', match, 'COUNT', SCAN_COUNT)) as [string, string[]];
    cur = next;
    for (const k of batch) found.add(k);
  } while (cur !== '0' && found.size < SCAN_WANTED && Date.now() - t0 < SCAN_BUDGET_MS);

  const keys = [...found].sort().slice(0, SCAN_WANTED * 20);
  const pipe = client.pipeline();
  for (const k of keys) {
    pipe.type(k);
    pipe.pttl(k);
  }
  const res = keys.length ? ((await pipe.exec()) ?? []) : [];
  const entries: KeyEntry[] = keys.map((key, i) => ({
    key,
    type: String(res[i * 2]?.[1] ?? 'unknown'),
    ttlMs: Number(res[i * 2 + 1]?.[1] ?? -1),
  }));
  return { keys: entries, cursor: cur, done: cur === '0' };
}

/**
 * Fetches a key's JSON text. Supports plain string values and RedisJSON
 * documents (type `ReJSON-RL`). Returns the raw text; the caller formats it.
 */
export async function getValue(conn: StoredConnection, key: string): Promise<{ meta: KeyMeta; body: string }> {
  const client = await getClient(conn);
  const type = await client.type(key);
  if (type === 'none') throw new NotFoundError(`Key not found: ${key}`);
  const ttlMs = await client.pttl(key);

  let buf: Buffer;
  if (type === 'string') {
    const len = await client.strlen(key);
    if (len > MAX_VALUE_BYTES) throw new TooLargeError(`Value is ${(len / 1048576).toFixed(0)} MB, above the ${MAX_VALUE_BYTES / 1048576} MB limit`);
    const v = await client.getBuffer(key);
    if (v === null) throw new NotFoundError(`Key not found: ${key}`);
    buf = v;
  } else if (type === 'ReJSON-RL') {
    const v = (await client.callBuffer('JSON.GET', key)) as Buffer | null;
    if (v === null) throw new NotFoundError(`Key not found: ${key}`);
    if (v.length > MAX_VALUE_BYTES) throw new TooLargeError('Value is too large');
    buf = v;
  } else {
    throw new UnsupportedTypeError(`Key "${key}" has type "${type}"; only string and RedisJSON values are supported`);
  }
  return { meta: { type, ttlMs, bytes: buf.length }, body: buf.toString('utf8') };
}

// ---------------------------------------------------------------------------
// Hierarchical browsing: `offer:123:details` -> offer: -> 123: -> details
// ---------------------------------------------------------------------------

const BROWSE_COUNT = 4000; // keys examined per SCAN call (bigger = fewer round trips to a remote server)
const BROWSE_BUDGET_MS = 2000;
const BROWSE_ENOUGH_GROUPS = 100; // stop after a batch once we have this many choices
const BROWSE_META_LIMIT = 100; // look up type/TTL for at most this many leaves

/** Escapes Redis glob characters so user text is matched literally. */
export function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, '\\$&');
}

export interface Group {
  segment: string;
  folder: boolean;
  leaf: boolean;
  count: number;
}

/**
 * Adds `keys` to `groups`, grouped by the segment that follows `prefix`
 * (up to the next delimiter). Pure function, so it is easy to test.
 */
export function groupKeys(keys: string[], prefix: string, delimiter: string, groups: Map<string, Group>): void {
  for (const key of keys) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const i = rest.indexOf(delimiter);
    const segment = i === -1 ? rest : rest.slice(0, i);
    let g = groups.get(segment);
    if (!g) {
      g = { segment, folder: false, leaf: false, count: 0 };
      groups.set(segment, g);
    }
    if (i === -1) g.leaf = true;
    else g.folder = true;
    g.count++;
  }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Lists the choices for the next level of the key tree below `prefix`
 * (which should end with the delimiter, or be empty for the top level).
 * `partial` narrows the choices to segments starting with that text.
 */
export async function browseKeys(
  conn: StoredConnection,
  prefix: string,
  partial: string,
  cursor = '0',
  delimiter = ':',
): Promise<BrowseResult> {
  const client = await getClient(conn);
  const pattern = `${escapeGlob(prefix + partial)}*`;
  const groups = new Map<string, Group>();
  const t0 = Date.now();
  let cur = cursor;
  do {
    const [next, batch] = (await client.scan(cur, 'MATCH', pattern, 'COUNT', BROWSE_COUNT)) as [string, string[]];
    cur = next;
    groupKeys(batch, prefix, delimiter, groups);
  } while (cur !== '0' && groups.size < BROWSE_ENOUGH_GROUPS && Date.now() - t0 < BROWSE_BUDGET_MS);

  const sorted = [...groups.values()].sort((a, b) => collator.compare(a.segment, b.segment));
  const entries: BrowseEntry[] = sorted.map((g) => ({
    segment: g.segment,
    path: g.folder && !g.leaf ? `${prefix}${g.segment}${delimiter}` : `${prefix}${g.segment}`,
    folder: g.folder,
    leaf: g.leaf,
    count: g.count,
  }));

  // Type / TTL for the first few leaves, so they can be told apart at a glance.
  const leaves = entries.filter((e) => e.leaf).slice(0, BROWSE_META_LIMIT);
  if (leaves.length) {
    const pipe = client.pipeline();
    for (const e of leaves) {
      pipe.type(prefix + e.segment);
      pipe.pttl(prefix + e.segment);
    }
    const res = (await pipe.exec()) ?? [];
    leaves.forEach((e, i) => {
      e.type = String(res[i * 2]?.[1] ?? 'unknown');
      e.ttlMs = Number(res[i * 2 + 1]?.[1] ?? -1);
    });
  }
  return { entries, cursor: cur, done: cur === '0' };
}
