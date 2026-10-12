import { describe, expect, it } from 'vitest';
import { formatJson, JsonSyntaxError, offsetToPosition, parseJson } from './jsonFormat';

describe('formatJson', () => {
  it('pretty prints and matches JSON.stringify for ordinary data', () => {
    const data = {
      a: 1,
      b: [1, 2, { c: null, d: 'x\ny' }],
      e: {},
      f: [],
      g: 'ünï',
      h: -1.5e10,
      i: true,
    };
    expect(formatJson(JSON.stringify(data))).toBe(JSON.stringify(data, null, 2));
  });

  it('preserves big integers and number spelling exactly', () => {
    const src = '{"id":12345678901234567890,"x":1.0,"y":1E+5,"z":-0}';
    expect(formatJson(src)).toBe(
      '{\n  "id": 12345678901234567890,\n  "x": 1.0,\n  "y": 1E+5,\n  "z": -0\n}',
    );
  });

  it('keeps string escapes verbatim', () => {
    const src = '["\\u00e9","\\/","\\"q\\""]';
    expect(formatJson(src)).toBe('[\n  "\\u00e9",\n  "\\/",\n  "\\"q\\""\n]');
  });

  it('sorts keys recursively but not arrays', () => {
    const out = formatJson('{"b":1,"a":{"z":1,"y":[{"q":1,"p":2}, 3]}}', { sortKeys: true });
    expect(JSON.parse(out)).toEqual({ a: { y: [{ p: 2, q: 1 }, 3], z: 1 }, b: 1 });
    expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"b"'));
    expect(out.indexOf('"y"')).toBeLessThan(out.indexOf('"z"'));
    expect(out.indexOf('"p"')).toBeLessThan(out.indexOf('"q"'));
  });

  it('sorts by decoded key', () => {
    const out = formatJson('{"b":1,"\\u0061":2}', { sortKeys: true });
    expect(out.indexOf('\\u0061')).toBeLessThan(out.indexOf('"b"'));
  });

  it('is idempotent', () => {
    const once = formatJson('{"a":[1,{"b":2}],"c":"d"}', { sortKeys: true });
    expect(formatJson(once, { sortKeys: true })).toBe(once);
  });

  it('handles a BOM', () => {
    expect(formatJson('\uFEFF[1]')).toBe('[\n  1\n]');
  });
});

describe('parseJson errors', () => {
  const bad: [string, string][] = [
    ['', 'Unexpected end'],
    ['{', 'Expected property name'],
    ['{"a":1,}', 'Expected property name'],
    ['[1,]', 'Unexpected character'],
    ['[1 2]', "Expected ',' or ']'"],
    ['{"a" 1}', "Expected ':'"],
    ["{'a':1}", 'Expected property name'],
    ['"abc', 'Unterminated'],
    ['"a\nb"', 'Control character'],
    ['"\\x"', 'Invalid escape'],
    ['"\\u12G4"', 'Invalid unicode'],
    ['01', 'Leading zeros'],
    ['1.', 'Expected digit'],
    ['-', 'Expected digit'],
    ['tru', 'expected'],
    ['[] x', 'Unexpected data'],
    ['NaN', 'Unexpected character'],
  ];
  for (const [src, msg] of bad) {
    it(`rejects ${JSON.stringify(src)}`, () => {
      expect(() => parseJson(src)).toThrow(JsonSyntaxError);
      expect(() => parseJson(src)).toThrow(msg);
      expect(() => parseJson(src, false)).toThrow(JsonSyntaxError);
    });
  }

  it('agrees with JSON.parse on valid/invalid for fuzzed input', () => {
    const alphabet = ['{', '}', '[', ']', ',', ':', '"a"', '1', '-', '.', 'e', 'true', 'null', ' ', '"'];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 3000; t++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 12);
      for (let k = 0; k < len; k++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      let ref = true;
      try {
        JSON.parse(s);
      } catch {
        ref = false;
      }
      let mine = true;
      try {
        parseJson(s);
      } catch {
        mine = false;
      }
      expect(mine, s).toBe(ref);
    }
  });

  it('reports the offset', () => {
    try {
      parseJson('{\n  "a": 1,\n  "b": ?\n}');
      expect.unreachable();
    } catch (e) {
      const err = e as JsonSyntaxError;
      expect(offsetToPosition('{\n  "a": 1,\n  "b": ?\n}', err.offset)).toEqual({ line: 3, column: 8 });
    }
  });

  it('rejects absurd nesting instead of overflowing the stack', () => {
    expect(() => parseJson('['.repeat(20000) + ']'.repeat(20000))).toThrow('nested too deeply');
  });
});
