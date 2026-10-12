import type { StoredConnection } from './config';

export interface ResolvedAuth {
  username?: string;
  password?: string;
}

/**
 * Single place that turns a stored connection into credentials for ioredis.
 * Today: username/password straight from the config file. To add Microsoft
 * Entra ID or Azure Key Vault later, add a new `auth.type`, branch on it here
 * (this may be async, so it can fetch / refresh a token) and extend
 * `ConnectionInput` in src/lib/redisTypes.ts.
 */
export async function resolveAuth(conn: StoredConnection): Promise<ResolvedAuth> {
  switch (conn.auth.type) {
    case 'password':
      return { username: conn.auth.username, password: conn.auth.password };
    default:
      throw new Error(`Unsupported auth type: ${(conn.auth as { type: string }).type}`);
  }
}
