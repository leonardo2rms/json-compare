/// <reference lib="webworker" />
import { diffTexts } from '../lib/lineDiff';
import type { DiffRequest, DiffResponse } from '../lib/protocol';

self.onmessage = (ev: MessageEvent<DiffRequest>) => {
  const { id, a, b } = ev.data;
  try {
    const result = diffTexts(a, b);
    const msg: DiffResponse = { id, ok: true, result };
    (self as unknown as Worker).postMessage(msg, [result.blocks.buffer, result.inline.buffer]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, message: String(e) } satisfies DiffResponse);
  }
};
