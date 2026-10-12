import type {
  BrowseResult,
  ConnectionInfo,
  ConnectionInput,
  KeyMeta,
  KeySearchResult,
  TestResult,
} from './redisTypes';

// Same-origin: the local API server serves the app in production and Vite proxies /api in dev.
const MUTATION_HEADERS = { 'content-type': 'application/json', 'x-requested-with': 'json-compare' };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) msg = body.error;
  } catch {
    /* not JSON */
  }
  return new ApiError(msg, res.status);
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

/** True when the local API server is reachable (otherwise the app runs as a plain static page). */
export async function isApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

export const redisApi = {
  listConnections: () => fetch('/api/connections').then(json<ConnectionInfo[]>),

  saveConnection: (input: ConnectionInput) =>
    fetch(input.id ? `/api/connections/${input.id}` : '/api/connections', {
      method: input.id ? 'PUT' : 'POST',
      headers: MUTATION_HEADERS,
      body: JSON.stringify(input),
    }).then(json<ConnectionInfo>),

  deleteConnection: (id: string) =>
    fetch(`/api/connections/${id}`, { method: 'DELETE', headers: MUTATION_HEADERS }).then(json<{ ok: true }>),

  /** Tests the values in the form without saving them. */
  testConnection: (input: ConnectionInput) =>
    fetch('/api/connections/test', { method: 'POST', headers: MUTATION_HEADERS, body: JSON.stringify(input) }).then(json<TestResult>),

  /** Flat key search. `literal` matches * ? [ as themselves instead of as a pattern. */
  searchKeys: (connId: string, q: string, cursor = '0', signal?: AbortSignal, literal = false) =>
    fetch(`/api/connections/${connId}/keys?${new URLSearchParams({ q, cursor, ...(literal ? { literal: '1' } : {}) })}`, { signal }).then(json<KeySearchResult>),

  /** Next level of the key tree below `prefix` (see BrowseResult). */
  browse: (connId: string, prefix: string, partial: string, cursor = '0', signal?: AbortSignal) =>
    fetch(`/api/connections/${connId}/browse?${new URLSearchParams({ prefix, partial, cursor })}`, { signal }).then(json<BrowseResult>),

  /** Fetches the raw JSON text of a key plus its metadata. */
  async fetchValue(connId: string, key: string): Promise<{ text: string; meta: KeyMeta }> {
    const res = await fetch(`/api/connections/${connId}/value?${new URLSearchParams({ key })}`);
    if (!res.ok) throw await readError(res);
    return {
      text: await res.text(),
      meta: {
        type: res.headers.get('x-redis-type') ?? 'string',
        ttlMs: Number(res.headers.get('x-redis-ttl-ms') ?? -1),
        bytes: Number(res.headers.get('x-redis-bytes') ?? 0),
      },
    };
  },
};

export function formatTtl(ms: number): string {
  if (ms < 0) return 'no expiry';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 129600) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const ENV_LABEL: Record<string, string> = { local: 'local', dev: 'dev', staging: 'staging', prod: 'PROD' };
