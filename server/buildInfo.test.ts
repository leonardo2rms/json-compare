import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_INFO_FILE, distStatus, hashSources } from './buildInfo';

function project() {
  const root = mkdtempSync(join(tmpdir(), 'jc-build-'));
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'src', 'main.ts'), 'console.log(1)');
  writeFileSync(join(root, 'src', 'lib', 'a.ts'), 'export const a = 1;');
  return root;
}
const build = (root: string, hash = hashSources(root)) => {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'index.html'), 'built');
  writeFileSync(join(root, 'dist', BUILD_INFO_FILE), JSON.stringify({ sourceHash: hash }));
};

describe('distStatus', () => {
  it('is missing before the first build', () => {
    expect(distStatus(project())).toBe('missing');
  });
  it('is ok right after a build', () => {
    const root = project();
    build(root);
    expect(distStatus(root)).toBe('ok');
  });
  it('becomes stale when a source file changes, even a nested one', () => {
    const root = project();
    build(root);
    writeFileSync(join(root, 'src', 'lib', 'a.ts'), 'export const a = 2;');
    expect(distStatus(root)).toBe('stale');
  });
  it('becomes stale when a file is added', () => {
    const root = project();
    build(root);
    writeFileSync(join(root, 'src', 'new.ts'), '');
    expect(distStatus(root)).toBe('stale');
  });
  it('treats a build without a stamp (older version) as stale', () => {
    const root = project();
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), 'old build');
    expect(distStatus(root)).toBe('stale');
  });
  it('ignores line-ending differences (Windows checkouts)', () => {
    const root = project();
    writeFileSync(join(root, 'src', 'main.ts'), 'a\nb\n');
    const h = hashSources(root);
    writeFileSync(join(root, 'src', 'main.ts'), 'a\r\nb\r\n');
    expect(hashSources(root)).toBe(h);
  });
  it('trusts a dist that has no sources next to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'jc-build-'));
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'index.html'), 'x');
    expect(distStatus(root)).toBe('ok');
  });
});
