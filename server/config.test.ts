import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ConnectionInput } from '../src/lib/redisTypes';

let cfg: typeof import('./config');
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jc-test-'));
  process.env.JSON_COMPARE_HOME = dir; // read when the module loads
  cfg = await import('./config');
});

const input = (over: Partial<ConnectionInput> = {}): ConnectionInput => ({
  name: 'Prod',
  env: 'prd',
  host: 'x.redis.cache.windows.net',
  port: 6380,
  tls: true,
  db: 0,
  auth: { type: 'password', password: 'hunter2' },
  ...over,
});

describe('connection config', () => {
  it('stores connections owner-only and never exposes the password', async () => {
    const c = await cfg.upsertConnection(input());
    expect(statSync(cfg.configFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(cfg.configFile, 'utf8')).toContain('hunter2'); // stored on disk…
    const info = cfg.toInfo(c);
    expect(JSON.stringify(info)).not.toContain('hunter2'); // …but never sent to the browser
    expect(info.auth.hasPassword).toBe(true);
  });

  it('keeps the stored password when an update leaves it empty', async () => {
    const [orig] = await cfg.loadConnections();
    const updated = await cfg.upsertConnection(input({ id: orig.id, name: 'Prod renamed', auth: { type: 'password' } }));
    expect(updated.name).toBe('Prod renamed');
    expect(updated.auth.password).toBe('hunter2');
    expect((await cfg.loadConnections()).length).toBe(1);
  });

  it('replaces the password when a new one is given', async () => {
    const [orig] = await cfg.loadConnections();
    const updated = await cfg.upsertConnection(input({ id: orig.id, auth: { type: 'password', password: 'new' } }));
    expect(updated.auth.password).toBe('new');
  });

  it('validates input', async () => {
    await expect(cfg.upsertConnection(input({ name: ' ' }))).rejects.toThrow(cfg.ValidationError);
    await expect(cfg.upsertConnection(input({ port: 70000 }))).rejects.toThrow(/Port/);
    await expect(cfg.upsertConnection(input({ host: '' }))).rejects.toThrow(/Host/);
    await expect(cfg.upsertConnection(input({ env: 'nope' as never }))).rejects.toThrow(/Environment/);
  });

  it('translates environment names from older versions when loading', async () => {
    writeFileSync(
      cfg.configFile,
      JSON.stringify({
        connections: ['dev', 'staging', 'prod', 'local', 'weird'].map((env, i) => ({
          id: `id${i}`, name: env, env, host: 'h', port: 1, tls: false, db: 0, auth: { type: 'password' },
        })),
      }),
    );
    const envs = (await cfg.loadConnections()).map((c) => c.env);
    expect(envs).toEqual(['tst', 'acc', 'prd', 'local', 'tst']);
    // restore a single connection for the following test
    writeFileSync(cfg.configFile, JSON.stringify({ connections: [] }));
    await cfg.upsertConnection(input({ name: 'Again' }));
  });

  it('removes connections', async () => {
    const [c] = await cfg.loadConnections();
    expect(await cfg.removeConnection(c.id)).toBe(true);
    expect(await cfg.removeConnection(c.id)).toBe(false);
    expect(await cfg.loadConnections()).toEqual([]);
  });
});
