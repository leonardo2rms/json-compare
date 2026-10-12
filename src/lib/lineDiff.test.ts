import { describe, expect, it } from 'vitest';
import { diffLines, diffTexts } from './lineDiff';

/** Reference LCS length via DP. */
function lcsLen(a: string[], b: string[]): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length];
}

/** Rebuilds B from A + blocks and checks unchanged regions are really equal. */
function verify(a: string[], b: string[], blocks: Int32Array): void {
  let ia = 0;
  let ib = 0;
  const rebuilt: string[] = [];
  for (let k = 0; k < blocks.length; k += 4) {
    const [aS, aE, bS, bE] = [blocks[k], blocks[k + 1], blocks[k + 2], blocks[k + 3]];
    expect(aS - ia).toBe(bS - ib); // equal-length unchanged gap
    for (; ia < aS; ia++, ib++) {
      expect(a[ia]).toBe(b[ib]);
      rebuilt.push(a[ia]);
    }
    expect(aE).toBeGreaterThanOrEqual(aS);
    expect(bE).toBeGreaterThanOrEqual(bS);
    expect(aE - aS + (bE - bS)).toBeGreaterThan(0);
    for (; ib < bE; ib++) rebuilt.push(b[ib]);
    ia = aE;
  }
  for (; ia < a.length; ia++, ib++) {
    expect(a[ia]).toBe(b[ib]);
    rebuilt.push(a[ia]);
  }
  expect(ib).toBe(b.length);
  expect(rebuilt).toEqual(b);
}

describe('diffTexts', () => {
  it('returns nothing for identical text', () => {
    const r = diffTexts('a\nb\nc', 'a\nb\nc');
    expect(r.blocks.length).toBe(0);
    expect(r.addedLines + r.removedLines).toBe(0);
  });

  it('detects a changed line with inline range', () => {
    const r = diffTexts('{\n  "a": "foo",\n  "b": 1\n}', '{\n  "a": "bar",\n  "b": 1\n}');
    expect([...r.blocks]).toEqual([1, 2, 1, 2]);
    expect([...r.inline]).toEqual([0, 1, 8, 11, 1, 1, 8, 11]);
  });

  it('detects insertions and deletions', () => {
    expect([...diffTexts('a\nb\nc', 'a\nX\nY\nb\nc').blocks]).toEqual([1, 1, 1, 3]);
    expect([...diffTexts('a\nX\nY\nb\nc', 'a\nb\nc').blocks]).toEqual([1, 3, 1, 1]);
    expect([...diffTexts('', 'a').blocks]).toEqual([0, 1, 0, 1]);
  });
});

describe('diffLines (fuzz)', () => {
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };

  it('is correct and minimal on random inputs', () => {
    for (let t = 0; t < 1500; t++) {
      const alpha = 1 + rnd(6);
      const gen = (len: number) => Array.from({ length: len }, () => 'l' + rnd(alpha));
      const a = gen(rnd(40));
      const b = rnd(3) === 0 ? gen(rnd(40)) : mutate(a, alpha);
      const r = diffLines(a, b);
      verify(a, b, r.blocks);
      expect(r.approximate).toBe(false);
      const lcs = lcsLen(a, b);
      expect(r.removedLines).toBe(a.length - lcs);
      expect(r.addedLines).toBe(b.length - lcs);
    }
  });

  function mutate(a: string[], alpha: number): string[] {
    const b = a.slice();
    const edits = rnd(6);
    for (let e = 0; e < edits; e++) {
      const op = rnd(3);
      const pos = rnd(b.length + 1);
      if (op === 0) b.splice(pos, 0, 'n' + rnd(alpha));
      else if (op === 1) b.splice(pos, 1 + rnd(3));
      else if (pos < b.length) b[pos] = 'm' + rnd(alpha);
    }
    return b;
  }

  it('stays correct (but approximate) when the inputs are wildly different', () => {
    const a = Array.from({ length: 30000 }, (_, i) => (i % 3 === 0 ? `u${i}` : `s${i % 50}`));
    const b = Array.from({ length: 30000 }, (_, i) => (i % 3 === 0 ? `u${i}` : `t${i % 40}`));
    const r = diffLines(a, b);
    verify(a, b, r.blocks);
  });

  it('handles large inputs with few edits quickly', () => {
    const a = Array.from({ length: 400_000 }, (_, i) => `line ${i}`);
    const b = a.slice();
    b[1000] = 'changed';
    b.splice(250_000, 0, 'inserted');
    b.splice(399_000, 5);
    const t0 = performance.now();
    const r = diffLines(a, b);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.blocks.length / 4).toBe(3);
    expect(r.approximate).toBe(false);
  });
});
