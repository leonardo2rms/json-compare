import { describe, expect, it } from 'vitest';
import { friendlyError, toMatchPattern } from './redis';

describe('toMatchPattern', () => {
  it('searches for "contains" when no glob characters are given', () => {
    expect(toMatchPattern('user:12')).toBe('*user:12*');
  });
  it('keeps explicit glob patterns', () => {
    expect(toMatchPattern('user:*:profile')).toBe('user:*:profile');
    expect(toMatchPattern('order:?')).toBe('order:?');
    expect(toMatchPattern('k[ab]')).toBe('k[ab]');
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
