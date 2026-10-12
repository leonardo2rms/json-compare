import { monaco } from './monaco';
import type { DiffResult } from './lineDiff';

type Editor = monaco.editor.IStandaloneCodeEditor;

/** Above this many height-compensating filler zones we skip alignment. */
const MAX_ZONES = 20_000;

const RED = 'rgba(248, 81, 73, 0.85)';
const GREEN = 'rgba(63, 185, 80, 0.85)';

/**
 * Paints a precomputed diff onto two plain Monaco editors:
 *  - whole-line backgrounds + overview-ruler marks for changed blocks
 *  - intra-line highlights for value edits
 *  - filler view zones so both sides stay line-aligned
 *  - synchronised scrolling
 * Monaco's own diff editor is not used because its (main-thread) diff
 * algorithm can't cope with 20MB inputs.
 */
export class DiffView {
  result: DiffResult | null = null;
  /** Index of the block that "next/previous" are relative to (-1 = none). */
  current = -1;
  alignmentSkipped = false;

  private leftDeco: monaco.editor.IEditorDecorationsCollection;
  private rightDeco: monaco.editor.IEditorDecorationsCollection;
  private leftCur: monaco.editor.IEditorDecorationsCollection;
  private rightCur: monaco.editor.IEditorDecorationsCollection;
  private zones: { editor: Editor; id: string }[] = [];
  private syncOn = false;
  private disposables: monaco.IDisposable[] = [];

  constructor(
    private left: Editor,
    private right: Editor,
  ) {
    this.leftDeco = left.createDecorationsCollection();
    this.rightDeco = right.createDecorationsCollection();
    this.leftCur = left.createDecorationsCollection();
    this.rightCur = right.createDecorationsCollection();

    const sync = (from: Editor, to: Editor) =>
      from.onDidScrollChange((e) => {
        if (!this.syncOn || !(e.scrollTopChanged || e.scrollLeftChanged)) return;
        const top = from.getScrollTop();
        const leftPos = from.getScrollLeft();
        if (to.getScrollTop() !== top || to.getScrollLeft() !== leftPos) {
          to.setScrollPosition({ scrollTop: top, scrollLeft: leftPos }, monaco.editor.ScrollType.Immediate);
        }
      });
    this.disposables.push(sync(left, right), sync(right, left));
  }

  get blockCount(): number {
    return this.result ? this.result.blocks.length / 4 : 0;
  }

  /** Paints a new diff. Keeps the "current" marker near where it was. */
  apply(result: DiffResult): void {
    const keepLine = this.current >= 0 && this.result ? this.result.blocks[this.current * 4 + 2] : -1;
    this.clearPaint();
    this.result = result;
    this.syncOn = true;

    const { blocks, inline } = result;
    const count = blocks.length / 4;
    const ld: monaco.editor.IModelDeltaDecoration[] = [];
    const rd: monaco.editor.IModelDeltaDecoration[] = [];

    for (let k = 0; k < count; k++) {
      const aS = blocks[k * 4], aE = blocks[k * 4 + 1], bS = blocks[k * 4 + 2], bE = blocks[k * 4 + 3];
      if (aE > aS) {
        ld.push({
          range: new monaco.Range(aS + 1, 1, aE, 1),
          options: {
            isWholeLine: true,
            className: 'dv-line-del',
            linesDecorationsClassName: 'dv-gutter-del',
            overviewRuler: { color: RED, position: monaco.editor.OverviewRulerLane.Full },
          },
        });
      }
      if (bE > bS) {
        rd.push({
          range: new monaco.Range(bS + 1, 1, bE, 1),
          options: {
            isWholeLine: true,
            className: 'dv-line-add',
            linesDecorationsClassName: 'dv-gutter-add',
            overviewRuler: { color: GREEN, position: monaco.editor.OverviewRulerLane.Full },
          },
        });
      }
    }
    for (let k = 0; k < inline.length; k += 4) {
      const side = inline[k];
      const line = inline[k + 1] + 1;
      (side === 0 ? ld : rd).push({
        range: new monaco.Range(line, inline[k + 2] + 1, line, inline[k + 3] + 1),
        options: { className: side === 0 ? 'dv-inline-del' : 'dv-inline-add' },
      });
    }
    this.leftDeco.set(ld);
    this.rightDeco.set(rd);

    this.alignmentSkipped = count > MAX_ZONES;
    if (!this.alignmentSkipped) this.addZones(blocks, count);

    this.current = keepLine >= 0 ? this.indexAtOrAfter(keepLine) : -1;
    this.paintCurrent();
  }

  /** Removes all diff visuals (comparator off). */
  clear(): void {
    this.clearPaint();
    this.result = null;
    this.current = -1;
    this.syncOn = false;
  }

  dispose(): void {
    this.clear();
    this.disposables.forEach((d) => d.dispose());
  }

  next(): number {
    const n = this.blockCount;
    if (!n) return -1;
    return this.goTo(this.current < 0 ? this.firstVisibleIndex() : (this.current + 1) % n);
  }

  prev(): number {
    const n = this.blockCount;
    if (!n) return -1;
    return this.goTo(this.current < 0 ? n - 1 : (this.current - 1 + n) % n);
  }

  goTo(index: number): number {
    if (!this.result || index < 0 || index >= this.blockCount) return -1;
    this.current = index;
    this.paintCurrent();
    const b = this.result.blocks;
    const aS = b[index * 4], aE = b[index * 4 + 1], bS = b[index * 4 + 2], bE = b[index * 4 + 3];
    // Reveal on whichever side has lines; scroll sync moves the other one.
    if (aE > aS) {
      this.left.revealLinesInCenter(aS + 1, aE, monaco.editor.ScrollType.Immediate);
      this.left.setPosition({ lineNumber: aS + 1, column: 1 });
    } else {
      this.right.revealLinesInCenter(bS + 1, bE, monaco.editor.ScrollType.Immediate);
      this.right.setPosition({ lineNumber: bS + 1, column: 1 });
    }
    return index;
  }

  /** First block at or below the top of the right editor's viewport. */
  private firstVisibleIndex(): number {
    const top = this.right.getVisibleRanges()[0]?.startLineNumber ?? 1;
    return Math.min(this.indexAtOrAfter(top - 1), this.blockCount - 1);
  }

  /** Index of the first block whose right-side start is >= line0 (clamped). */
  private indexAtOrAfter(line0: number): number {
    const b = this.result!.blocks;
    let lo = 0;
    let hi = this.blockCount;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid * 4 + 2] < line0) lo = mid + 1;
      else hi = mid;
    }
    return Math.min(lo, this.blockCount - 1);
  }

  private paintCurrent(): void {
    this.leftCur.clear();
    this.rightCur.clear();
    if (!this.result || this.current < 0) return;
    const b = this.result.blocks;
    const k = this.current * 4;
    const mark = (aEnd: number, aStart: number): monaco.editor.IModelDeltaDecoration[] =>
      aEnd > aStart
        ? [{ range: new monaco.Range(aStart + 1, 1, aEnd, 1), options: { isWholeLine: true, className: 'dv-current' } }]
        : [];
    this.leftCur.set(mark(b[k + 1], b[k]));
    this.rightCur.set(mark(b[k + 3], b[k + 2]));
  }

  private addZones(blocks: Int32Array, count: number): void {
    const make = (): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'dv-filler';
      return el;
    };
    const leftSpecs: { after: number; h: number }[] = [];
    const rightSpecs: { after: number; h: number }[] = [];
    for (let k = 0; k < count; k++) {
      const aN = blocks[k * 4 + 1] - blocks[k * 4];
      const bN = blocks[k * 4 + 3] - blocks[k * 4 + 2];
      if (aN < bN) leftSpecs.push({ after: blocks[k * 4 + 1], h: bN - aN });
      else if (bN < aN) rightSpecs.push({ after: blocks[k * 4 + 3], h: aN - bN });
    }
    const add = (editor: Editor, specs: { after: number; h: number }[]) =>
      editor.changeViewZones((acc) => {
        for (const s of specs) {
          const id = acc.addZone({ afterLineNumber: s.after, heightInLines: s.h, domNode: make() });
          this.zones.push({ editor, id });
        }
      });
    add(this.left, leftSpecs);
    add(this.right, rightSpecs);
  }

  private clearPaint(): void {
    this.leftDeco.clear();
    this.rightDeco.clear();
    this.leftCur.clear();
    this.rightCur.clear();
    for (const editor of [this.left, this.right]) {
      const ids = this.zones.filter((z) => z.editor === editor).map((z) => z.id);
      if (ids.length) editor.changeViewZones((acc) => ids.forEach((id) => acc.removeZone(id)));
    }
    this.zones = [];
    this.alignmentSkipped = false;
  }
}
