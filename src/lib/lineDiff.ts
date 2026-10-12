/**
 * Line based diff tuned for very large inputs (hundreds of thousands of lines).
 *
 *  1. Lines are interned to integer ids so comparisons are integer compares.
 *  2. Common prefix / suffix are trimmed (the typical "few edits" case is then
 *     almost free).
 *  3. The middle is solved with Myers' linear-space O(ND) algorithm.
 *  4. If two regions are so different that O(ND) would blow up, we fall back to
 *     anchoring on lines that are unique on both sides (patience style) and
 *     recurse on the gaps. The result is then flagged `approximate`.
 */

export interface DiffResult {
  /** Flat [aStart, aEnd, bStart, bEnd] per block. 0-based line indexes, end exclusive. */
  blocks: Int32Array;
  /** Flat [side(0=left,1=right), line0, startCol0, endCol0] per intra-line change. */
  inline: Int32Array;
  addedLines: number;
  removedLines: number;
  /** True if the heuristic fallback was used somewhere (diff may not be minimal). */
  approximate: boolean;
}

/** Marks a diagonal whose furthest point ran off the edit grid. */
const INVALID = -1e9;
const MAX_D_NORMAL = 6000;
const MAX_D_AFTER_BUDGET = 300;
const WORK_BUDGET = 3e8;
const MAX_FALLBACK_DEPTH = 400;
const MAX_INLINE_RANGES = 50_000;
const MAX_INLINE_BLOCK_LINES = 200;
const MAX_INLINE_LINE_LENGTH = 10_000;

export function diffTexts(a: string, b: string): DiffResult {
  if (a === b) {
    return {
      blocks: new Int32Array(0),
      inline: new Int32Array(0),
      addedLines: 0,
      removedLines: 0,
      approximate: false,
    };
  }
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  return diffLines(aLines, bLines);
}

export function diffLines(aLines: string[], bLines: string[]): DiffResult {
  const ids = new Map<string, number>();
  const A = internLines(aLines, ids);
  const B = internLines(bLines, ids);
  return diffInterned(aLines, bLines, A, B, ids.size);
}

/** Maps every line to a stable integer id (equal lines share an id). */
export function internLines(lines: string[], ids: Map<string, number>): Int32Array {
  const out = new Int32Array(lines.length);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    let id = ids.get(s);
    if (id === undefined) {
      id = ids.size;
      ids.set(s, id);
    }
    out[i] = id;
  }
  return out;
}

/**
 * Keeps the interned form of the two documents between diffs, so that when
 * only one side was edited the other one does not have to be re-split and
 * re-interned (that is where most of the time goes for multi-million line files).
 */
export class DiffSession {
  private ids = new Map<string, number>();
  private sides: Record<'a' | 'b', { key: number; lines: string[]; ids: Int32Array } | null> = { a: null, b: null };

  has(side: 'a' | 'b', key: number): boolean {
    return this.sides[side]?.key === key;
  }

  setText(side: 'a' | 'b', key: number, text: string): void {
    const lines = text.split('\n');
    this.compactIfBloated(lines.length);
    this.sides[side] = { key, lines, ids: internLines(lines, this.ids) };
  }

  run(): DiffResult {
    const { a, b } = this.sides;
    if (!a || !b) throw new Error('DiffSession.run: both sides are required');
    return diffInterned(a.lines, b.lines, a.ids, b.ids, this.ids.size);
  }

  reset(): void {
    this.ids = new Map();
    this.sides = { a: null, b: null };
  }

  /** The id table only grows while editing; rebuild it when mostly stale. */
  private compactIfBloated(incoming: number): void {
    const live = (this.sides.a?.lines.length ?? 0) + (this.sides.b?.lines.length ?? 0) + incoming;
    if (this.ids.size < 2_000_000 || this.ids.size < live * 2) return;
    this.ids = new Map();
    for (const side of ['a', 'b'] as const) {
      const cur = this.sides[side];
      if (cur) cur.ids = internLines(cur.lines, this.ids);
    }
  }
}

export function diffInterned(
  aLines: string[],
  bLines: string[],
  A: Int32Array,
  B: Int32Array,
  uniqueCount: number,
): DiffResult {
  const n = A.length;
  const m = B.length;

  const chA = new Uint8Array(n);
  const chB = new Uint8Array(m);
  let approximate = false;
  let work = 0;

  // Scratch for Myers (grown on demand) and patience fallback.
  let vf = new Int32Array(1024);
  let vb = new Int32Array(1024);
  let cntA: Int32Array | null = null;
  let cntB: Int32Array | null = null;
  let posA: Int32Array | null = null;

  const markA = (lo: number, hi: number): void => {
    for (let i = lo; i < hi; i++) chA[i] = 1;
  };
  const markB = (lo: number, hi: number): void => {
    for (let j = lo; j < hi; j++) chB[j] = 1;
  };

  /**
   * Finds the middle snake of A[lo1,hi1) vs B[lo2,hi2).
   * Returns [x0, y0, x1, y1] (relative to lo1/lo2) or null if D exceeded maxD.
   */
  const middleSnake = (
    lo1: number,
    hi1: number,
    lo2: number,
    hi2: number,
    maxD: number,
  ): [number, number, number, number] | null => {
    const N = hi1 - lo1;
    const M = hi2 - lo2;
    const delta = N - M;
    const odd = (delta & 1) === 1;
    const max = (N + M + 1) >> 1;
    const offset = max + 1;
    const size = 2 * max + 3;
    if (vf.length < size) {
      vf = new Int32Array(size * 2);
      vb = new Int32Array(size * 2);
    }
    vf[offset + 1] = 0;
    vb[offset + 1] = 0;

    for (let d = 0; d <= max; d++) {
      if (d > maxD || work > WORK_BUDGET * 2) return null;
      work += d + 1;

      // Forward
      for (let k = -d; k <= d; k += 2) {
        const idx = offset + k;
        let x: number;
        if (k === -d || (k !== d && vf[idx - 1] < vf[idx + 1])) x = vf[idx + 1];
        else x = vf[idx - 1] + 1;
        let y = x - k;
        if (x < 0 || x > N || y > M) {
          vf[idx] = INVALID;
          continue;
        }
        const x0 = x;
        const y0 = y;
        while (x < N && y < M && A[lo1 + x] === B[lo2 + y]) {
          x++;
          y++;
        }
        vf[idx] = x;
        if (odd && k >= delta - (d - 1) && k <= delta + (d - 1)) {
          if (x + vb[offset + delta - k] >= N) return [x0, y0, x, y];
        }
      }

      // Backward (coordinates reversed: x' = N - x)
      for (let k = -d; k <= d; k += 2) {
        const idx = offset + k;
        let x: number;
        if (k === -d || (k !== d && vb[idx - 1] < vb[idx + 1])) x = vb[idx + 1];
        else x = vb[idx - 1] + 1;
        let y = x - k;
        if (x < 0 || x > N || y > M) {
          vb[idx] = INVALID;
          continue;
        }
        const x0 = x;
        const y0 = y;
        while (x < N && y < M && A[hi1 - 1 - x] === B[hi2 - 1 - y]) {
          x++;
          y++;
        }
        vb[idx] = x;
        if (!odd && k >= delta - d && k <= delta + d) {
          if (x + vf[offset + delta - k] >= N) return [N - x, M - y, N - x0, M - y0];
        }
      }
    }
    return null;
  };

  const patience = (lo1: number, hi1: number, lo2: number, hi2: number, depth: number): void => {
    approximate = true;
    if (depth > MAX_FALLBACK_DEPTH) {
      markA(lo1, hi1);
      markB(lo2, hi2);
      return;
    }
    if (!cntA) {
      cntA = new Int32Array(uniqueCount);
      cntB = new Int32Array(uniqueCount);
      posA = new Int32Array(uniqueCount);
    }
    const ca = cntA, cb = cntB!, pa = posA!;
    for (let i = lo1; i < hi1; i++) {
      const id = A[i];
      ca[id]++;
      pa[id] = i;
    }
    for (let j = lo2; j < hi2; j++) cb[B[j]]++;

    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let j = lo2; j < hi2; j++) {
      const id = B[j];
      if (cb[id] === 1 && ca[id] === 1) {
        seqA.push(pa[id]);
        seqB.push(j);
      }
    }
    for (let i = lo1; i < hi1; i++) ca[A[i]] = 0;
    for (let j = lo2; j < hi2; j++) cb[B[j]] = 0;

    if (seqA.length === 0) {
      markA(lo1, hi1);
      markB(lo2, hi2);
      return;
    }

    // Longest increasing subsequence over seqA.
    const len = seqA.length;
    const tails = new Int32Array(len);
    const parent = new Int32Array(len).fill(-1);
    let size = 0;
    for (let k = 0; k < len; k++) {
      let lo = 0;
      let hi = size;
      const v = seqA[k];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seqA[tails[mid]] < v) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) parent[k] = tails[lo - 1];
      tails[lo] = k;
      if (lo === size) size++;
    }
    const lis: number[] = new Array(size);
    for (let k = tails[size - 1], p = size - 1; p >= 0; k = parent[k], p--) lis[p] = k;

    let curA = lo1;
    let curB = lo2;
    for (const k of lis) {
      solve(curA, seqA[k], curB, seqB[k], depth + 1);
      curA = seqA[k] + 1;
      curB = seqB[k] + 1;
    }
    solve(curA, hi1, curB, hi2, depth + 1);
  };

  const solve = (lo1: number, hi1: number, lo2: number, hi2: number, depth: number): void => {
    while (lo1 < hi1 && lo2 < hi2 && A[lo1] === B[lo2]) {
      lo1++;
      lo2++;
    }
    while (lo1 < hi1 && lo2 < hi2 && A[hi1 - 1] === B[hi2 - 1]) {
      hi1--;
      hi2--;
    }
    if (lo1 === hi1) {
      markB(lo2, hi2);
      return;
    }
    if (lo2 === hi2) {
      markA(lo1, hi1);
      return;
    }
    const maxD = work > WORK_BUDGET ? MAX_D_AFTER_BUDGET : MAX_D_NORMAL;
    const snake = middleSnake(lo1, hi1, lo2, hi2, maxD);
    if (!snake) {
      patience(lo1, hi1, lo2, hi2, depth);
      return;
    }
    const [x0, y0, x1, y1] = snake;
    solve(lo1, lo1 + x0, lo2, lo2 + y0, depth + 1);
    solve(lo1 + x1, hi1, lo2 + y1, hi2, depth + 1);
  };

  solve(0, n, 0, m, 0);

  // Collect blocks.
  const blocks: number[] = [];
  let removedLines = 0;
  let addedLines = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && !chA[i] && !chB[j]) {
      i++;
      j++;
      continue;
    }
    const si = i;
    const sj = j;
    while (i < n && chA[i]) i++;
    while (j < m && chB[j]) j++;
    blocks.push(si, i, sj, j);
    removedLines += i - si;
    addedLines += j - sj;
  }

  const inline = computeInline(aLines, bLines, blocks);
  return {
    blocks: Int32Array.from(blocks),
    inline,
    addedLines,
    removedLines,
    approximate,
  };
}

/** Intra-line highlights for blocks that replace N lines by N lines (value edits). */
function computeInline(aLines: string[], bLines: string[], blocks: number[]): Int32Array {
  const out: number[] = [];
  for (let k = 0; k < blocks.length && out.length / 4 < MAX_INLINE_RANGES; k += 4) {
    const aS = blocks[k];
    const aE = blocks[k + 1];
    const bS = blocks[k + 2];
    const bE = blocks[k + 3];
    const cnt = aE - aS;
    if (cnt === 0 || cnt !== bE - bS || cnt > MAX_INLINE_BLOCK_LINES) continue;
    for (let t = 0; t < cnt; t++) {
      const la = aLines[aS + t];
      const lb = bLines[bS + t];
      if (la.length > MAX_INLINE_LINE_LENGTH || lb.length > MAX_INLINE_LINE_LENGTH) continue;
      const min = Math.min(la.length, lb.length);
      let p = 0;
      while (p < min && la.charCodeAt(p) === lb.charCodeAt(p)) p++;
      let s = 0;
      while (s < min - p && la.charCodeAt(la.length - 1 - s) === lb.charCodeAt(lb.length - 1 - s)) s++;
      if (la.length - s > p) out.push(0, aS + t, p, la.length - s);
      if (lb.length - s > p) out.push(1, bS + t, p, lb.length - s);
    }
  }
  return Int32Array.from(out);
}
