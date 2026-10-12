/** Types shared by the local API server (server/) and the web app. */

export const ENVS = ['local', 'dev', 'staging', 'prod'] as const;
export type Env = (typeof ENVS)[number];

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
