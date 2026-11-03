import { useEffect, useState } from 'react';
import { storage, type DocMeta } from '../lib/storage';
import { formatBytes, formatClock } from '../lib/format';
import { ENV_LABEL } from '../lib/redisApi';
import type { Side } from './EditorPane';

interface Props {
  onClose: () => void;
  onLoad: (side: Side, doc: DocMeta) => void;
  onError: (msg: string) => void;
}

export function Library({ onClose, onLoad, onError }: Props) {
  const [docs, setDocs] = useState<DocMeta[] | null>(null);

  const refresh = () =>
    storage
      .listDocs()
      .then(setDocs)
      .catch((e) => {
        onError(`Could not read the library: ${e}`);
        setDocs([]);
      });

  useEffect(() => {
    void refresh();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Saved JSON documents">
        <div className="modal-head">
          <h2>Saved documents</h2>
          <button onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {docs === null ? (
          <p className="muted">Loading…</p>
        ) : docs.length === 0 ? (
          <p className="muted">
            Nothing saved yet. Use <b>Save</b> on a pane to keep a document here. (Your two panes are also autosaved, so a
            refresh never loses edits.)
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Taken from</th>
                <th>Size</th>
                <th>Saved</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="doc-name">{d.name}</td>
                  <td className="small">
                    {d.from ? (
                      <>
                        <span className={`env-chip env-${d.from.env}`}>{ENV_LABEL[d.from.env]}</span> {d.from.connName}
                        <div className="muted">
                          <code>{d.from.key}</code> · {formatClock(d.from.fetchedAt)}
                        </div>
                      </>
                    ) : (
                      <span className="muted">file / pasted</span>
                    )}
                  </td>
                  <td>{formatBytes(d.size)}</td>
                  <td>{new Date(d.updatedAt).toLocaleString()}</td>
                  <td className="actions">
                    <button onClick={() => onLoad('left', d)}>Open left</button>
                    <button onClick={() => onLoad('right', d)}>Open right</button>
                    <button
                      className="danger"
                      onClick={() => {
                        if (confirm(`Delete “${d.name}” from the library?`)) {
                          storage.deleteDoc(d.id).then(refresh, (e) => onError(`Delete failed: ${e}`));
                        }
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
