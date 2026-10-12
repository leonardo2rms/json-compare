// Where does the time go when diffing two big documents? (dev helper)
import { readFileSync } from 'node:fs';
import { formatJson } from '../src/lib/jsonFormat';
import { diffLines } from '../src/lib/lineDiff';

const [fa, fb] = process.argv.slice(2);
const a = formatJson(readFileSync(fa, 'utf8'));
const b = formatJson(readFileSync(fb, 'utf8'));
const t = (label: string, f: () => unknown) => {
  const t0 = performance.now();
  const r = f();
  console.log(label.padEnd(24), (performance.now() - t0).toFixed(0).padStart(6), 'ms');
  return r;
};
const aL = t('split A', () => a.split('\n')) as string[];
const bL = t('split B', () => b.split('\n')) as string[];
t('intern A+B (Map)', () => {
  const m = new Map<string, number>();
  for (const l of aL) if (!m.has(l)) m.set(l, m.size);
  for (const l of bL) if (!m.has(l)) m.set(l, m.size);
});
t('full diffLines', () => diffLines(aL, bL));
