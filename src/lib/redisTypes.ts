/** Types shared by the local API server (server/) and the web app. */

export const ENVS = ['local', 'tst', 'acc', 'prd'] as const;
export type Env = (typeof ENVS)[number];

/** Names used by earlier versions, still found in saved connection files. */
const LEGACY_ENVS: Record<string, Env> = { dev: 'tst', test: 'tst', staging: 'acc', stg: 'acc', prod: 'prd' };

/** Maps any stored environment name (including legacy ones) to a current one. */
export function normalizeEnv(value: unknown): Env {
  const v = String(value ?? '').toLowerCase();
  if ((ENVS as readonly string[]).includes(v)) return v as Env;
  return LEGACY_ENVS[v] ?? 'tst';
}

/**
 * How we authenticate. Only plain username/password for now; the server resolves
 * credentials through `resolveAuth()` so other providers (Entra ID, Key Vault, …)
 * can be added as new `type`s without touching the rest of the app.
 */
export interface PasswordAuthInput {
  type: 'password';
  username?: string;
  /** Omit on update to keep the stored password. */
  password?: string;
}

export interface ConnectionInput {
  id?: string;
  name: string;
  env: Env;
  host: string;
  port: number;
  tls: boolean;
  db: number;
  auth: PasswordAuthInput;
}

/** What the server sends to the browser: never includes secrets. */
export interface ConnectionInfo {
  id: string;
  name: string;
  env: Env;
  host: string;
  port: number;
  tls: boolean;
  db: number;
  auth: { type: 'password'; username?: string; hasPassword: boolean };
}

export interface KeyEntry {
  key: string;
  type: string;
  /** Milliseconds until expiry, or -1 for no expiry. */
  ttlMs: number;
}

export interface KeySearchResult {
  keys: KeyEntry[];
  /** Pass back to continue the search. */
  cursor: string;
  /** True when the whole keyspace has been scanned. */
  done: boolean;
}

/** One next-level choice when drilling down through keys like `offer:123:details`. */
export interface BrowseEntry {
  /** The segment itself, e.g. `offer` (no separator). */
  segment: string;
  /** Full text to put in the box: `offer:` for a folder, `offer` for a key. */
  path: string;
  /** Keys exist below this segment (…`offer:123`). */
  folder: boolean;
  /** A key exists that ends exactly here. */
  leaf: boolean;
  /** Keys seen so far under this segment (partial while the scan is incomplete). */
  count: number;
  /** Only for leaves (looked up for the first few). */
  type?: string;
  ttlMs?: number;
}

export interface BrowseResult {
  entries: BrowseEntry[];
  /** Pass back to keep scanning. */
  cursor: string;
  /** True when the whole keyspace has been scanned. */
  done: boolean;
}

export interface KeyMeta {
  type: string;
  ttlMs: number;
  bytes: number;
}

export interface TestResult {
  ok: boolean;
  message: string;
  serverVersion?: string;
  latencyMs?: number;
}

/** Reference to where a pane's content came from, so it can be refreshed. */
export interface SourceInfo {
  connId: string;
  key: string;
  fetchedAt: number;
  meta: KeyMeta;
}

/** Where a library copy was originally fetched from, so a saved snapshot still says so. */
export interface SavedFrom {
  connId: string;
  connName: string;
  env: Env;
  key: string;
  fetchedAt: number;
}
