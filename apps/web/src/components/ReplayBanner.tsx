/**
 * Slim persistent banner for replay mode: says exactly which real drill the
 * console is showing, when it was recorded, and links its GitHub runner log.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { drillShortId, loadReplayData, type ReplayData } from '../api/replay/data';
import { useConsole } from '../state/ConsoleContext';

const when = (iso: string | null | undefined) => {
  if (!iso) return 'time not recorded';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });
};

export function ReplayBanner() {
  const { selectedId } = useConsole();
  const [data, setData] = useState<ReplayData | null>(null);
  useEffect(() => {
    let alive = true;
    void loadReplayData().then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, []);
  if (!data) return null;
  const b = data.drills.find((x) => x.run.networkId === selectedId) ?? data.drills[0];
  return (
    <div className="replaybar" role="note" aria-label="Replay mode">
      <span className="replaydot" aria-hidden />
      {b ? (
        <span>
          Replay of real drill <b className="mono-s">{drillShortId(b)}</b> · recorded {when(b.run.finishedAt ?? b.publishedAt)}
          {b.workflow?.url && (
            <>
              {' · '}
              <a href={b.workflow.url} target="_blank" rel="noreferrer">
                GitHub runner log ↗
              </a>
            </>
          )}
        </span>
      ) : (
        <span>Replay mode · {data.problems[0] ?? 'no drill published yet'}</span>
      )}
      <span className="replayhint">
        Read-only · <Link to="/live">Run a drill</Link>
      </span>
    </div>
  );
}
