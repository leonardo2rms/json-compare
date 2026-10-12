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

export async function diffInWorker(a: string, b: string): Promise<DiffResult> {
  const r = await differ.call((id) => ({ id, a, b }));
  if (!r.ok) throw new Error(r.message);
  return r.result;
}
