/// <reference lib="webworker" />
import { DiffSession } from '../lib/lineDiff';
import type { DiffRequest, DiffResponse, DiffSide } from '../lib/protocol';

const session = new DiffSession();
const post = (msg: DiffResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<DiffRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'reset') {
      session.reset();
      post({ id: req.id, ok: true });
      return;
    }
    const sides: [DiffSide, 'a' | 'b'][] = [
      [req.a, 'a'],
      [req.b, 'b'],
    ];
    // Check first so we never half-update the cache when the main thread must resend.
    for (const [side, name] of sides) {
      if (side.text === undefined && !session.has(name, side.key)) {
        post({ id: req.id, ok: false, needText: true, message: 'diff cache miss' });
        return;
      }
    }
    for (const [side, name] of sides) {
      if (side.text !== undefined) session.setText(name, side.key, side.text);
    }
    const result = session.run();
    post({ id: req.id, ok: true, result }, [result.blocks.buffer, result.inline.buffer]);
  } catch (e) {
    post({ id: req.id, ok: false, message: String(e) });
  }
};
