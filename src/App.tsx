import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorPane, type EditorHandle, type Side, type SideState } from './components/EditorPane';
import { Library } from './components/Library';
import { Connections } from './components/Connections';
import { SourceBar } from './components/SourceBar';
import { SaveDialog } from './components/SaveDialog';
import { OriginBanner } from './components/OriginBanner';
import { DiffView } from './lib/diffView';
import { monaco } from './lib/monaco';
import { diffInWorker, formatInWorker, resetDiffWorker, validateInWorker } from './lib/workers';
import { loadSettings, saveSettings, storage, type DocMeta, type PaneOrigin, type Settings } from './lib/storage';
import type { JsonError } from './lib/protocol';
import { ENV_LABEL, isApiAvailable, redisApi } from './lib/redisApi';
import type { ConnectionInfo, SavedFrom, SourceInfo } from './lib/redisTypes';
import { SAMPLE_LEFT, SAMPLE_RIGHT } from './sample';

const SIDES: Side[] = ['left', 'right'];
const MIN_FONT = 6;
const MAX_FONT = 32;
const LINE_HEIGHT_RATIO = 1.35;
const DIFF_DEBOUNCE_MS = 350;
const VALIDATE_DEBOUNCE_MS = 700;
const AUTOSAVE_DEBOUNCE_MS = 1500;

const emptySide = (name: string): SideState => ({
  name,
  docId: null,
  unsaved: false,
  size: 0,
  lines: 1,
  status: 'idle',
  source: null,
  origin: null,
});

interface DiffStats {
  added: number;
  removed: number;
  approximate: boolean;
  alignmentSkipped: boolean;
  ms: number;
}

interface LoadOptions {
  name?: string;
  docId?: string | null;
  unsaved?: boolean;
  /** Pretty-print (if valid JSON) before showing. */
  format?: boolean;
  /** Where the text came from. `null` clears it; omit to leave it unchanged. */
  source?: SourceInfo | null;
  /** Library copy / file origin. `null` clears it; omit to leave it unchanged. */
  origin?: PaneOrigin | null;
}

/** `2026-11-03 14:05`, local time. */
const stamp = (d = new Date()) => {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [sides, setSides] = useState<Record<Side, SideState>>({
    left: emptySide('Original.json'),
    right: emptySide('Modified.json'),
  });
  const sidesRef = useRef(sides);

  const [ready, setReady] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [stats, setStats] = useState<DiffStats | null>(null);
  const [nav, setNav] = useState({ current: -1, total: 0 });
  const [showLibrary, setShowLibrary] = useState(false);
  const [showConnections, setShowConnections] = useState(false);
  const [saveDialog, setSaveDialog] = useState<{ side: Side; defaultName: string } | null>(null);
  const [redis, setRedis] = useState<{ available: boolean; connections: ConnectionInfo[] }>({ available: false, connections: [] });
  const connectionsRef = useRef<ConnectionInfo[]>([]);
  connectionsRef.current = redis.connections;
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null);

  const handles = useRef<Partial<Record<Side, EditorHandle>>>({});
  const viewRef = useRef<DiffView | null>(null);
  const programmatic = useRef<Record<Side, boolean>>({ left: false, right: false });
  const lastFocused = useRef<Side>('left');
  const timers = useRef<Record<string, number>>({});
  const autosaveDirty = useRef<Record<Side, boolean>>({ left: false, right: false });
  const diffRun = useRef({ running: false, rerun: false });

  // ---------- small helpers ----------

  const patchSide = useCallback((side: Side, patch: Partial<SideState>) => {
    sidesRef.current = { ...sidesRef.current, [side]: { ...sidesRef.current[side], ...patch } };
    setSides(sidesRef.current);
  }, []);

  const showToast = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast({ msg, kind });
    window.clearTimeout(timers.current.toast);
    timers.current.toast = window.setTimeout(() => setToast(null), kind === 'error' ? 6000 : 2500);
  }, []);

  const debounce = (key: string, ms: number, fn: () => void) => {
    window.clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(fn, ms);
  };

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    settingsRef.current = next;
    setSettings(next);
    saveSettings(next);
  }, []);

  const setMarkers = (side: Side, err: JsonError | null) => {
    const model = handles.current[side]?.model;
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'json-check',
      err
        ? [
            {
              severity: monaco.MarkerSeverity.Error,
              message: err.message,
              startLineNumber: err.line,
              startColumn: err.column,
              endLineNumber: err.line,
              endColumn: err.column + 1,
            },
          ]
        : [],
    );
  };

  const refreshStats = (side: Side) => {
    const model = handles.current[side]?.model;
    if (model) patchSide(side, { size: model.getValueLength(), lines: model.getLineCount() });
  };

  // ---------- autosave (IndexedDB) ----------

  const flushAutosave = useCallback(
    async (side: Side) => {
      const model = handles.current[side]?.model;
      if (!model || !autosaveDirty.current[side]) return;
      autosaveDirty.current[side] = false;
      const s = sidesRef.current[side];
      try {
        await storage.saveWorkspace(side, { text: model.getValue(), name: s.name, docId: s.docId, unsaved: s.unsaved, source: s.source, origin: s.origin });
      } catch (e) {
        autosaveDirty.current[side] = true;
        showToast(`Autosave failed: ${e instanceof Error ? e.message : e}`, 'error');
      }
    },
    [showToast],
  );

  const scheduleAutosave = (side: Side) => {
    autosaveDirty.current[side] = true;
    debounce(`autosave-${side}`, AUTOSAVE_DEBOUNCE_MS, () => void flushAutosave(side));
  };

  // ---------- validation ----------

  const validateNow = async (side: Side) => {
    const h = handles.current[side];
    if (!h) return;
    const version = h.model.getVersionId();
    const err = await validateInWorker(h.model.getValue());
    if (h.model.getVersionId() !== version) return; // edited meanwhile; a newer check is queued
    setMarkers(side, err);
    patchSide(side, err ? { status: 'error', error: err } : { status: 'valid', error: undefined });
  };

  // ---------- comparing ----------

  const runDiff = async () => {
    const view = viewRef.current;
    const l = handles.current.left;
    const r = handles.current.right;
    if (!view || !l || !r || !settingsRef.current.compare) return;
    const run = diffRun.current;
    if (run.running) {
      run.rerun = true;
      return;
    }
    run.running = true;
    setComparing(true);
    try {
      do {
        run.rerun = false;
        const vl = l.model.getVersionId();
        const vr = r.model.getVersionId();
        const t0 = performance.now();
        const result = await diffInWorker(
          { key: vl, getText: () => l.model.getValue() },
          { key: vr, getText: () => r.model.getValue() },
        );
        const unchanged = l.model.getVersionId() === vl && r.model.getVersionId() === vr;
        if (unchanged && settingsRef.current.compare) {
          view.apply(result);
          setNav({ current: view.current, total: view.blockCount });
          setStats({
            added: result.addedLines,
            removed: result.removedLines,
            approximate: result.approximate,
            alignmentSkipped: view.alignmentSkipped,
            ms: Math.round(performance.now() - t0),
          });
        }
      } while (run.rerun);
    } catch (e) {
      showToast(`Compare failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      run.running = false;
      setComparing(false);
    }
  };
  const runDiffRef = useRef(runDiff);
  runDiffRef.current = runDiff;

  const scheduleDiff = (delay = DIFF_DEBOUNCE_MS) => {
    if (!settingsRef.current.compare) return;
    debounce('diff', delay, () => void runDiffRef.current());
  };

  // ---------- loading / formatting text into a pane ----------

  const setText = (side: Side, text: string) => {
    const h = handles.current[side]!;
    programmatic.current[side] = true;
    try {
      h.model.setValue(text);
    } finally {
      programmatic.current[side] = false;
    }
  };

  const loadText = async (side: Side, raw: string, opts: LoadOptions = {}) => {
    const h = handles.current[side];
    if (!h) return;
    patchSide(side, { status: 'busy', busyLabel: opts.format ? 'Formatting…' : 'Loading…' });
    let text = raw.replace(/\r\n?/g, '\n');
    let error: JsonError | null = null;
    let validated = false;
    if (opts.format && raw.length > 0) {
      const res = await formatInWorker(raw, settingsRef.current.sortKeys);
      if (res.ok) {
        text = res.text;
        validated = true;
      } else {
        error = res.error;
        validated = true;
      }
    }
    setText(side, text);
    h.editor.setPosition({ lineNumber: 1, column: 1 });
    h.editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
    setMarkers(side, error);
    patchSide(side, {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.docId !== undefined ? { docId: opts.docId } : {}),
      ...(opts.unsaved !== undefined ? { unsaved: opts.unsaved } : {}),
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      status: text.length === 0 ? 'idle' : validated ? (error ? 'error' : 'valid') : 'idle',
      error: error ?? undefined,
    });
    refreshStats(side);
    scheduleAutosave(side);
    scheduleDiff(0);
    if (!validated && text.length > 0) void validateNow(side);
  };

  const formatSide = async (side: Side, announce = true) => {
    const h = handles.current[side];
    if (!h || h.model.getValueLength() === 0) return;
    const before = h.model.getValue();
    patchSide(side, { status: 'busy', busyLabel: 'Formatting…' });
    const res = await formatInWorker(before, settingsRef.current.sortKeys);
    if (h.model.getValue() !== before) return; // user kept typing; skip
    if (!res.ok) {
      setMarkers(side, res.error);
      patchSide(side, { status: 'error', error: res.error });
      if (announce) showToast(`Can't format: ${res.error.message} (line ${res.error.line})`, 'error');
      return;
    }
    setMarkers(side, null);
    if (res.text !== before) {
      const scrollTop = h.editor.getScrollTop();
      setText(side, res.text);
      h.editor.setScrollTop(scrollTop);
      patchSide(side, { unsaved: true });
      refreshStats(side);
      scheduleAutosave(side);
      scheduleDiff(0);
    }
    patchSide(side, { status: 'valid', error: undefined });
  };

  const openFile = async (side: Side, file: File) => {
    try {
      const text = await file.text();
      await loadText(side, text, {
        name: file.name,
        docId: null,
        unsaved: true,
        source: null,
        origin: { kind: 'file', fileName: file.name },
        format: settingsRef.current.autoFormat,
      });
    } catch (e) {
      showToast(`Could not read ${file.name}: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  /** Where the pane's content came from, remembered with a saved copy. */
  const savedFromFor = (side: Side): SavedFrom | null => {
    const s = sidesRef.current[side];
    if (s.source) {
      const conn = connectionsRef.current.find((c) => c.id === s.source!.connId);
      if (!conn) return null;
      return { connId: conn.id, connName: conn.name, env: conn.env, key: s.source.key, fetchedAt: s.source.fetchedAt };
    }
    return s.origin?.kind === 'library' ? s.origin.from : null;
  };

  /** Opens the "Save to library" dialog with a ready-made name. */
  const requestSave = (side: Side) => {
    const s = sidesRef.current[side];
    if (s.size === 0) {
      showToast('Nothing to save: this pane is empty', 'error');
      return;
    }
    let defaultName = s.name.trim() || 'Untitled.json';
    // A new snapshot of a Redis key gets the key, environment and time so copies are easy to tell apart.
    if (!s.docId && s.source) {
      const env = savedFromFor(side)?.env;
      defaultName = `${s.source.key} (${env ? ENV_LABEL[env] : 'redis'}, ${stamp()})`;
    }
    setSaveDialog({ side, defaultName });
  };

  const saveSide = async (side: Side, name: string, asCopy: boolean) => {
    const h = handles.current[side];
    if (!h) return;
    const s = sidesRef.current[side];
    const from = savedFromFor(side);
    try {
      const meta = await storage.saveDoc(name, h.model.getValue(), asCopy ? null : s.docId, from);
      if (s.source) {
        // A live Redis pane stays live and keeps showing its key. Each save is a separate snapshot
        // (so it is not linked to the pane, and saving again makes another one).
        patchSide(side, { unsaved: false });
      } else {
        patchSide(side, {
          docId: meta.id,
          name,
          unsaved: false,
          origin: { kind: 'library', savedAt: meta.updatedAt, from },
        });
      }
      autosaveDirty.current[side] = true;
      await flushAutosave(side);
      showToast(`Saved “${name}” to the library`);
    } catch (e) {
      showToast(`Save failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  const downloadSide = (side: Side) => {
    const h = handles.current[side];
    if (!h) return;
    // Redis keys often contain ':' (and other characters Windows refuses in file names).
    const name = (sidesRef.current[side].name.trim() || 'document.json').replace(/[\\/:*?"<>|]+/g, '_');
    const blob = new Blob([h.model.getValue()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = /\.(json|txt)$/i.test(name) ? name : `${name}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const clearSide = (side: Side) => {
    const s = sidesRef.current[side];
    if (s.unsaved && s.size > 0 && !confirm('Clear this pane? Changes not saved to the library will be lost.')) return;
    void loadText(side, '', { name: side === 'left' ? 'Original.json' : 'Modified.json', docId: null, unsaved: false, source: null, origin: null });
  };

  const loadFromLibrary = async (side: Side, doc: DocMeta) => {
    setShowLibrary(false);
    if (side === 'right' && !settingsRef.current.rightOpen) updateSettings({ rightOpen: true });
    try {
      const text = await storage.getDocText(doc.id);
      if (text === undefined) throw new Error('document content is missing');
      await loadText(side, text, {
        name: doc.name,
        docId: doc.id,
        unsaved: false,
        source: null,
        origin: { kind: 'library', savedAt: doc.updatedAt, from: doc.from ?? null },
        format: false,
      });
    } catch (e) {
      showToast(`Could not open “${doc.name}”: ${e instanceof Error ? e.message : e}`, 'error');
    }
  };

  // ---------- Redis ----------

  const reloadConnections = useCallback(async () => {
    const available = await isApiAvailable();
    if (!available) {
      setRedis({ available: false, connections: [] });
      return;
    }
    try {
      setRedis({ available: true, connections: await redisApi.listConnections() });
    } catch (e) {
      setRedis({ available: true, connections: [] });
      showToast(`Could not load Redis connections: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }, [showToast]);

  /** Fetches a key into a pane (always pretty-printed; Redis values are usually minified). */
  const fetchKey = async (side: Side, connId: string, key: string): Promise<boolean> => {
    const conn = connectionsRef.current.find((c) => c.id === connId);
    if (!conn) return false;
    const prev = sidesRef.current[side];
    if (prev.unsaved && prev.size > 0 && !confirm('This pane has changes that are not saved to the library. Replace them?')) return false;
    patchSide(side, { status: 'busy', busyLabel: `Fetching from ${conn.name}…` });
    try {
      const { text, meta } = await redisApi.fetchValue(connId, key);
      if (settingsRef.current.lastConnId !== connId) updateSettings({ lastConnId: connId });
      await loadText(side, text, {
        name: key,
        docId: null,
        unsaved: false,
        format: true,
        source: { connId, key, fetchedAt: Date.now(), meta },
        origin: null,
      });
      return true;
    } catch (e) {
      patchSide(side, { status: prev.status, busyLabel: undefined, error: prev.error });
      showToast(`Could not fetch “${key}” from ${conn.name}: ${e instanceof Error ? e.message : e}`, 'error');
      return false;
    }
  };

  const refreshSide = (side: Side) => {
    const src = sidesRef.current[side].source;
    if (src) void fetchKey(side, src.connId, src.key);
  };

  /** Loads the same key from another connection into the opposite pane. */
  const compareWith = async (side: Side, connId: string) => {
    const src = sidesRef.current[side].source;
    if (!src) return;
    const other: Side = side === 'left' ? 'right' : 'left';
    if (!settingsRef.current.rightOpen) updateSettings({ rightOpen: true });
    // Asking to compare is an explicit request, so switch comparing on once the other value is in.
    if (await fetchKey(other, connId, src.key)) updateSettings({ compare: true });
  };

  // ---------- second pane ----------

  const closeRight = () => {
    if (lastFocused.current === 'right') lastFocused.current = 'left';
    // Nothing to compare against any more.
    updateSettings({ rightOpen: false, compare: false });
  };

  const goToError = (side: Side) => {
    const err = sidesRef.current[side].error;
    const h = handles.current[side];
    if (!err || !h) return;
    h.editor.revealPositionInCenter({ lineNumber: err.line, column: err.column });
    h.editor.setPosition({ lineNumber: err.line, column: err.column });
    h.editor.focus();
  };

  // ---------- navigation ----------

  const step = (dir: 1 | -1) => {
    const view = viewRef.current;
    if (!view || !settingsRef.current.compare) return;
    if (view.blockCount === 0) return;
    if (dir === 1) view.next();
    else view.prev();
    setNav({ current: view.current, total: view.blockCount });
  };
  const stepRef = useRef(step);
  stepRef.current = step;

  const zoom = useCallback(
    (delta: number) => {
      const next = Math.min(MAX_FONT, Math.max(MIN_FONT, settingsRef.current.fontSize + delta));
      if (next !== settingsRef.current.fontSize) updateSettings({ fontSize: next });
    },
    [updateSettings],
  );

  // ---------- init once both editors exist ----------

  const onReady = (side: Side) => (h: EditorHandle) => {
    handles.current[side] = h;
    if (handles.current.left && handles.current.right) setReady(true);
  };

  useEffect(() => {
    if (!ready) return;
    const l = handles.current.left!;
    const r = handles.current.right!;
    const view = new DiffView(l.editor, r.editor);
    viewRef.current = view;

    const disposables: monaco.IDisposable[] = [];
    for (const side of SIDES) {
      const h = handles.current[side]!;
      disposables.push(
        h.model.onDidChangeContent(() => {
          refreshStats(side);
          if (!programmatic.current[side]) {
            patchSide(side, { unsaved: true, status: 'idle' });
            debounce(`validate-${side}`, VALIDATE_DEBOUNCE_MS, () => void validateNow(side));
          }
          scheduleAutosave(side);
          scheduleDiff();
        }),
        h.editor.onDidFocusEditorText(() => (lastFocused.current = side)),
        // Pasting over the whole document (the usual "select all, paste") re-formats it.
        h.editor.onDidPaste((e) => {
          const full = h.model.getFullModelRange();
          if (settingsRef.current.autoFormat && e.range.getStartPosition().equals(full.getStartPosition()) && e.range.getEndPosition().equals(full.getEndPosition())) {
            void formatSide(side, false);
          }
        }),
      );
    }

    (async () => {
      let restored = false;
      try {
        for (const side of SIDES) {
          const saved = await storage.loadWorkspace(side);
          if (saved) {
            restored = true;
            await loadText(side, saved.text, { name: saved.name, docId: saved.docId, unsaved: saved.unsaved, source: saved.source ?? null, origin: saved.origin ?? null, format: false });
          }
        }
      } catch (e) {
        showToast(`Could not restore your last session: ${e instanceof Error ? e.message : e}`, 'error');
      }
      if (!restored) {
        await loadText('left', SAMPLE_LEFT, { name: 'Original.json', unsaved: false, format: false });
        await loadText('right', SAMPLE_RIGHT, { name: 'Modified.json', unsaved: false, format: false });
      }
      scheduleDiff(0);
    })();

    const flushAll = () => SIDES.forEach((s) => void flushAutosave(s));
    const onVisibility = () => document.visibilityState === 'hidden' && flushAll();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flushAll);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flushAll);
      disposables.forEach((d) => d.dispose());
      view.dispose();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    void reloadConnections();
  }, [reloadConnections]);

  // ---------- reactive settings ----------

  useEffect(() => {
    // lineHeight < 8 is a multiplier of the font size in Monaco, >= 8 is pixels.
    // Always passing a multiplier keeps small fonts compact (that is the point of zooming out).
    for (const side of SIDES) {
      handles.current[side]?.editor.updateOptions({ fontSize: settings.fontSize, lineHeight: LINE_HEIGHT_RATIO });
    }
  }, [settings.fontSize, ready]);

  useEffect(() => {
    monaco.editor.setTheme(settings.theme === 'dark' ? 'vs-dark' : 'vs');
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.theme]);

  useEffect(() => {
    if (!ready) return;
    if (settings.compare) {
      void runDiffRef.current();
    } else {
      window.clearTimeout(timers.current.diff);
      viewRef.current?.clear();
      void resetDiffWorker();
      setStats(null);
      setNav({ current: -1, total: 0 });
    }
  }, [settings.compare, ready]);

  // ---------- keyboard shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F7') {
        e.preventDefault();
        stepRef.current(e.shiftKey ? -1 : 1);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        requestSave(settingsRef.current.rightOpen ? lastFocused.current : 'left');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- render ----------

  const envClassFor = (side: Side): string | undefined => {
    const src = sides[side].source;
    const env = src && redis.connections.find((c) => c.id === src.connId)?.env;
    if (env) return `env-${env}`;
    // Not live Redis data: a dashed violet / grey bar instead of a solid environment colour.
    const origin = sides[side].origin;
    return origin ? `origin-${origin.kind}` : undefined;
  };

  const { fontSize, sortKeys, autoFormat, theme, rightOpen } = settings;
  const compare = settings.compare && rightOpen;
  const visibleSides = rightOpen ? SIDES : (['left'] as Side[]);
  const counter = !compare
    ? 'Compare is off'
    : comparing && !stats
      ? 'Comparing…'
      : nav.total === 0
        ? stats
          ? 'No differences'
          : '—'
        : `${nav.current >= 0 ? nav.current + 1 : '–'} / ${nav.total.toLocaleString()}`;

  const onToggleSortKeys = (v: boolean) => {
    updateSettings({ sortKeys: v });
    // Re-format straight away so the effect is visible.
    SIDES.forEach((s) => void formatSide(s, false));
  };

  return (
    <div className="app">
      <header className="toolbar">
        <div className="brand">
          <span className="logo">{'{}'}</span> JSON Compare
        </div>

        {rightOpen ? (
          <>
            <label className="switch" title="Turn the comparison on or off">
              <input type="checkbox" checked={compare} onChange={(e) => updateSettings({ compare: e.target.checked })} />
              <span className="track" />
              <span>Compare</span>
            </label>

            <div className="group">
              <button disabled={!compare || nav.total === 0} onClick={() => step(-1)} title="Previous difference (Shift+F7)">
                ▲ Prev
              </button>
              <span className={`counter${comparing ? ' busy' : ''}`} aria-live="polite">
                {counter}
              </span>
              <button disabled={!compare || nav.total === 0} onClick={() => step(1)} title="Next difference (F7)">
                ▼ Next
              </button>
            </div>

            {compare && stats && (
              <span className="stats" title={stats.approximate ? 'Files are very different; the diff may not be minimal' : undefined}>
                <span className="del">−{stats.removed.toLocaleString()}</span>
                <span className="add">+{stats.added.toLocaleString()}</span>
                <span className="muted">lines · {stats.ms} ms</span>
                {stats.approximate && <span className="warn">approx.</span>}
                {stats.alignmentSkipped && <span className="warn" title="Too many differences to line up the panes">unaligned</span>}
              </span>
            )}
          </>
        ) : (
          <button onClick={() => updateSettings({ rightOpen: true })} title="Show a second pane to compare two JSON documents">
            ＋ Second pane
          </button>
        )}

        <div className="spacer" />

        <label className="check" title="Sort object keys when formatting, so key order is not reported as a difference">
          <input type="checkbox" checked={sortKeys} onChange={(e) => onToggleSortKeys(e.target.checked)} />
          Sort keys
        </label>
        <label className="check" title="Pretty-print JSON when you open a file or paste over a whole pane">
          <input type="checkbox" checked={autoFormat} onChange={(e) => updateSettings({ autoFormat: e.target.checked })} />
          Auto-format
        </label>
        <button onClick={() => visibleSides.forEach((s) => void formatSide(s))} title={rightOpen ? 'Pretty-print both panes' : 'Pretty-print the document'}>
          {rightOpen ? 'Format both' : 'Format'}
        </button>

        <div className="group font" title="Editor font size (also Ctrl + mouse wheel)">
          <button onClick={() => zoom(-1)} disabled={fontSize <= MIN_FONT} aria-label="Smaller font">
            A−
          </button>
          <span className="counter">{fontSize}px</span>
          <button onClick={() => zoom(1)} disabled={fontSize >= MAX_FONT} aria-label="Larger font">
            A+
          </button>
        </div>

        {redis.available ? (
          <button onClick={() => setShowConnections(true)} title="Manage Redis connections">
            Redis
          </button>
        ) : (
          <span className="muted small" title="Run `npm run dev` or `npm start` to start the local server and load JSON straight from Redis">
            Redis: server not running
          </span>
        )}
        <button onClick={() => setShowLibrary(true)}>Library</button>
        <button onClick={() => updateSettings({ theme: theme === 'dark' ? 'light' : 'dark' })} aria-label="Toggle theme" title="Toggle light / dark">
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <main className={`panes${rightOpen ? '' : ' single'}`}>
        {SIDES.map((side) => (
          <EditorPane
            key={side}
            side={side}
            label={side === 'right' ? 'Modified' : rightOpen ? 'Original' : 'Document'}
            state={sides[side]}
            fontSize={fontSize}
            envClass={envClassFor(side)}
            sourceBar={
              redis.available ? (
                <SourceBar
                  connections={redis.connections}
                  source={sides[side].source}
                  defaultConnId={settings.lastConnId}
                  busy={sides[side].status === 'busy'}
                  onLoad={(connId, key) => void fetchKey(side, connId, key)}
                  onRefresh={() => refreshSide(side)}
                  onCompareWith={(connId) => void compareWith(side, connId)}
                  onManage={() => setShowConnections(true)}
                  onConnChange={(id) => updateSettings({ lastConnId: id })}
                />
              ) : undefined
            }
            banner={
              sides[side].origin && !sides[side].source ? (
                <OriginBanner
                  origin={sides[side].origin!}
                  edited={sides[side].unsaved}
                  connections={redis.connections}
                  onLoadLive={(connId, key) => void fetchKey(side, connId, key)}
                />
              ) : undefined
            }
            onClose={side === 'right' ? closeRight : undefined}
            onReady={onReady(side)}
            onNameChange={(name) => {
              patchSide(side, { name });
              scheduleAutosave(side);
            }}
            onOpenFile={(f) => void openFile(side, f)}
            onFormat={() => void formatSide(side)}
            onSave={() => requestSave(side)}
            onDownload={() => downloadSide(side)}
            onClear={() => clearSide(side)}
            onZoom={zoom}
            onGoToError={() => goToError(side)}
          />
        ))}
      </main>

      {saveDialog && (
        <SaveDialog
          defaultName={saveDialog.defaultName}
          existing={!!sides[saveDialog.side].docId}
          from={savedFromFor(saveDialog.side)}
          onCancel={() => setSaveDialog(null)}
          onSave={(name, asCopy) => {
            const side = saveDialog.side;
            setSaveDialog(null);
            void saveSide(side, name, asCopy);
          }}
        />
      )}
      {showConnections && (
        <Connections connections={redis.connections} onChanged={() => void reloadConnections()} onClose={() => setShowConnections(false)} />
      )}
      {showLibrary && (
        <Library onClose={() => setShowLibrary(false)} onLoad={(s, d) => void loadFromLibrary(s, d)} onError={(m) => showToast(m, 'error')} />
      )}
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  );
}
