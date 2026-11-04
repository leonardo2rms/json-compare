/**
 * IndexedDB persistence. localStorage is capped at ~5MB, far too small for
 * 20MB documents, so documents live in IndexedDB:
 *
 *   docs      – metadata of named, saved documents (cheap to list)
 *   content   – the text of those documents, keyed by doc id
 *   workspace – autosaved state of the two editor panes ('left' / 'right')
 */

import { normalizeEnv, type SavedFrom, type SourceInfo } from './redisTypes';

/**
 * What a pane's content is, when it is not live Redis data (that is `SourceInfo`):
 * a copy opened from the library, or a file opened from disk.
 */
export type PaneOrigin =
  | { kind: 'library'; savedAt: number; from: SavedFrom | null }
  | { kind: 'file'; fileName: string };

export interface DocMeta {
  id: string;
  name: string;
  size: number;
  updatedAt: number;
  /** Set when the document was saved from a Redis key. */
  from?: SavedFrom | null;
}

export interface WorkspaceSide {
  text: string;
  name: string;
  /** Id of the saved document this pane is linked to (null = never saved). */
  docId: string | null;
  /** True when the text differs from what was last explicitly saved. */
  unsaved: boolean;
  /** Redis key this pane was loaded from (so it can be refreshed after a reload). */
  source?: SourceInfo | null;
  /** Library / file origin (see PaneOrigin). */
  origin?: PaneOrigin | null;
}

const DB_NAME = 'json-compare';
const STORES = ['docs', 'content', 'workspace'] as const;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

async function tx<T>(
  stores: (typeof STORES)[number][],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const req = fn(t);
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
  });
}

export const storage = {
  async loadWorkspace(side: 'left' | 'right'): Promise<WorkspaceSide | undefined> {
    return tx<WorkspaceSide>(['workspace'], 'readonly', (t) => t.objectStore('workspace').get(side));
  },

  async saveWorkspace(side: 'left' | 'right', data: WorkspaceSide): Promise<void> {
    await tx(['workspace'], 'readwrite', (t) => {
      t.objectStore('workspace').put(data, side);
    });
  },

  async listDocs(): Promise<DocMeta[]> {
    const all = (await tx<DocMeta[]>(['docs'], 'readonly', (t) => t.objectStore('docs').getAll())) ?? [];
    return all
      .map((d) => (d.from ? { ...d, from: { ...d.from, env: normalizeEnv(d.from.env) } } : d))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },

  async getDocText(id: string): Promise<string | undefined> {
    return tx<string>(['content'], 'readonly', (t) => t.objectStore('content').get(id));
  },

  /** Creates (no id) or overwrites a saved document. Returns its metadata. */
  async saveDoc(name: string, text: string, id?: string | null, from?: SavedFrom | null): Promise<DocMeta> {
    const meta: DocMeta = {
      id: id ?? crypto.randomUUID(),
      name,
      size: text.length,
      updatedAt: Date.now(),
      from: from ?? null,
    };
    await tx(['docs', 'content'], 'readwrite', (t) => {
      t.objectStore('docs').put(meta, meta.id);
      t.objectStore('content').put(text, meta.id);
    });
    return meta;
  },

  async deleteDoc(id: string): Promise<void> {
    await tx(['docs', 'content'], 'readwrite', (t) => {
      t.objectStore('docs').delete(id);
      t.objectStore('content').delete(id);
    });
  },
};

const SETTINGS_KEY = 'json-compare:settings';

export interface Settings {
  fontSize: number;
  compare: boolean;
  sortKeys: boolean;
  autoFormat: boolean;
  /** Whether the second (right) pane is shown. */
  rightOpen: boolean;
  theme: 'light' | 'dark';
  /** Last Redis connection picked in a key search. */
  lastConnId?: string;
}

export const defaultSettings = (): Settings => ({
  fontSize: 13,
  compare: false,
  sortKeys: false,
  autoFormat: true,
  rightOpen: true,
  theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
});

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    // Comparing always starts switched off; it is turned on explicitly (toggle or "Compare with…").
    if (raw) return { ...defaultSettings(), ...JSON.parse(raw), compare: false };
  } catch {
    /* storage unavailable – fall through to defaults */
  }
  return defaultSettings();
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
