import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Written into dist/ by the Vite build; compared with the sources at server start. */
export const BUILD_INFO_FILE = 'build-info.json';

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/**
 * Fingerprint of everything that ends up in the web app (src/ and index.html).
 * Content based, so it does not depend on file timestamps (git checkouts, copies, …).
 */
export function hashSources(root: string): string {
  const h = createHash('sha256');
  const files = [join(root, 'index.html'), ...(existsSync(join(root, 'src')) ? [...walk(join(root, 'src'))] : [])];
  for (const f of files) {
    if (!existsSync(f)) continue;
    // Normalise line endings so a Windows checkout (CRLF) hashes the same at build and at start.
    h.update(f.slice(root.length)).update('\0').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).update('\0');
  }
  return h.digest('hex');
}

export type DistStatus = 'ok' | 'missing' | 'stale';

/** Is the built web app in `dist/` still the one these sources would produce? */
export function distStatus(root: string): DistStatus {
  const dist = join(root, 'dist');
  if (!existsSync(join(dist, 'index.html'))) return 'missing';
  // Without sources (e.g. a copied-out dist) there is nothing to compare with.
  if (!existsSync(join(root, 'src'))) return 'ok';
  try {
    const info = JSON.parse(readFileSync(join(dist, BUILD_INFO_FILE), 'utf8')) as { sourceHash?: string };
    return info.sourceHash === hashSources(root) ? 'ok' : 'stale';
  } catch {
    // No stamp: built by a version older than this check, so it cannot match the current sources.
    return 'stale';
  }
}
