import { useEffect, useState } from 'react';
import { redisApi } from '../lib/redisApi';
import { ENVS, type ConnectionInfo, type ConnectionInput, type TestResult } from '../lib/redisTypes';

interface Props {
  connections: ConnectionInfo[];
  onChanged: () => void;
  onClose: () => void;
}

interface FormState {
  id?: string;
  name: string;
  env: ConnectionInput['env'];
  host: string;
  port: string;
  tls: boolean;
  db: string;
  username: string;
  password: string;
  hasPassword: boolean;
}

const blank = (): FormState => ({
  name: '',
  env: 'tst',
  host: '',
  port: '6380',
  tls: true,
  db: '0',
  username: '',
  password: '',
  hasPassword: false,
});

const fromInfo = (c: ConnectionInfo): FormState => ({
  id: c.id,
  name: c.name,
  env: c.env,
  host: c.host,
  port: String(c.port),
  tls: c.tls,
  db: String(c.db),
  username: c.auth.username ?? '',
  password: '',
  hasPassword: c.auth.hasPassword,
});

const toInput = (f: FormState): ConnectionInput => ({
  id: f.id,
  name: f.name,
  env: f.env,
  host: f.host,
  port: Number(f.port),
  tls: f.tls,
  db: Number(f.db),
  auth: { type: 'password', username: f.username || undefined, password: f.password || undefined },
});

export function Connections({ connections, onChanged, onClose }: Props) {
  const [form, setForm] = useState<FormState | null>(connections.length === 0 ? blank() : null);
  const [test, setTest] = useState<TestResult | 'running' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => (f ? { ...f, [k]: v } : f));
    setTest(null);
  };

  const runTest = async () => {
    if (!form) return;
    setTest('running');
    try {
      setTest(await redisApi.testConnection(toInput(form)));
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    setError(null);
    try {
      await redisApi.saveConnection(toInput(form));
      onChanged();
      setForm(null);
      setTest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: ConnectionInfo) => {
    if (!confirm(`Remove the connection “${c.name}”? (Nothing is deleted in Redis.)`)) return;
    try {
      await redisApi.deleteConnection(c.id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Redis connections">
        <div className="modal-head">
          <h2>Redis connections</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {!form && (
          <>
            {connections.length === 0 ? (
              <p className="muted">No connections yet.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Host</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {connections.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <span className={`env-chip env-${c.env}`}>{c.env}</span> <span className="doc-name">{c.name}</span>
                      </td>
                      <td className="muted">
                        {c.host}:{c.port}
                        {c.tls ? ' · TLS' : ''}
                      </td>
                      <td className="actions">
                        <button onClick={() => setForm(fromInfo(c))}>Edit</button>
                        <button className="danger" onClick={() => void remove(c)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button className="primary" onClick={() => setForm(blank())}>
                + Add connection
              </button>
            </div>
            <p className="muted small">Access is read-only: the app can only list and read keys. Settings (including passwords) are stored on this computer by the local server.</p>
          </>
        )}

        {form && (
          <form
            className="conn-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Name
              <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Prod cache" autoFocus required />
            </label>
            <label>
              Environment
              <select value={form.env} onChange={(e) => set('env', e.target.value as FormState['env'])}>
                {ENVS.map((env) => (
                  <option key={env} value={env}>
                    {env}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Host
              <input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="myname.redis.cache.windows.net" required spellCheck={false} />
            </label>
            <label>
              Port
              <input value={form.port} onChange={(e) => set('port', e.target.value)} inputMode="numeric" required />
            </label>
            <label>
              Database
              <input value={form.db} onChange={(e) => set('db', e.target.value)} inputMode="numeric" required />
            </label>
            <label className="check wide">
              <input
                type="checkbox"
                checked={form.tls}
                onChange={(e) => {
                  const tls = e.target.checked;
                  setForm((f) => (f ? { ...f, tls, port: f.port === (tls ? '6379' : '6380') ? (tls ? '6380' : '6379') : f.port } : f));
                  setTest(null);
                }}
              />
              Use TLS (Azure Cache for Redis: on, port 6380)
            </label>
            <label>
              Username <span className="muted">(optional)</span>
              <input value={form.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" spellCheck={false} />
            </label>
            <label>
              Password / access key
              <input
                type="password"
                value={form.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder={form.hasPassword ? '•••••••• (unchanged)' : ''}
                autoComplete="new-password"
              />
            </label>

            {test && (
              <p className={`wide test-result ${test === 'running' ? 'busy' : test.ok ? 'ok' : 'err'}`}>
                {test === 'running'
                  ? 'Testing…'
                  : test.ok
                    ? `✓ Connected${test.serverVersion ? ` · Redis ${test.serverVersion}` : ''} · ${test.latencyMs} ms`
                    : `✗ ${test.message}`}
              </p>
            )}
            {error && <p className="wide form-error">{error}</p>}

            <div className="wide form-actions">
              <button type="button" onClick={() => void runTest()} disabled={test === 'running'}>
                Test
              </button>
              <div className="spacer" />
              <button type="button" onClick={() => (setForm(null), setTest(null), setError(null))}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={saving}>
                Save
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
