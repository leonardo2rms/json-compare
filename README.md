# JSON Compare

A fast, client-side JSON comparison tool built for **large documents (20 MB+)**. Everything runs
in your browser – nothing is uploaded anywhere.

## Features

- **Side-by-side diff** with line highlighting, intra-line highlighting of changed values,
  striped filler rows that keep both panes aligned, and diff marks on the scrollbar.
- **Compare on/off** switch. Off = two independent editors (no diffing work is done).
- **Jump between differences** with ▲ Prev / ▼ Next (or `F7` / `Shift+F7`), with a `3 / 47` counter.
- **Adjustable font size** (`A−` / `A+` or `Ctrl` + mouse wheel) to fit more JSON on screen.
- **Never lose changes**
  - Both panes are *autosaved* to IndexedDB as you type and restored on reload.
  - **Save** (`Ctrl+S`) stores a named document in the **Library**; open it into either pane later.
  - **Download** exports a pane as a `.json` file; **Open** / drag-and-drop loads one.
- **Format** (pretty-print) with optional **Sort keys**, so key order is not reported as a difference.
  Numbers and strings are preserved exactly as written (no big-integer precision loss).
- Strict JSON validation with the exact line/column of the first error (click it to jump there).
- Light / dark theme.

## Tech stack

| Concern      | Choice                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| Language     | TypeScript                                                              |
| Build        | Vite                                                                    |
| UI           | React (toolbar and panes only)                                          |
| Editor       | Monaco Editor (virtualised rendering – 2M lines scroll smoothly)        |
| Diff / parse | Custom engine running in **Web Workers** (see below)                    |
| Persistence  | IndexedDB (documents) + localStorage (small settings)                   |
| Tests        | Vitest                                                                  |

## How it stays fast

- **Workers**: parsing, formatting, validating and diffing never run on the UI thread.
  Formatting/validation and diffing use separate workers so they do not block each other.
- **Own JSON parser/formatter** (`src/lib/jsonFormat.ts`): single pass, keeps raw number/string text.
- **Own line diff** (`src/lib/lineDiff.ts`): lines are interned to integers, common prefix/suffix
  are trimmed, and the rest is solved with Myers' linear-space O(ND) algorithm. If two files are
  so different that this would be slow, it falls back to anchoring on lines that are unique on both
  sides and flags the result as *approx.* in the toolbar.
- **Monaco's JSON language service is not loaded** (it would parse the whole document on the main
  thread); a small tokenizer provides highlighting instead.
- Typing re-runs the diff after a short debounce; stale results are discarded.

Measured with a 21 MB minified file pair (≈1.9 M lines each once pretty-printed) in headless
Chromium: open + format + validate + diff of both files ≈ 10 s, then ≈ 90 ms per "next difference"
and smooth scrolling. Memory is roughly 400 MB for the pair.

## Usage

```bash
npm install
npm run dev        # development server
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build
npm test           # unit tests (parser, formatter, diff)
npm run bench      # engine benchmark on a generated ~20 MB document
```

Tips:

- Paste over a whole pane, or open a file, and minified JSON is pretty-printed automatically
  (toggle with **Auto-format**). For very large inputs, **Open** / drag-and-drop is faster than
  pasting.
- Line-based diffing is run on the *formatted* text, so use **Format both** (and **Sort keys** if
  key order does not matter) before comparing documents produced by different tools.

## Project layout

```
src/
  App.tsx                 orchestration: load/format/validate/save/autosave/compare
  components/             EditorPane (Monaco wrapper), Library dialog
  lib/jsonFormat.ts       strict parser + pretty printer (+ tests)
  lib/lineDiff.ts         large-input line diff (+ tests)
  lib/diffView.ts         paints a diff onto two Monaco editors, scroll sync, navigation
  lib/storage.ts          IndexedDB + settings
  lib/workers.ts          promise-based worker clients
  workers/                tools.worker (format/validate), diff.worker
scripts/bench.ts          performance benchmark
```

## Roadmap

- Desktop app (Tauri wrapper around this same web app) for opening files straight from disk.
