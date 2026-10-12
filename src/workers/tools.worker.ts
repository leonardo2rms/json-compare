/// <reference lib="webworker" />
import { formatNode, JsonSyntaxError, offsetToPosition, parseJson } from '../lib/jsonFormat';
import type { ToolsRequest, ToolsResponse } from '../lib/protocol';

function errorResponse(id: number, text: string, e: unknown): ToolsResponse {
  if (e instanceof JsonSyntaxError) {
    const { line, column } = offsetToPosition(text, e.offset);
    return { id, ok: false, error: { message: e.message, line, column } };
  }
  const msg = e instanceof RangeError ? 'Document is nested too deeply' : String(e);
  return { id, ok: false, error: { message: msg, line: 1, column: 1 } };
}

self.onmessage = (ev: MessageEvent<ToolsRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'format') {
      const tree = parseJson(req.text, true)!;
      const text = formatNode(tree, { sortKeys: req.sortKeys });
      (self as unknown as Worker).postMessage({ id: req.id, ok: true, text } satisfies ToolsResponse);
    } else {
      parseJson(req.text, false);
      (self as unknown as Worker).postMessage({ id: req.id, ok: true } satisfies ToolsResponse);
    }
  } catch (e) {
    (self as unknown as Worker).postMessage(errorResponse(req.id, req.text, e));
  }
};
