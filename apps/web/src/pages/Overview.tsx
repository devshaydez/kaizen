/**
 * Overview (design import, T-3.6B; design match T-3.6C): live topology + network status over the
 * REAL monitoring snapshot. Start/stop are backend operations (FR-1).
 */

import { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import { Topology } from '../components/Topology';
import { Btn, ErrorBox, NoNet, Num, Stat, ease } from '../components/ui';
import { ACTIVE_FAULT_STATES, bestHeight, finalizedHeight, healthyCount, liveLinks } from '../lib/model';
import { formatUptime } from '../components/fmt';
import { eventLevel, eventText, eventTime, isNotable } from '../lib/eventText';
import { useConsole } from '../state/ConsoleContext';
import { REPLAY } from '../lib/mode';
import { useEventsContext } from '../state/EventsContext';

export function Overview() {
  const nav = useNavigate();
  const { vnet, network, openNode, refresh, detailError, networksError, networksLoaded, faults } = useConsole();
  const { events } = useEventsContext();
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  if (networksError) return <ErrorBox error={networksError} title="Cannot reach the Kaizen API" />;
  if (!networksLoaded) return <div className="sub">Loading networks…</div>;
  if (!vnet || !network) return detailError ? <ErrorBox error={detailError} /> : <NoNet />;

  const n = vnet.nodes.length;
  const healthy = healthyCount(vnet);
  const running = network.status === 'running' || network.status === 'degraded';
  const ok = running && healthy === n && n > 0;
  const label = ok ? 'Running' : running ? 'Degraded' : network.status === 'starting' ? 'Starting' : 'Not running';
  const headline = ok ? 'Network healthy' : running ? 'Network degraded' : network.status === 'starting' ? 'Network starting' : `Network ${network.status}`;
  const recent = events.filter((e) => isNotable(e) && (e.payload['networkId'] === network.id)).slice(-5).reverse();
  const live = liveLinks(vnet);
  const observed = vnet.edges.filter((e) => e.basis === 'observed').length;

  const op = async (kind: 'start' | 'stop') => {
    setBusy(kind);
    setError(null);
    try {
      const res = kind === 'start' ? await apiClient.startNetwork(network.id) : await apiClient.stopNetwork(network.id);
      if (!res.result.ok) setError(new ApiError(res.result.error?.message ?? `${kind} failed`, res.result.error?.code ?? 'OPERATION_FAILED', 200));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const vals = vnet.nodes.filter((v) => v.role === 'Validator');
  const valsUp = vals.filter((v) => v.state === 'running').length;
  const best = bestHeight(vnet);
  const fin = finalizedHeight(vnet);
  const uptimes = vnet.nodes.map((v) => v.sample?.uptimeMs).filter((x): x is number => typeof x === 'number');
  const uptime = running && uptimes.length ? formatUptime(Math.max(...uptimes)) : null;
  const openFaults = faults.filter((f) => f.mode === 'execute' && ACTIVE_FAULT_STATES.has(f.state));
  const word = ok ? 'healthy' : running ? 'degraded' : network.status === 'starting' ? 'starting' : network.status;

  return (
    <div className="ov">
      <div>
        <div className={`eyebrow ${ok ? '' : running ? 'bad' : ''}`}>
          {label}
          {uptime ? ` · up ${uptime}` : ''} · {network.name}
        </div>
        <h1 aria-label={headline}>
          Network <span className={ok || !running ? 'g' : 'gc'}>{word}</span>
        </h1>
        <p className="sub">Live network health, validator status, topology, and recent incidents.</p>
        <div className="actions">
          {running ? (
            <Btn tone="pri" arrow onClick={() => nav('/lab')}>
              Open Failure Lab
            </Btn>
          ) : (
            <Btn tone="pri" arrow onClick={() => void op('start')} disabled={busy !== null || network.status === 'starting'}>
              {busy === 'start' ? 'Starting… (health-gated)' : 'Start network'}
            </Btn>
          )}
          <Btn onClick={() => nav('/create')}>Create network</Btn>
          {running && (
            <button type="button" className="linkbtn" onClick={() => void op('stop')} disabled={busy !== null}>
              {busy === 'stop' ? 'Stopping…' : 'Stop network'}
            </button>
          )}
        </div>
        <ErrorBox error={error} />
      </div>
      <aside className="events ov-events" aria-label="Recent events">
        <div className="lab">Recent events</div>
        {recent.length === 0 && <div className="sub" style={{ paddingTop: 4 }}>{REPLAY ? 'Replay: no live event stream. The recorded fault evidence for this drill is under Incidents.' : 'No events for this network since the console opened.'}</div>}
        <AnimatePresence initial={false}>
          {recent.map((e) => (
            <motion.div key={e.seq} layout className={`evt ${eventLevel(e) === 'bad' ? 'hot' : ''}`} initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.3, ease }}>
              <span className={eventLevel(e)}>{eventText(e).split(`${network.name}-`).join('')}</span>
              <time>{eventTime(e)}</time>
            </motion.div>
          ))}
        </AnimatePresence>
      </aside>
      <div className="ov-stage">
        {REPLAY && <div className="sub">Replay topology · recorded drill data, not a live network</div>}
        <Topology net={vnet} onSelect={openNode} />
        <div className="topo-note">
          Select a node to inspect it · solid links observed by monitoring ({observed} via peer ids) · dashed red: not observed
        </div>
      </div>
      <div className="stats" style={{ gridColumn: '1 / -1', marginTop: 12 }}>
        <Stat label="Validators" sub={!running ? 'Network not running' : valsUp === vals.length ? 'All active' : `${vals.length - valsUp} not healthy`} tone={running && valsUp < vals.length ? 'bad' : undefined}>
          <Num v={valsUp} />/{vals.length}
        </Stat>
        <Stat label="Block height" sub={fin !== null && best !== null ? `Finalized #${fin.toLocaleString('en-US')} · ${Math.max(0, best - fin)} behind` : 'Not observed yet'}>
          <Num v={best} fmt={compactHeight} />
        </Stat>
        <Stat label="Peer links" sub={live === vnet.edges.length && live > 0 ? 'Full mesh' : `of ${vnet.edges.length} expected`} tone={running && live < vnet.edges.length ? 'bad' : undefined}>
          <Num v={live} />
        </Stat>
        <Stat label="Incidents" sub={openFaults.length ? `${openFaults[0]!.type} on ${openFaults[0]!.nodeName}` : 'None open'} tone={openFaults.length ? 'warn' : undefined}>
          <Num v={openFaults.length} />
        </Stat>
      </div>
    </div>
  );
}

/** 1284306 → "1.28M"; small heights stay exact. */
export function compactHeight(n: number): string {
  const r = Math.round(n);
  if (r >= 1_000_000) return `${(r / 1_000_000).toFixed(2)}M`;
  if (r >= 100_000) return `${(r / 1_000).toFixed(1)}k`;
  return r.toLocaleString('en-US');
}
