import ToolsWorker from '../workers/tools.worker?worker';
import DiffWorker from '../workers/diff.worker?worker';
import type { DiffResponse, JsonError, ToolsResponse } from './protocol';
import type { DiffResult } from './lineDiff';

class Rpc<Res extends { id: number }> {
  private nextId = 1;
  private pending = new Map<number, (r: Res) => void>();
  private worker: Worker;

  constructor(factory: new () => Worker) {
    this.worker = new factory();
    this.worker.onmessage = (ev: MessageEvent<Res>) => {
      const resolve = this.pending.get(ev.data.id);
      if (resolve) {
        this.pending.delete(ev.data.id);
        resolve(ev.data);
      }
    };
  }

  call(build: (id: number) => unknown): Promise<Res> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(build(id));
    });
  }
}

// Formatting / validating and diffing live in separate workers so that a slow
// validation never delays a diff (and vice versa).
const tools = new Rpc<ToolsResponse>(ToolsWorker);
const differ = new Rpc<DiffResponse>(DiffWorker);

export type FormatOutcome = { ok: true; text: string } | { ok: false; error: JsonError };

export async function formatInWorker(text: string, sortKeys: boolean): Promise<FormatOutcome> {
  const r = await tools.call((id) => ({ id, type: 'format', text, sortKeys }));
  return r.ok ? { ok: true, text: r.text ?? '' } : { ok: false, error: r.error };
}

export async function validateInWorker(text: string): Promise<JsonError | null> {
  const r = await tools.call((id) => ({ id, type: 'validate', text }));
  return r.ok ? null : r.error;
}

export interface DiffInput {
  /** Identifies this exact content (e.g. the editor model version id). */
  key: number;
  /** Returns the text; only called when the worker does not already have this version. */
  getText: () => string;
}

const sentKeys: { a: number | null; b: number | null } = { a: null, b: null };

/**
 * Diffs two documents. The worker keeps each side's lines between calls, so an
 * unchanged side is neither re-read from the editor nor re-sent / re-processed.
 */
export async function diffInWorker(a: DiffInput, b: DiffInput): Promise<DiffResult> {
  for (const attempt of [0, 1]) {
    const resend = attempt === 1;
    const needA = resend || sentKeys.a !== a.key;
    const needB = resend || sentKeys.b !== b.key;
    const r = await differ.call((id) => ({
      id,
      type: 'diff',
      a: { key: a.key, text: needA ? a.getText() : undefined },
      b: { key: b.key, text: needB ? b.getText() : undefined },
    }));
    if (r.ok && r.result) {
      sentKeys.a = a.key;
      sentKeys.b = b.key;
      return r.result;
    }
    if (!r.ok && r.needText && !resend) {
      sentKeys.a = sentKeys.b = null;
      continue;
    }
    throw new Error(r.ok ? 'empty diff response' : r.message);
  }
  throw new Error('diff failed');
}

/** Frees the worker's cached copies of both documents (e.g. when comparing is turned off). */
export async function resetDiffWorker(): Promise<void> {
  sentKeys.a = sentKeys.b = null;
  await differ.call((id) => ({ id, type: 'reset' }));
}
