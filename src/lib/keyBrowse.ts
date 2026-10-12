import type { BrowseEntry } from './redisTypes';

/** Keys are treated as a tree split on this character: `offer:123:details`. */
export const DELIMITER = ':';
/** Choices shown per step; "show more" reveals this many extra. */
export const PAGE_SIZE = 10;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** `offer:12` -> prefix `offer:`, partial `12`. */
export function splitQuery(q: string): { prefix: string; partial: string } {
  const i = q.lastIndexOf(DELIMITER);
  return i === -1 ? { prefix: '', partial: q } : { prefix: q.slice(0, i + 1), partial: q.slice(i + 1) };
}

/** Text with glob characters is searched as a pattern (flat list) instead of browsed. */
export function isGlob(q: string): boolean {
  return /[*?[]/.test(q);
}

/** Merges a newly scanned batch into what is already known (counts add up, flags combine). */
export function mergeEntries(prev: Map<string, BrowseEntry>, incoming: BrowseEntry[]): Map<string, BrowseEntry> {
  const next = new Map(prev);
  for (const e of incoming) {
    const old = next.get(e.segment);
    next.set(
      e.segment,
      old
        ? { ...old, folder: old.folder || e.folder, leaf: old.leaf || e.leaf, count: old.count + e.count, type: e.type ?? old.type, ttlMs: e.ttlMs ?? old.ttlMs }
        : e,
    );
  }
  return next;
}

export interface Row {
  kind: 'folder' | 'leaf';
  /** What is shown: `offer:` for a folder, `123` for a key. */
  label: string;
  /** What goes into the box when chosen. */
  path: string;
  count?: number;
  type?: string;
  ttlMs?: number;
}

/** Natural-sorted rows for one level. A segment that is both a key and a folder gives two rows. */
export function toRows(prefix: string, entries: Iterable<BrowseEntry>): Row[] {
  const sorted = [...entries].sort((a, b) => collator.compare(a.segment, b.segment));
  const rows: Row[] = [];
  for (const e of sorted) {
    if (e.leaf) rows.push({ kind: 'leaf', label: e.segment === '' ? '(empty name)' : e.segment, path: prefix + e.segment, type: e.type, ttlMs: e.ttlMs });
    if (e.folder) rows.push({ kind: 'folder', label: e.segment + DELIMITER, path: prefix + e.segment + DELIMITER, count: e.count });
  }
  return rows;
}

/** Clickable path above the list: All keys › offer › 123 */
export function crumbs(prefix: string): { label: string; value: string }[] {
  const out = [{ label: 'All keys', value: '' }];
  let acc = '';
  for (const part of prefix.split(DELIMITER).slice(0, -1)) {
    acc += part + DELIMITER;
    out.push({ label: part === '' ? '(empty)' : part, value: acc });
  }
  return out;
}

export function describeCount(count: number, done: boolean): string {
  return `${done ? '' : '~'}${count.toLocaleString()}${done ? '' : '+'} ${count === 1 && done ? 'key' : 'keys'}`;
}
