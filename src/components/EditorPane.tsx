import { useEffect, useRef, useState, type ReactNode } from 'react';
import { JSON_LANG, monaco } from '../lib/monaco';
import type { JsonError } from '../lib/protocol';
import type { SourceInfo } from '../lib/redisTypes';
import type { PaneOrigin } from '../lib/storage';
import { formatBytes } from '../lib/format';

export type Side = 'left' | 'right';

export interface SideState {
  name: string;
  docId: string | null;
  unsaved: boolean;
  size: number;
  lines: number;
  status: 'idle' | 'busy' | 'valid' | 'error';
  busyLabel?: string;
  error?: JsonError;
  /** Redis origin of the content, if it was fetched from Redis. */
  source: SourceInfo | null;
  /** Set when the content is a library copy or a file (i.e. not live Redis data). */
  origin: PaneOrigin | null;
}

export interface EditorHandle {
  editor: monaco.editor.IStandaloneCodeEditor;
  model: monaco.editor.ITextModel;
}

interface Props {
  side: Side;
  label: string;
  state: SideState;
  fontSize: number;
  /** Optional row rendered under the header (Redis key picker). */
  sourceBar?: ReactNode;
  /** Shown under the key picker, e.g. "saved copy – not live data". */
  banner?: ReactNode;
  /** When set, a close button is shown that hides this pane. */
  onClose?: () => void;
  /** Colour-codes the pane by environment (e.g. env-prd). */
  envClass?: string;
  onReady: (handle: EditorHandle) => void;
  onNameChange: (name: string) => void;
  onOpenFile: (file: File) => void;
  onFormat: () => void;
  onSave: () => void;
  onDownload: () => void;
  onClear: () => void;
  onZoom: (delta: number) => void;
  onGoToError: () => void;
}

export function EditorPane(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const handlers = useRef(p);
  handlers.current = p;

  useEffect(() => {
    const host = hostRef.current!;
    const model = monaco.editor.createModel('', JSON_LANG);
    model.setEOL(monaco.editor.EndOfLineSequence.LF);
    const editor = monaco.editor.create(host, {
      model,
      fontSize: p.fontSize,
      lineHeight: 1.35,
      fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: 'off',
      renderLineHighlight: 'none',
      occurrencesHighlight: 'off',
      selectionHighlight: false,
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      links: false,
      colorDecorators: false,
      bracketPairColorization: { enabled: false },
      stickyScroll: { enabled: false },
      hover: { enabled: 'off' },
      glyphMargin: false,
      lineDecorationsWidth: 8,
      lineNumbersMinChars: 4,
      smoothScrolling: false,
      cursorSmoothCaretAnimation: 'off',
      mouseWheelZoom: false, // font size is shared between both panes, see onZoom
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
      overviewRulerBorder: false,
      accessibilitySupport: 'off',
    });

    // Ctrl/Cmd + wheel changes the shared font size.
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.current.onZoom(e.deltaY < 0 ? 1 : -1);
    };
    host.addEventListener('wheel', onWheel, { passive: false, capture: true });

    handlers.current.onReady({ editor, model });
    return () => {
      host.removeEventListener('wheel', onWheel, { capture: true });
      editor.dispose();
      model.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { state } = p;
  const empty = state.size === 0;

  const status = (() => {
    switch (state.status) {
      case 'busy':
        return <span className="status busy">{state.busyLabel ?? 'Working…'}</span>;
      case 'valid':
        return <span className="status ok">✓ Valid JSON</span>;
      case 'error':
        return (
          <button className="status err" onClick={p.onGoToError} title="Go to error">
            ✗ {state.error?.line}:{state.error?.column} {state.error?.message}
          </button>
        );
      default:
        return <span className="status">{empty ? 'Empty' : 'Checking…'}</span>;
    }
  })();

  return (
    <section
      className={`pane${dragging ? ' dragging' : ''}${p.envClass ? ' ' + p.envClass : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        const f = e.dataTransfer.files[0];
        if (f) {
          e.preventDefault();
          p.onOpenFile(f);
        }
      }}
    >
      <div className="pane-head">
        <span className={`pane-tag ${p.side}`}>{p.label}</span>
        <input
          className="name"
          value={state.name}
          spellCheck={false}
          onChange={(e) => p.onNameChange(e.target.value)}
          title="Document name (used for Save / Download)"
        />
        {state.unsaved && !empty && <span className="dot" title="Not saved to the library yet" />}
        <div className="spacer" />
        <button onClick={() => fileRef.current?.click()} title="Open a .json file (or drop one on this pane)">
          Open
        </button>
        <button onClick={p.onFormat} title="Pretty-print this pane">
          Format
        </button>
        <button onClick={p.onSave} title="Save to the library (Ctrl+S)">
          Save
        </button>
        <button onClick={p.onDownload} title="Download as a file">
          Download
        </button>
        <button onClick={p.onClear} title="Clear this pane">
          Clear
        </button>
        {p.onClose && (
          <button className="close-pane" onClick={p.onClose} title="Close this pane – the other one takes the whole screen" aria-label="Close this pane">
            ✕
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept=".json,.txt,application/json,text/plain"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) p.onOpenFile(f);
            e.target.value = '';
          }}
        />
      </div>
      {p.sourceBar}
      {p.banner}
      <div className="editor-wrap">
        <div ref={hostRef} className="editor" />
        {empty && state.status !== 'busy' && (
          <div className="empty-hint">
            Paste JSON here, drop a file, or click <b>Open</b>
          </div>
        )}
      </div>
      <div className="pane-foot">
        {status}
        <div className="spacer" />
        <span>{state.lines.toLocaleString()} lines</span>
        <span>{formatBytes(state.size)}</span>
      </div>
    </section>
  );
}
