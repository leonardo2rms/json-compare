/**
 * Rough performance check on a ~20MB JSON document.
 *   npm run bench            (size in MB via first arg, default 20)
 */
import { diffTexts } from '../src/lib/lineDiff';
import { formatJson } from '../src/lib/jsonFormat';

const targetMb = Number(process.argv[2] ?? 20);
let seed = 1;
const rnd = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};

function makeRecord(i: number) {
  return {
    id: i,
    uuid: `${rnd(1e9).toString(16)}-${rnd(1e9).toString(16)}-${i}`,
    name: `User ${i}`,
    active: rnd(2) === 0,
    score: rnd(100000) / 100,
    tags: Array.from({ length: 1 + rnd(5) }, () => `tag${rnd(300)}`),
    address: { street: `${rnd(999)} Main St`, city: `City${rnd(500)}`, zip: String(10000 + rnd(89999)) },
    history: Array.from({ length: rnd(4) }, (_, k) => ({ at: 1700000000 + k * 86400, ok: rnd(2) === 0 })),
  };
}

const records: unknown[] = [];
let size = 0;
for (let i = 0; size < targetMb * 1024 * 1024; i++) {
  const r = makeRecord(i);
  records.push(r);
  size += JSON.stringify(r).length + 1;
}
const minifiedA = JSON.stringify({ records });
console.log(`minified A: ${(minifiedA.length / 1e6).toFixed(1)} MB, ${records.length} records`);

// B = A with some edits.
const recordsB = JSON.parse(minifiedA).records as ReturnType<typeof makeRecord>[];
for (let k = 0; k < 500; k++) recordsB[rnd(recordsB.length)].name = 'EDITED ' + k;
recordsB.splice(Math.floor(recordsB.length / 2), 3);
recordsB.splice(Math.floor(recordsB.length / 3), 0, makeRecord(-1) as never);
const minifiedB = JSON.stringify({ records: recordsB });

const time = <T>(label: string, fn: () => T): T => {
  const t0 = performance.now();
  const r = fn();
  console.log(`${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(6)} ms`);
  return r;
};

const fa = time('format A (minified→pretty)', () => formatJson(minifiedA));
const fb = time('format B', () => formatJson(minifiedB));
time('format A sorted keys', () => formatJson(minifiedA, { sortKeys: true }));
console.log(`pretty A: ${(fa.length / 1e6).toFixed(1)} MB, ${fa.split('\n').length} lines`);
const r = time('diff A vs B', () => diffTexts(fa, fb));
console.log(`blocks=${r.blocks.length / 4} +${r.addedLines} -${r.removedLines} approx=${r.approximate}`);

// Worst case: nearly everything differs.
const heavyB = fa.replace(/"score": (\d)/g, (_, d) => `"score": ${(Number(d) + 1) % 10}`);
const r2 = time('diff A vs heavily changed', () => diffTexts(fa, heavyB));
console.log(`blocks=${r2.blocks.length / 4} +${r2.addedLines} -${r2.removedLines} approx=${r2.approximate}`);
