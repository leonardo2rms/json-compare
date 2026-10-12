import { describe, expect, it } from 'vitest';
import { crumbs, isGlob, mergeEntries, splitQuery, toRows } from './keyBrowse';
import type { BrowseEntry } from './redisTypes';

const e = (segment: string, o: Partial<BrowseEntry> = {}): BrowseEntry => ({ segment, path: '', folder: false, leaf: false, count: 1, ...o });

describe('splitQuery', () => {
  it('separates the finished levels from the text being typed', () => {
    expect(splitQuery('')).toEqual({ prefix: '', partial: '' });
    expect(splitQuery('off')).toEqual({ prefix: '', partial: 'off' });
    expect(splitQuery('offer:')).toEqual({ prefix: 'offer:', partial: '' });
    expect(splitQuery('offer:12')).toEqual({ prefix: 'offer:', partial: '12' });
    expect(splitQuery('a:b:c')).toEqual({ prefix: 'a:b:', partial: 'c' });
  });
});

describe('isGlob', () => {
  it('detects patterns', () => {
    expect(isGlob('user:*')).toBe(true);
    expect(isGlob('a?c')).toBe(true);
    expect(isGlob('user:12')).toBe(false);
  });
});

describe('toRows', () => {
  it('sorts naturally (2 before 10) and builds paths', () => {
    const rows = toRows('offer:', [e('10', { leaf: true }), e('2', { leaf: true }), e('x', { folder: true, count: 5 })]);
    expect(rows.map((r) => r.label)).toEqual(['2', '10', 'x:']);
    expect(rows.map((r) => r.path)).toEqual(['offer:2', 'offer:10', 'offer:x:']);
    expect(rows[2]).toMatchObject({ kind: 'folder', count: 5 });
  });
  it('gives a segment that is both key and folder two rows', () => {
    const rows = toRows('', [e('a', { leaf: true, folder: true, count: 3 })]);
    expect(rows.map((r) => [r.kind, r.path])).toEqual([
      ['leaf', 'a'],
      ['folder', 'a:'],
    ]);
  });
});

describe('mergeEntries', () => {
  it('adds counts and combines flags across scan batches', () => {
    const a = mergeEntries(new Map(), [e('offer', { folder: true, count: 10 })]);
    const b = mergeEntries(a, [e('offer', { folder: true, leaf: true, count: 4 }), e('product', { folder: true, count: 2 })]);
    expect(b.get('offer')).toMatchObject({ folder: true, leaf: true, count: 14 });
    expect(b.size).toBe(2);
  });
});

describe('crumbs', () => {
  it('builds the clickable path', () => {
    expect(crumbs('')).toEqual([{ label: 'All keys', value: '' }]);
    expect(crumbs('offer:12:')).toEqual([
      { label: 'All keys', value: '' },
      { label: 'offer', value: 'offer:' },
      { label: '12', value: 'offer:12:' },
    ]);
  });
});
