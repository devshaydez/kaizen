/**
 * Networks (T-3.6C): the REAL network list from GET /api/networks, with the
 * operator's selection. Creating goes to the Create screen; lifecycle
 * operations stay on Overview (backend-owned, FR-1).
 */

import { useNavigate } from 'react-router-dom';
import { Btn, Empty, ErrorBox } from '../components/ui';
import { useConsole } from '../state/ConsoleContext';

export function Networks() {
  const nav = useNavigate();
  const { networks, networksError, networksLoaded, selectedId, select } = useConsole();
  const uniqueNetworks = [...new Map(networks.map((network) => [network.id, network])).values()];
  if (networksError) return <ErrorBox error={networksError} title="Cannot reach the Kaizen API" />;
  if (!networksLoaded) return <div className="sub">Loading networks…</div>;
  if (!networks.length)
    return (
      <Empty
        title="No networks yet"
        text="Create a Portaldot network from a preset. Kaizen starts real portaldot_dev processes — or run `npx kaizen up` from the repo."
        action={
          <Btn tone="pri" arrow onClick={() => nav('/create')}>
            Create network
          </Btn>
        }
      />
    );
  return (
    <div className="pagehead">
      <div className="lab">
        {uniqueNetworks.length} network{uniqueNetworks.length === 1 ? '' : 's'} on this control plane
      </div>
      <h1>
        Your <span className="g">networks</span>
      </h1>
      <p className="sub">Select a network to inspect it, or create one from a preset.</p>
      <div className="tbl" role="table" aria-label="Networks" style={{ marginTop: 18, maxWidth: 1000 }}>

        <div className="tr th" role="row">
          <span>Network</span>
          <span>Runtime</span>
          <span />
        </div>
        {uniqueNetworks.map((n) => (
          <div key={n.id} role="row" className={`tr ${n.id === selectedId ? 'row on' : 'row'}`} onClick={() => select(n.id)}>
            <span className="network-main"><b>{n.name}</b><small>{n.preset} · {n.designatedTest ? 'designated test network' : 'not a test network'}</small></span>
            <span className="network-meta"><span className={`chip ${n.status === 'running' ? 'running' : n.status === 'starting' ? 'deploying' : n.status === 'degraded' ? 'bad' : 'pending'}`}>{n.status}</span><small>{n.nodeCount} nodes</small></span>
            <span>
              <Btn
                small
                tone={n.id === selectedId ? 'pri' : 'line'}
                onClick={() => {
                  select(n.id);
                  nav('/overview');
                }}
              >
                Open
              </Btn>
            </span>
          </div>
        ))}
      </div>
      <div className="actions" style={{ marginTop: 22 }}>
        <Btn tone="pri" arrow onClick={() => nav('/create')}>
          Create network
        </Btn>
      </div>
    </div>
  );
}
