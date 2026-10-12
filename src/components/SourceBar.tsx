import { useCallback, useEffect, useRef, useState } from 'react';
import { ENV_LABEL, formatTtl, redisApi } from '../lib/redisApi';
import { formatBytes, formatClock } from '../lib/format';
import type { ConnectionInfo, KeyEntry, SourceInfo } from '../lib/redisTypes';

interface Props {
  connections: ConnectionInfo[];
  /** Where this pane's content came from (null = not from Redis). */
  source: SourceInfo | null;
  /** Connection to preselect when the pane has no source yet. */
  defaultConnId?: string;
  busy: boolean;
  onLoad: (connId: string, key: string) => void;
  onRefresh: () => void;
  /** Load the same key from another connection into the *other* pane. */
  onCompareWith: (connId: string) => void;
  onManage: () => void;
  onConnChange: (connId: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

export function SourceBar(p: Props) {
  const [connId, setConnId] = useState(p.source?.connId ?? p.defaultConnId ?? p.connections[0]?.id ?? '');
  const [query, setQuery] = useState(p.source?.key ?? '');
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<KeyEntry[]>([]);
  const [cursor, setCursor] = useState('0');
  const [done, setDone] = useState(true);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hi, setHi] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number>(0);
  const seq = useRef(0);

  // Follow the pane when its source is changed from elsewhere (restore, "compare with…", refresh).
  const srcKey = p.source ? `${p.source.connId}\u0000${p.source.key}` : '';
  useEffect(() => {
    if (p.source) {
      setConnId(p.source.connId);
      setQuery(p.source.key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  // Keep the selection valid if connections are edited / removed.
  useEffect(() => {
    if (!p.connections.some((c) => c.id === connId)) setConnId(p.source?.connId ?? p.defaultConnId ?? p.connections[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.connections]);

  const conn = p.connections.find((c) => c.id === connId);

  const search = useCallback(
    async (q: string, from: string) => {
      if (!connId) return;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      const mine = ++seq.current;
      setSearching(true);
      setSearchError(null);
      try {
        const r = await redisApi.searchKeys(connId, q, from, ctl.signal);
        if (mine !== seq.current) return;
        setResults((prev) => (from === '0' ? r.keys : [...prev, ...r.keys.filter((k) => !prev.some((x) => x.key === k.key))]));
        setCursor(r.cursor);
        setDone(r.done);
        setHi(-1);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (mine === seq.current) {
          setSearchError(e instanceof Error ? e.message : String(e));
          setResults([]);
        }
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    },
    [connId],
  );

  const scheduleSearch = (q: string) => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void search(q, '0'), SEARCH_DEBOUNCE_MS);
  };

  // Close the dropdown when clicking elsewhere.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const load = (key: string) => {
    const k = key.trim();
    if (!k || !connId) return;
    setOpen(false);
    setQuery(k);
    p.onLoad(connId, k);
  };

  if (p.connections.length === 0) {
    return (
      <div className="source-bar">
        <button onClick={p.onManage} className="primary">
          Connect to Redis…
        </button>
        <span className="muted small">Load JSON straight from a key – no download needed.</span>
      </div>
    );
  }

  const meta = p.source?.meta;
  return (
    <div className="source-bar" ref={rootRef}>
      <div className="source-row">
        <select
          className={`conn-select env-${conn?.env ?? 'dev'}`}
          value={connId}
          onChange={(e) => {
            setConnId(e.target.value);
            p.onConnChange(e.target.value);
            setResults([]);
            if (open) scheduleSearch(query);
          }}
          title="Redis connection"
        >
          {p.connections.map((c) => (
            <option key={c.id} value={c.id}>
              {ENV_LABEL[c.env]} · {c.name}
            </option>
          ))}
        </select>
        <div className="key-box">
          <input
            className="key-input"
            value={query}
            placeholder="Search keys or paste an exact key, then Enter"
            spellCheck={false}
            autoComplete="off"
            onFocus={() => {
              setOpen(true);
              if (results.length === 0) scheduleSearch(query);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setHi(-1); // typed text wins over a stale highlight
              scheduleSearch(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setHi((h) => Math.min(results.length - 1, h + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(-1, h - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                load(hi >= 0 && results[hi] ? results[hi].key : query);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          {open && (
            <div className="key-dropdown" role="listbox">
              {searchError && <div className="dd-note err">{searchError}</div>}
              {results.map((r, i) => (
                <div
                  key={r.key}
                  role="option"
                  aria-selected={i === hi}
                  className={`dd-item${i === hi ? ' hi' : ''}`}
                  onMouseMove={() => hi !== i && setHi(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    load(r.key);
                  }}
                >
                  <span className="dd-key">{r.key}</span>
                  <span className="dd-type">{r.type === 'ReJSON-RL' ? 'json' : r.type}</span>
                  <span className="dd-ttl">{r.ttlMs >= 0 ? formatTtl(r.ttlMs) : ''}</span>
                </div>
              ))}
              {searching && <div className="dd-note">Searching…</div>}
              {!searching && !searchError && results.length === 0 && <div className="dd-note">{done ? 'No keys match. Press Enter to try the exact key.' : 'No matches yet in the part scanned.'}</div>}
              {!searching && !done && (
                <button className="dd-more" onMouseDown={(e) => e.preventDefault()} onClick={() => void search(query, cursor)}>
                  Searched part of the keyspace – scan more
                </button>
              )}
            </div>
          )}
        </div>
        <button className="primary" disabled={p.busy || !query.trim()} onClick={() => load(query)} title="Fetch this key">
          Load
        </button>
        <button onClick={p.onManage} title="Manage Redis connections" aria-label="Manage connections">
          ⚙
        </button>
      </div>

      {p.source && meta && (
        <div className="source-row meta">
          <button onClick={p.onRefresh} disabled={p.busy} title="Fetch the key again">
            ⟳ Refresh
          </button>
          <span className="muted small">
            fetched {formatClock(p.source.fetchedAt)} · {meta.type === 'ReJSON-RL' ? 'RedisJSON' : meta.type} · {formatBytes(meta.bytes)} · TTL {formatTtl(meta.ttlMs)}
          </span>
          <div className="spacer" />
          <select
            className="compare-select"
            value=""
            disabled={p.busy}
            onChange={(e) => e.target.value && p.onCompareWith(e.target.value)}
            title="Fetch this same key from another connection into the other pane"
          >
            <option value="">Compare with same key in…</option>
            {p.connections.map((c) => (
              <option key={c.id} value={c.id}>
                {ENV_LABEL[c.env]} · {c.name}
                {c.id === p.source!.connId ? ' (this one)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
