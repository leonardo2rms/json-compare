/**
 * Strict JSON parser + pretty printer.
 *
 * Unlike JSON.parse/JSON.stringify this keeps every number and string exactly
 * as written in the source (no precision loss on big integers, no changed
 * escapes), reports the exact offset of syntax errors, and can optionally sort
 * object keys so that key order does not show up as a difference.
 */

export class JsonSyntaxError extends Error {
  constructor(
    message: string,
    public offset: number,
  ) {
    super(message);
  }
}

/** Primitive = raw source text. Array = items. Obj = parallel raw keys / values. */
export interface ObjNode {
  keys: string[];
  vals: Node[];
}
export type Node = string | Node[] | ObjNode;

const MAX_DEPTH = 1500;

/**
 * Parses `text`. With `build = false` it only validates (no tree is built),
 * which is cheaper on memory for very large documents.
 */
export function parseJson(text: string, build = true): Node | undefined {
  const n = text.length;
  let i = 0;
  let depth = 0;

  const fail = (msg: string, pos = i): never => {
    throw new JsonSyntaxError(msg, pos);
  };

  const describe = (pos: number): string =>
    pos >= n ? 'end of input' : `'${text[pos]}'`;

  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 10 || c === 13 || c === 9) i++;
      else break;
    }
  };

  const str = (): string => {
    const start = i;
    i++; // opening quote
    for (;;) {
      if (i >= n) fail('Unterminated string', start);
      const c = text.charCodeAt(i);
      if (c === 34) {
        i++;
        return build ? text.slice(start, i) : '';
      }
      if (c === 92) {
        const e = text.charCodeAt(i + 1);
        if (e === 117) {
          for (let k = 2; k < 6; k++) {
            const h = text.charCodeAt(i + k);
            const hex =
              (h >= 48 && h <= 57) || (h >= 65 && h <= 70) || (h >= 97 && h <= 102);
            if (!hex) fail('Invalid unicode escape in string', i);
          }
          i += 6;
        } else if (
          e === 34 || e === 92 || e === 47 || e === 98 ||
          e === 102 || e === 110 || e === 114 || e === 116
        ) {
          i += 2;
        } else {
          fail('Invalid escape sequence in string', i);
        }
      } else if (c < 32) {
        fail('Control character in string (use \\n, \\t, …)', i);
      } else {
        i++;
      }
    }
  };

  const digits = (): void => {
    const s = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) i++;
      else break;
    }
    if (i === s) fail(`Expected digit but found ${describe(i)}`);
  };

  const num = (): string => {
    const start = i;
    if (text.charCodeAt(i) === 45) i++;
    if (text.charCodeAt(i) === 48) {
      i++;
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) fail('Leading zeros are not allowed in numbers');
    } else {
      digits();
    }
    if (text.charCodeAt(i) === 46) {
      i++;
      digits();
    }
    const e = text.charCodeAt(i);
    if (e === 101 || e === 69) {
      i++;
      const s = text.charCodeAt(i);
      if (s === 43 || s === 45) i++;
      digits();
    }
    return build ? text.slice(start, i) : '';
  };

  const lit = (word: string): string => {
    if (text.startsWith(word, i)) {
      i += word.length;
      return word;
    }
    return fail(`Unexpected token, expected '${word}'`);
  };

  const enter = (): void => {
    if (++depth > MAX_DEPTH) fail('Document is nested too deeply');
  };

  const object = (): Node => {
    enter();
    i++; // {
    const keys: string[] = [];
    const vals: Node[] = [];
    ws();
    if (text.charCodeAt(i) === 125) {
      i++;
      depth--;
      return build ? { keys, vals } : '';
    }
    for (;;) {
      ws();
      if (text.charCodeAt(i) !== 34) fail(`Expected property name but found ${describe(i)}`);
      const key = str();
      ws();
      if (text.charCodeAt(i) !== 58) fail(`Expected ':' but found ${describe(i)}`);
      i++;
      const v = value();
      if (build) {
        keys.push(key);
        vals.push(v);
      }
      ws();
      const c = text.charCodeAt(i);
      if (c === 44) {
        i++;
        continue;
      }
      if (c === 125) {
        i++;
        break;
      }
      fail(`Expected ',' or '}' but found ${describe(i)}`);
    }
    depth--;
    return build ? { keys, vals } : '';
  };

  const array = (): Node => {
    enter();
    i++; // [
    const items: Node[] = [];
    ws();
    if (text.charCodeAt(i) === 93) {
      i++;
      depth--;
      return build ? items : '';
    }
    for (;;) {
      const v = value();
      if (build) items.push(v);
      ws();
      const c = text.charCodeAt(i);
      if (c === 44) {
        i++;
        continue;
      }
      if (c === 93) {
        i++;
        break;
      }
      fail(`Expected ',' or ']' but found ${describe(i)}`);
    }
    depth--;
    return build ? items : '';
  };

  const value = (): Node => {
    ws();
    if (i >= n) fail('Unexpected end of input');
    const c = text.charCodeAt(i);
    switch (c) {
      case 123:
        return object();
      case 91:
        return array();
      case 34:
        return str();
      case 116:
        return lit('true');
      case 102:
        return lit('false');
      case 110:
        return lit('null');
      default:
        if (c === 45 || (c >= 48 && c <= 57)) return num();
        return fail(`Unexpected character ${describe(i)}`);
    }
  };

  // Skip a UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const root = value();
  ws();
  if (i < n) fail(`Unexpected data after end of JSON: ${describe(i)}`);
  return build ? root : undefined;
}

export interface FormatOptions {
  sortKeys?: boolean;
  /** Indent unit. Default: two spaces. */
  indent?: string;
}

function decodeKey(raw: string): string {
  return raw.indexOf('\\') === -1 ? raw.slice(1, -1) : (JSON.parse(raw) as string);
}

/** Pretty prints a tree produced by parseJson. */
export function formatNode(root: Node, opts: FormatOptions = {}): string {
  const unit = opts.indent ?? '  ';
  const sortKeys = !!opts.sortKeys;
  const pads: string[] = [''];
  const pad = (level: number): string => {
    while (pads.length <= level) pads.push(pads[pads.length - 1] + unit);
    return pads[level];
  };

  const chunks: string[] = [];
  let buf = '';
  const write = (s: string): void => {
    buf += s;
    if (buf.length > 1 << 16) {
      chunks.push(buf);
      buf = '';
    }
  };

  const emit = (node: Node, level: number): void => {
    if (typeof node === 'string') {
      write(node);
      return;
    }
    if (Array.isArray(node)) {
      const len = node.length;
      if (len === 0) {
        write('[]');
        return;
      }
      const inner = pad(level + 1);
      write('[\n');
      for (let k = 0; k < len; k++) {
        write(inner);
        emit(node[k], level + 1);
        write(k < len - 1 ? ',\n' : '\n');
      }
      write(pad(level) + ']');
      return;
    }
    const len = node.keys.length;
    if (len === 0) {
      write('{}');
      return;
    }
    let order: number[] | null = null;
    if (sortKeys && len > 1) {
      const decoded = node.keys.map(decodeKey);
      order = decoded.map((_, idx) => idx);
      order.sort((x, y) => (decoded[x] < decoded[y] ? -1 : decoded[x] > decoded[y] ? 1 : x - y));
    }
    const inner = pad(level + 1);
    write('{\n');
    for (let k = 0; k < len; k++) {
      const idx = order ? order[k] : k;
      write(inner);
      write(node.keys[idx]);
      write(': ');
      emit(node.vals[idx], level + 1);
      write(k < len - 1 ? ',\n' : '\n');
    }
    write(pad(level) + '}');
  };

  emit(root, 0);
  chunks.push(buf);
  return chunks.join('');
}

export function formatJson(text: string, opts: FormatOptions = {}): string {
  return formatNode(parseJson(text, true) as Node, opts);
}

/** 1-based line / column of an offset in `text`. */
export function offsetToPosition(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.min(offset, text.length);
  let idx = text.indexOf('\n');
  while (idx !== -1 && idx < end) {
    line++;
    lineStart = idx + 1;
    idx = text.indexOf('\n', lineStart);
  }
  return { line, column: end - lineStart + 1 };
}
