import { useEffect, useRef, useState } from 'react';
import type { SavedFrom } from '../lib/redisTypes';
import { ENV_LABEL } from '../lib/redisApi';
import { formatClock } from '../lib/format';

interface Props {
  /** Suggested name, already filled in (and selected, so typing replaces it). */
  defaultName: string;
  /** The pane is already linked to a library document: offer overwrite vs. new copy. */
  existing: boolean;
  /** Where the content came from, shown as context. */
  from: SavedFrom | null;
  onSave: (name: string, asCopy: boolean) => void;
  onCancel: () => void;
}

export function SaveDialog({ defaultName, existing, from, onSave, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [asCopy, setAsCopy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = () => {
    const n = name.trim();
    if (n) onSave(n, asCopy);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal small-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        role="dialog"
        aria-label="Save to library"
      >
        <div className="modal-head">
          <h2>Save to library</h2>
          <button type="button" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        </div>
        <label className="field">
          Name
          <input ref={inputRef} value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
        </label>
        {from && (
          <p className="muted small">
            From <span className={`env-chip env-${from.env}`}>{ENV_LABEL[from.env]}</span> {from.connName} · fetched {formatClock(from.fetchedAt)}. The saved copy remembers this.
          </p>
        )}
        {existing && (
          <label className="check">
            <input type="checkbox" checked={asCopy} onChange={(e) => setAsCopy(e.target.checked)} />
            Save as a new copy (keep the previously saved version)
          </label>
        )}
        <div className="form-actions">
          <div className="spacer" />
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
