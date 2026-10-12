import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ENVS, type ConnectionInfo, type ConnectionInput, type Env } from '../src/lib/redisTypes';

/** Connection as stored on disk (includes the secret). */
export interface StoredConnection {
  id: string;
  name: string;
  env: Env;
  host: string;
  port: number;
  tls: boolean;
  db: number;
  auth: { type: 'password'; username?: string; password?: string };
}

const dir = process.env.JSON_COMPARE_HOME ?? join(homedir(), '.json-compare');
export const configFile = join(dir, 'connections.json');

export async function loadConnections(): Promise<StoredConnection[]> {
  try {
    const raw = JSON.parse(await readFile(configFile, 'utf8')) as { connections?: StoredConnection[] };
    return raw.connections ?? [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Could not read ${configFile}: ${(e as Error).message}`);
  }
}

async function writeConnections(connections: StoredConnection[]): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
  const tmp = `${configFile}.${process.pid}.tmp`;
  // Contains passwords: owner-only permissions.
  await writeFile(tmp, JSON.stringify({ connections }, null, 2), { mode: 0o600 });
  await rename(tmp, configFile);
  await chmod(configFile, 0o600).catch(() => {});
}

export function toInfo(c: StoredConnection): ConnectionInfo {
  return {
    id: c.id,
    name: c.name,
    env: c.env,
    host: c.host,
    port: c.port,
    tls: c.tls,
    db: c.db,
    auth: { type: 'password', username: c.auth.username, hasPassword: !!c.auth.password },
  };
}

export class ValidationError extends Error {}

function validate(input: ConnectionInput): void {
  if (!input || typeof input !== 'object') throw new ValidationError('Invalid body');
  if (!input.name?.trim()) throw new ValidationError('Name is required');
  if (!input.host?.trim()) throw new ValidationError('Host is required');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new ValidationError('Port must be 1–65535');
  if (!Number.isInteger(input.db) || input.db < 0 || input.db > 1023) throw new ValidationError('Database must be a non-negative integer');
  if (!ENVS.includes(input.env)) throw new ValidationError(`Environment must be one of ${ENVS.join(', ')}`);
  if (input.auth?.type !== 'password') throw new ValidationError('Unsupported auth type');
}

/** Creates or updates a connection. A missing password on update keeps the stored one. */
export async function upsertConnection(input: ConnectionInput): Promise<StoredConnection> {
  validate(input);
  const all = await loadConnections();
  const existing = input.id ? all.find((c) => c.id === input.id) : undefined;
  const stored: StoredConnection = {
    id: existing?.id ?? randomUUID(),
    name: input.name.trim(),
    env: input.env,
    host: input.host.trim(),
    port: input.port,
    tls: !!input.tls,
    db: input.db,
    auth: {
      type: 'password',
      username: input.auth.username?.trim() || undefined,
      password: input.auth.password !== undefined && input.auth.password !== '' ? input.auth.password : existing?.auth.password,
    },
  };
  await writeConnections(existing ? all.map((c) => (c.id === stored.id ? stored : c)) : [...all, stored]);
  return stored;
}

export async function removeConnection(id: string): Promise<boolean> {
  const all = await loadConnections();
  const next = all.filter((c) => c.id !== id);
  if (next.length === all.length) return false;
  await writeConnections(next);
  return true;
}
