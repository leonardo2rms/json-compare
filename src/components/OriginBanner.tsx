import { ENV_LABEL } from '../lib/redisApi';
import { formatClock } from '../lib/format';
import type { ConnectionInfo } from '../lib/redisTypes';
import type { PaneOrigin } from '../lib/storage';

interface Props {
  origin: PaneOrigin;
  /** The pane has been edited since it was opened. */
  edited: boolean;
  connections: ConnectionInfo[];
  /** Fetch the current value of the key this copy came from. */
  onLoadLive: (connId: string, key: string) => void;
}

const when = (ts: number) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Makes it unmistakable that a pane does NOT show live Redis data: it is either
 * a saved library copy (snapshot) or a file from disk.
 */
export function OriginBanner({ origin, edited, connections, onLoadLive }: Props) {
  if (origin.kind === 'file') {
    return (
      <div className="origin-banner file" role="note">
        <span className="origin-chip">File</span>
        <span>
          Opened from disk: <b>{origin.fileName}</b>
        </span>
        <span className="muted">Not connected to Redis.</span>
      </div>
    );
  }

  const from = origin.from;
  const conn = from && connections.find((c) => c.id === from.connId);
  return (
    <div className="origin-banner library" role="note">
      <span className="origin-chip">Saved copy</span>
      <span>
        From the library, saved {when(origin.savedAt)}
        {edited && ' · edited since'}
      </span>
      {from ? (
        <span>
          · taken from <span className={`env-chip env-${from.env}`}>{ENV_LABEL[from.env]}</span> {from.connName} <code>{from.key}</code> at {formatClock(from.fetchedAt)}
        </span>
      ) : (
        <span className="muted">· not from Redis</span>
      )}
      <span className="muted">Not live data.</span>
      {from && (
        <>
          <span className="spacer" />
          <button
            disabled={!conn}
            onClick={() => onLoadLive(from.connId, from.key)}
            title={conn ? 'Replace this copy with the key’s current value from Redis' : 'That connection no longer exists'}
          >
            ⟳ Load current value from Redis
          </button>
        </>
      )}
    </div>
  );
}
