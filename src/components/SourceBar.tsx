import { useCallback, useEffect, useRef, useState } from 'react';
import { ENV_LABEL, formatTtl, redisApi } from '../lib/redisApi';
import { formatBytes, formatClock } from '../lib/format';
import { crumbs, describeCount, isGlob, mergeEntries, PAGE_SIZE, splitQuery, toRows, type Row } from '../lib/keyBrowse';
import type { BrowseEntry, ConnectionInfo, KeyEntry, SourceInfo } from '../lib/redisTypes';

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

const SEARCH_DEBOUNCE_MS = 250;
/** When a level has no matches yet in the part scanned, keep scanning on our own up to this many requests. */
const AUTO_CONTINUE_MAX = 15;

/**
 * Key picker. Instead of asking you to remember how a key starts, it lets you
 * drill down one level at a time (offer: → offer:123 → …), showing the first
 * few choices at each level. Text containing * ? [ is searched as a pattern.
 */
export function SourceBar(p: Props) {
  const [connId, setConnId] = useState(p.source?.connId ?? p.defaultConnId ?? p.connections[0]?.id ?? '');
  const [query, setQuery] = useState(p.source?.key ?? '');
  const [open, setOpen] = useState(false);
  // Browse mode: choices for the next level, merged across scan batches.
  const [entries, setEntries] = useState<Map<string, BrowseEntry>>(new Map());
  const [rowsPrefix, setRowsPrefix] = useState('');
  // Flat mode: pattern search (or "contains" fallback).
  const [flat, setFlat] = useState<KeyEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [cursor, setCursor] = useState('0');
  const [done, setDone] = useState(true);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hi, setHi] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number>(0);
  const seq = useRef(0);
  // Text you type may be a pattern (* ? [); text the picker inserted (drill-down, loaded key) is always literal.
  const typedRef = useRef(false);

  // Follow the pane when its source is changed from elsewhere (restore, "compare with…", refresh).
  const srcKey = p.source ? `${p.source.connId}\u0000${p.source.key}` : '';
  useEffect(() => {
    typedRef.current = false;
    if (p.source) {
      setConnId(p.source.connId);
      setQuery(p.source.key);
    } else {
      // The pane now holds something that is not a Redis key (library copy, file, cleared):
      // don't leave the previous key sitting in the box as if it were the source.
      setQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [srcKey]);

  // Keep the selection valid if connections are edited / removed.
  useEffect(() => {
    if (!p.connections.some((c) => c.id === connId)) setConnId(p.source?.connId ?? p.defaultConnId ?? p.connections[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.connections]);

  const conn = p.connections.find((c) => c.id === connId);

  /**
   * Fetches choices for `q`. `from` is the scan cursor ('0' = start over).
   * `siblings` shows the other keys at the same level instead of narrowing to the typed text.
   */
  const run = useCallback(
    async (q: string, from = '0', opts: { siblings?: boolean; auto?: number; base?: Map<string, BrowseEntry>; literal?: boolean } = {}) => {
      if (!connId) return;
      abortRef.current?.abort();
      const ctl = new AbortController();
      abortRef.current = ctl;
      const mine = ++seq.current;
      setSearching(true);
      setSearchError(null);
      const fresh = from === '0';
      const literal = opts.literal ?? !typedRef.current;
      try {
        if (!literal && isGlob(q)) {
          const r = await redisApi.searchKeys(connId, q, from, ctl.signal);
          if (mine !== seq.current) return;
          setFlat((prev) => (fresh ? r.keys : [...(prev ?? []), ...r.keys.filter((k) => !(prev ?? []).some((x) => x.key === k.key))]));
          setNote(null);
          setCursor(r.cursor);
          setDone(r.done);
          if (fresh) setShown(PAGE_SIZE);
        } else {
          const { prefix, partial } = splitQuery(q);
          const r = await redisApi.browse(connId, prefix, opts.siblings ? '' : partial, from, ctl.signal);
          if (mine !== seq.current) return;
          const merged = mergeEntries(fresh ? new Map() : (opts.base ?? entries), r.entries);
          if (merged.size === 0 && !r.done && (opts.auto ?? 0) < AUTO_CONTINUE_MAX) {
            // Nothing matched in the part scanned so far: keep going without bothering the user.
            setCursor(r.cursor);
            void run(q, r.cursor, { ...opts, literal, auto: (opts.auto ?? 0) + 1, base: merged });
            return;
          }
          if (merged.size === 0 && r.done && q.trim()) {
            // Nothing *starts with* the text: fall back to "contains" so you never need to know the start.
            const f = await redisApi.searchKeys(connId, q, '0', ctl.signal, literal);
            if (mine !== seq.current) return;
            setFlat(f.keys);
            setNote(f.keys.length ? `No key starts with “${q}”. Showing keys that contain it:` : null);
            setCursor(f.cursor);
            setDone(f.done);
            setEntries(new Map());
          } else {
            setFlat(null);
            setNote(null);
            setEntries(merged);
            setRowsPrefix(prefix);
            setCursor(r.cursor);
            setDone(r.done);
          }
          if (fresh) setShown(PAGE_SIZE);
        }
        if (fresh) setHi(-1);
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        if (mine === seq.current) {
          setSearchError(e instanceof Error ? e.message : String(e));
          setEntries(new Map());
          setFlat(null);
        }
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    },
    // `entries` is read when appending a further batch; a stale value only drops a not-yet-merged batch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connId, entries],
  );

  const scheduleRun = (q: string) => {
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => void run(q), SEARCH_DEBOUNCE_MS);
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
    window.clearTimeout(timerRef.current);
    abortRef.current?.abort();
    setOpen(false);
    setQuery(k);
    p.onLoad(connId, k);
  };

  /** Puts `text` in the box and shows the choices for it straight away. */
  const goTo = (text: string) => {
    window.clearTimeout(timerRef.current);
    typedRef.current = false;
    setQuery(text);
    setHi(-1);
    setOpen(true);
    void run(text);
    inputRef.current?.focus();
  };

  const rows: Row[] = flat
    ? flat.map((k) => ({ kind: 'leaf' as const, label: k.key, path: k.key, type: k.type, ttlMs: k.ttlMs }))
    : toRows(rowsPrefix, entries.values());
  const visible = rows.slice(0, shown);
  const hiddenCount = rows.length - visible.length;
  const { prefix: queryPrefix, partial } = splitQuery(query);
  const path = flat ? [] : crumbs(rowsPrefix);

  /** Opens the list; on a loaded key it shows the neighbouring keys instead of just that one. */
  const openChoices = () => {
    setOpen(true);
    void run(query, '0', { siblings: !!p.source && query === p.source.key });
  };

  const choose = (row: Row) => (row.kind === 'folder' ? goTo(row.path) : load(row.path));

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
  const sourceConn = p.source && p.connections.find((c) => c.id === p.source!.connId);
  return (
    <div className="source-bar" ref={rootRef}>
      <div className="source-row">
        <select
          className={`conn-select env-${conn?.env ?? 'tst'}`}
          value={connId}
          onChange={(e) => {
            setConnId(e.target.value);
            p.onConnChange(e.target.value);
            setEntries(new Map());
            setFlat(null);
            if (open) scheduleRun(query);
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
            ref={inputRef}
            className="key-input"
            value={query}
            placeholder="Click to browse keys, or type / paste a key"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={open}
            onFocus={openChoices}
            // The box keeps focus after a key is loaded with Enter, so a later click must reopen the list too.
            onClick={() => !open && openChoices()}
            onChange={(e) => {
              typedRef.current = true;
              setQuery(e.target.value);
              setOpen(true);
              setHi(-1); // typed text wins over a stale highlight
              scheduleRun(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setOpen(true);
                setHi((h) => Math.min(visible.length - 1, h + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHi((h) => Math.max(-1, h - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                if (hi >= 0 && visible[hi]) choose(visible[hi]);
                else if (query.endsWith(':')) void run(query);
                else load(query);
              } else if (e.key === 'Tab' && open && !e.shiftKey) {
                // Shell-style completion: Tab fills in the highlighted choice (or the first, once you have typed something).
                const row = hi >= 0 ? visible[hi] : partial ? visible[0] : undefined;
                if (row) {
                  e.preventDefault();
                  if (row.kind === 'folder') goTo(row.path);
                  else {
                    typedRef.current = false;
                    setQuery(row.path);
                    setHi(-1);
                  }
                }
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          {open && (
            <div className="key-dropdown" role="listbox">
              {path.length > 1 && (
                <div className="dd-crumbs">
                  {path.map((c, i) => (
                    <span key={c.value}>
                      {i > 0 && <span className="muted"> › </span>}
                      <button className="crumb" onMouseDown={(e) => e.preventDefault()} onClick={() => goTo(c.value)}>
                        {c.label}
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {note && <div className="dd-note">{note}</div>}
              {searchError && <div className="dd-note err">{searchError}</div>}
              {visible.map((r, i) => (
                <div
                  key={`${r.kind}:${r.path}`}
                  role="option"
                  aria-selected={i === hi}
                  className={`dd-item ${r.kind}${i === hi ? ' hi' : ''}`}
                  title={r.path}
                  onMouseMove={() => hi !== i && setHi(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(r);
                  }}
                >
                  <span className="dd-icon">{r.kind === 'folder' ? '▸' : ''}</span>
                  <span className="dd-key">{r.label}</span>
                  {r.kind === 'folder' ? (
                    <span className="dd-ttl">{describeCount(r.count ?? 0, done)}</span>
                  ) : (
                    <>
                      <span className="dd-type">{r.type === 'ReJSON-RL' ? 'json' : r.type}</span>
                      <span className="dd-ttl">{r.ttlMs !== undefined && r.ttlMs >= 0 ? formatTtl(r.ttlMs) : ''}</span>
                    </>
                  )}
                </div>
              ))}
              {searching && <div className="dd-note">Scanning keys…</div>}
              {!searching && !searchError && rows.length === 0 && (
                <div className="dd-note">
                  {done ? (
                    queryPrefix || partial ? (
                      <>Nothing found. Press Enter to try “{query}” as an exact key.</>
                    ) : (
                      'This database has no keys.'
                    )
                  ) : (
                    'Nothing found in the part scanned so far.'
                  )}
                </div>
              )}
              {hiddenCount > 0 && (
                <button className="dd-more" onMouseDown={(e) => e.preventDefault()} onClick={() => setShown((n) => n + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, hiddenCount)} more ({hiddenCount.toLocaleString()} more loaded)
                </button>
              )}
              {!searching && !done && hiddenCount === 0 && (
                <button className="dd-more" onMouseDown={(e) => e.preventDefault()} onClick={() => void run(query, cursor)}>
                  Scanned only part of the keyspace – keep scanning
                </button>
              )}
              {!flat && rows.length > 0 && <div className="dd-hint">↑↓ choose · Tab complete · Enter open · type * for a pattern search</div>}
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
          {sourceConn && <span className={`env-chip env-${sourceConn.env}`} title={`Live from ${sourceConn.name}`}>{ENV_LABEL[sourceConn.env]}</span>}
          <span className="muted small">
            {sourceConn?.name} · fetched {formatClock(p.source.fetchedAt)} · {meta.type === 'ReJSON-RL' ? 'RedisJSON' : meta.type} · {formatBytes(meta.bytes)} · TTL {formatTtl(meta.ttlMs)}
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
