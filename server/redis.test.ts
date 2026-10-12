import { describe, expect, it } from 'vitest';
import { escapeGlob, friendlyError, groupKeys, toMatchPattern, type Group } from './redis';

describe('toMatchPattern', () => {
  it('searches for "contains" when no glob characters are given', () => {
    expect(toMatchPattern('user:12')).toBe('*user:12*');
  });
  it('keeps explicit glob patterns', () => {
    expect(toMatchPattern('user:*:profile')).toBe('user:*:profile');
    expect(toMatchPattern('order:?')).toBe('order:?');
    expect(toMatchPattern('k[ab]')).toBe('k[ab]');
  });
  it('can treat glob characters literally', () => {
    expect(toMatchPattern('a*b', true)).toBe('*a\\*b*');
    expect(toMatchPattern('url:/s?q=x', true)).toBe('*url:/s\\?q=x*');
  });
  it('matches everything for an empty query', () => {
    expect(toMatchPattern('')).toBe('*');
    expect(toMatchPattern('   ')).toBe('*');
  });
});

describe('friendlyError', () => {
  it('explains common connection problems', () => {
    expect(friendlyError(new Error('WRONGPASS invalid username-password pair'))).toMatch(/wrong username or password/);
    expect(friendlyError(new Error('NOAUTH Authentication required.'))).toMatch(/requires a password/);
    expect(friendlyError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toMatch(/refused/);
    expect(friendlyError(Object.assign(new Error('x'), { code: 'ENOTFOUND', hostname: 'h.example' }))).toMatch(/h\.example/);
  });
});

describe('escapeGlob', () => {
  it('makes glob characters literal', () => {
    expect(escapeGlob('a*b?c[d]e\\f')).toBe('a\\*b\\?c\\[d\\]e\\\\f');
    expect(escapeGlob('plain:key')).toBe('plain:key');
  });
});

describe('groupKeys', () => {
  const run = (keys: string[], prefix = '') => {
    const groups = new Map<string, Group>();
    groupKeys(keys, prefix, ':', groups);
    return Object.fromEntries([...groups].map(([k, g]) => [k, { folder: g.folder, leaf: g.leaf, count: g.count }]));
  };
  const keys = ['ahwebshop:2024-01-01', 'ahwebshop:2024-01-02', 'offer:1', 'offer:2:details', 'offer:2:history', 'product:7', 'plain'];

  it('groups the top level by first segment', () => {
    expect(run(keys)).toEqual({
      ahwebshop: { folder: true, leaf: false, count: 2 },
      offer: { folder: true, leaf: false, count: 3 },
      product: { folder: true, leaf: false, count: 1 },
      plain: { folder: false, leaf: true, count: 1 },
    });
  });

  it('descends one level at a time', () => {
    expect(run(keys.filter((k) => k.startsWith('offer:')), 'offer:')).toEqual({
      '1': { folder: false, leaf: true, count: 1 },
      '2': { folder: true, leaf: false, count: 2 },
    });
    expect(run(['offer:2:details', 'offer:2:history'], 'offer:2:')).toEqual({
      details: { folder: false, leaf: true, count: 1 },
      history: { folder: false, leaf: true, count: 1 },
    });
  });

  it('marks a segment that is both a key and a folder', () => {
    expect(run(['a', 'a:b'])['a']).toEqual({ folder: true, leaf: true, count: 2 });
  });

  it('ignores keys outside the prefix and handles a trailing delimiter', () => {
    expect(run(['other:1', 'x:'], 'x:')).toEqual({ '': { folder: false, leaf: true, count: 1 } });
  });
});
