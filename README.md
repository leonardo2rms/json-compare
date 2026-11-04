# JSON Compare

A fast JSON comparison tool built for **large documents (20 MB+)**. Parsing, formatting and diffing
run in your browser; the optional local server only talks to *your* Redis instances.

## Features

- **Side-by-side diff** with line highlighting, intra-line highlighting of changed values,
  striped filler rows that keep both panes aligned, and diff marks on the scrollbar.
- **Compare on/off** switch. It is **off when the app starts**; off = two independent editors (no diffing work is done). Choosing *Compare with same key in…* switches it on for you.
- **One or two panes.** Close the right pane (✕) and the left one takes the whole screen – handy for just inspecting a key. **＋ Second pane** brings it back; the choice is remembered.
- **Jump between differences** with ▲ Prev / ▼ Next (or `F7` / `Shift+F7`), with a `3 / 47` counter.
- **Adjustable font size** (`A−` / `A+` or `Ctrl` + mouse wheel) to fit more JSON on screen.
- **Never lose changes**
  - Both panes are *autosaved* to IndexedDB as you type and restored on reload.
  - **Save** (`Ctrl+S`) asks for a name (pre-filled, e.g. `user:1234 (prd, 2026-11-03 14:05)`) and stores the document in the **Library**; open it into either pane later. A copy saved from a Redis key remembers which connection and key it came from.
  - **Download** exports a pane as a `.json` file; **Open** / drag-and-drop loads one.
- **Format** (pretty-print) with optional **Sort keys**, so key order is not reported as a difference.
  Numbers and strings are preserved exactly as written (no big-integer precision loss).
- Strict JSON validation with the exact line/column of the first error (click it to jump there).
- **Load JSON straight from Redis** (read-only), see below.
- Light / dark theme.

## Redis (Azure Cache for Redis, local, …)

Instead of *Redis Insight → download → jq → VS Code*:

1. Start the app with the local server: `npm run dev` (or `npm start` for a production build).
2. Click **Redis** in the toolbar → **+ Add connection**.
   For Azure Cache for Redis: host `<name>.redis.cache.windows.net`, port `6380`, **TLS on**,
   password = the access key (username usually empty). Use **Test** to check it.
3. In a pane, pick the connection and click the key box. You don't need to remember how a key
   starts: it shows the **first level** of your keys (`ahwebshop:`, `offer:`, `product:`, … with
   their key counts) and you **drill down one level at a time**:
   - click a folder (`offer:`) to see the next level (`1`, `2`, `3`, … – first 10, then
     **Show 10 more**); click a key to load it. A breadcrumb (`All keys › offer`) takes you back up.
   - or keep typing: `of` narrows to `offer:`; **Tab** completes the highlighted/first choice,
     **↑↓** move, **Enter** opens a folder or loads a key.
   - paste an exact key and press **Enter** to load it directly.
   - text that isn't the start of any key falls back to "keys containing it"; text with `*`, `?`
     or `[` is a pattern search (e.g. `product:1*`).
   - focusing the box on an already loaded key lists its sibling keys.
   Keys are split on `:`. The value is fetched, **pretty-printed** and shown; big numbers/strings
   stay exact.
4. **Compare with same key in…** loads the same key from another connection (e.g. local → prod) into
   the other pane and diffs them. **⟳ Refresh** re-fetches a key.
5. Panes are colour-coded by environment (**prd is red**, acc orange, tst blue, local grey), and each
   pane remembers its source, so it survives a page reload.
6. **Live vs. copy:** a live Redis pane has a solid environment-coloured bar, a coloured env tag and a
   *Refresh* button. A document opened from the **Library** shows a dashed violet bar and a
   **SAVED COPY** banner (with where it was taken from and a *Load current value from Redis*
   button); a file from disk shows a grey **FILE** banner. Neither is live Redis data.

Notes:

- **Read-only.** The server can only run `SCAN`, `TYPE`, `PTTL`, `STRLEN`, `GET` and `JSON.GET`.
  Browsing uses `SCAN` (never `KEYS`) with a ~2 s budget per request; on a very large keyspace
  counts show as `~N+` and a "keep scanning" button appears until the whole keyspace has been seen.
- Supports **string** values holding JSON and **RedisJSON** (`JSON.GET`) documents. Other types
  (hash, list, …) are reported as unsupported.
- **Where secrets live:** connections (including passwords, for now) are saved by the local server in
  `~/.json-compare/connections.json` with owner-only permissions (override the folder with
  `JSON_COMPARE_HOME`). They are never sent to the browser.
- **Local-only server:** it listens on `127.0.0.1`, sends no CORS headers, rejects unexpected `Host`
  headers (DNS rebinding) and requires a custom header for changes. Port: `PORT` (default 8787).
- Environments are `local`, `tst`, `acc` and `prd`. Connection files written by older versions (`dev` / `staging` / `prod`) are translated automatically.
- Not supported yet: Redis Cluster mode (single endpoint only), Entra ID / Key Vault credentials.

### Adding other ways to authenticate (Entra ID, Key Vault)

All credential handling goes through `resolveAuth()` in `server/auth.ts`. To add a new method, add
an `auth.type` to `src/lib/redisTypes.ts`, handle it in `resolveAuth()` (it can be async, so it can
fetch a token or a Key Vault secret before connecting) and add the fields to the connection form.

## Tech stack

| Concern      | Choice                                                                  |
| ------------ | ----------------------------------------------------------------------- |
| Language     | TypeScript                                                              |
| Build        | Vite                                                                    |
| UI           | React (toolbar and panes only)                                          |
| Editor       | Monaco Editor (virtualised rendering – 2M lines scroll smoothly)        |
| Diff / parse | Custom engine running in **Web Workers** (see below)                    |
| Persistence  | IndexedDB (documents) + localStorage (small settings)                   |
| Redis access | Small local Node server: Fastify + ioredis (read-only)                  |
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

- The diff worker **caches the lines of each side**, so after an edit only the changed pane is
  re-split and re-processed.

Measured with a 21 MB minified file pair (≈1.9 M lines each once pretty-printed) in headless
Chromium: open + format + validate + diff of both files ≈ 7 s, ≈ 2 s to re-diff after an edit,
≈ 90 ms per "next difference", and smooth scrolling. The UI stays responsive while the workers run;
the one unavoidable pause is Monaco ingesting the formatted text (≈ 1–2 s for 35 MB).

## Usage

```bash
npm install
npm run dev        # development: open the address Vite prints (http://localhost:5173); API runs alongside on :8787
npm start          # builds first, then serves app + API together on http://127.0.0.1:8787
npm run dev:web    # UI only (no Redis)
npm run build      # type-check + production build into dist/
npm test           # unit tests (parser, formatter, diff, server config)
npm run bench      # engine benchmark on a generated ~20 MB document
```

Without the server (e.g. `npm run dev:web` or any static hosting) everything except Redis works.

Use **one** of the two: `npm run dev` (open :5173) *or* `npm start` (open :8787). In dev mode :8787 is API-only; the server
also refuses to serve a `dist/` build that no longer matches the sources (it shows "The built web app is out of date" with
the command to run) so you can never end up looking at an old version of the app.

**After pulling an update, restart the server** (stop `npm run dev` / `npm start` with Ctrl+C and start it again). The
web app and the local server are separate processes; if the server is still running old code the app shows a yellow
"local server is out of date" bar instead of silently misbehaving.

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
  lib/redisApi.ts         browser client for the local API
  workers/                tools.worker (format/validate), diff.worker
server/
  index.ts                local API (connections, key search, value fetch) + static app
  redis.ts                read-only Redis access (SCAN / GET / JSON.GET)
  config.ts, auth.ts      connection storage and credential resolution
scripts/bench.ts          performance benchmark
```

## Roadmap

- Entra ID / Key Vault authentication for Azure Cache for Redis.
- jq-style query bar, "ignore fields" for diffs, and a path-based diff summary.
- Snapshots of fetched keys (compare with "yesterday's" value) and pinned key pairs.
- Desktop app (Tauri wrapper around this same web app, with the server bundled).
