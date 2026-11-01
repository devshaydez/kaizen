/**
 * Node drawer (design import, T-3.6B): REAL node detail (GET node →
 * record + latest sample + health), real log tail, real start/stop.
 * Diagnostics are evaluated from the fetched sample — never scripted.
 * Restart is a planned engine operation and is labelled as such.
 */

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type { NodeDetailResponse } from '../api/types';
import { useConsole } from '../state/ConsoleContext';
import { useAsync, useInterval } from '../state/useAsync';
import type { VNet, VNode } from '../lib/model';
import { Btn, ErrorBox, Seg, ease } from './ui';
import { formatUptime, shortId } from './fmt';
import { REPLAY } from '../lib/mode';

export interface DiagCheck {
  l: string;
  ok: boolean;
  detail: string;
}

/** Diagnostics derived ONLY from the latest real sample + health report. */
export function diagnose(detail: NodeDetailResponse): DiagCheck[] {
  const { node, sample, health } = detail;
  const expected = node.expectedPeers ?? 0;
  const peers = sample?.peers?.count ?? sample?.health?.peers ?? null;
  return [
    { l: 'Process running', ok: node.status === 'running', detail: `status ${node.status}${node.pid ? ` · pid ${node.pid}` : ''}` },
    { l: 'RPC reachable', ok: sample?.rpc.reachable === true, detail: sample ? (sample.rpc.reachable ? 'answered' : (sample.rpc.error ?? 'no answer')) : 'no sample yet' },
    {
      l: 'Peers connected',
      ok: peers !== null && peers >= expected,
      detail: peers === null ? 'not observed' : `${peers} of ${expected} expected`,
    },
    {
      l: 'Health state',
      ok: health?.state === 'healthy',
      detail: health ? `${health.state}${health.reasons.length ? ` — ${health.reasons.join('; ')}` : ''}` : 'not evaluated yet',
    },
    {
      l: 'Not syncing',
      ok: sample?.health?.isSyncing === false,
      detail: sample?.health ? (sample.health.isSyncing ? 'major sync in progress' : 'in sync') : 'not observed',
    },
  ];
}

const WARN_RE = /\b(WARN|ERROR|warn|error|Error)\b/;

function DrawerBody({ v, net }: { v: VNode; net: VNet }) {
  const nav = useNavigate();
  const { closeNode, refresh } = useConsole();
  const [lvl, setLvl] = useState<'all' | 'warn'>('all');
  const [q, setQ] = useState('');
  const [peersOpen, setPeersOpen] = useState(true);
  const [diag, setDiag] = useState<DiagCheck[] | null>(null);
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [opError, setOpError] = useState<ApiError | null>(null);
  const networkId = net.network.id;
  const detail = useAsync(() => apiClient.getNode(networkId, v.id), [networkId, v.id]);
  const logs = useAsync(() => apiClient.nodeLogs(networkId, v.id), [networkId, v.id]);
  const live = v.record.status === 'running';
  useInterval(() => {
    detail.reload();
    logs.reload();
  }, live ? 5_000 : null);

  const lines = useMemo(() => {
    const all = logs.data?.lines ?? [];
    return all
      .filter((l) => (lvl === 'all' || WARN_RE.test(l)) && l.toLowerCase().includes(q.toLowerCase()))
      .slice(-200)
      .reverse();
  }, [logs.data, lvl, q]);

  const neighbours = net.edges
    .filter((e) => e.a === v.id || e.b === v.id)
    .map((e) => ({ other: net.nodes.find((x) => x.id === (e.a === v.id ? e.b : e.a)), edge: e }));

  const op = async (kind: 'start' | 'stop') => {
    setBusy(kind);
    setOpError(null);
    try {
      const res = kind === 'start' ? await apiClient.startNode(networkId, v.id) : await apiClient.stopNode(networkId, v.id);
      if (!res.result.ok) setOpError(new ApiError(res.result.error?.message ?? `${kind} failed`, res.result.error?.code ?? 'OPERATION_FAILED', 200));
    } catch (e) {
      setOpError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(null);
      refresh();
      detail.reload();
    }
  };

  const sample = detail.data?.sample ?? v.sample;
  const tone = v.state === 'offline' ? 'bad' : v.state === 'running' ? 'ok' : 'warn';
  return (
    <motion.div className="dwrap" exit={{ opacity: 1 }}>
      <motion.div className="scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.25 }} onClick={closeNode} />
      <motion.aside className="drawer glass" role="dialog" aria-label={v.name} initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ duration: 0.38, ease }}>
        <div className="dh">
          <div>
            <div className="lab">
              {v.role}
              {v.record.wellKnownKey ? ` · //${v.record.wellKnownKey}` : ''}
            </div>
            <h2>{v.name}</h2>
          </div>
          <button type="button" className="x" aria-label="Close" onClick={closeNode}>
            ×
          </button>
        </div>
        <div className="facts">
          <div>
            <span>Status</span>
            <b className={tone}>{v.stateLabel}</b>
          </div>
          <div>
            <span>Block height</span>
            <b>{v.height !== null ? `#${v.height.toLocaleString('en-US')}` : '—'}</b>
          </div>
          <div>
            <span>Finalized</span>
            <b>{v.finalized !== null ? `#${v.finalized.toLocaleString('en-US')}` : '—'}</b>
          </div>
          <div>
            <span>RPC</span>
            <b className={sample?.rpc.reachable ? '' : 'bad'}>{sample ? (sample.rpc.reachable ? 'Reachable' : 'Unreachable') : '—'}</b>
          </div>
          <div>
            <span>Uptime</span>
            <b>{formatUptime(sample?.uptimeMs)}</b>
          </div>
          <div>
            <span>Peers</span>
            <b>
              {v.peers ?? '—'} / {v.expectedPeers}
            </b>
          </div>
          <div className="wide">
            <span>Peer ID</span>
            <b className="mono-s" title={v.peerId ?? undefined}>{v.peerId ?? (REPLAY ? 'not recorded in replay' : 'not derivable (no bootnode multiaddr references this node)')}</b>
          </div>
          <div className="wide">
            <span>Ports</span>
            {REPLAY && !v.record.ports.rpc ? (
              <b className="mono-s">not recorded in replay</b>
            ) : (
              <b className="mono-s">
                p2p {v.record.ports.p2p} · rpc {v.record.ports.rpc} · ws {v.record.ports.ws}
                {v.record.ports.prometheus ? ` · prometheus ${v.record.ports.prometheus}` : ''}
              </b>
            )}
          </div>
          {v.activeFault && (
            <div className="wide">
              <span>Active fault</span>
              <b className="warn">
                {v.activeFault.type} · {v.activeFault.state} · {shortId(v.activeFault.id, 14)}
              </b>
            </div>
          )}
        </div>
        <div className="actions">
          <Btn small tone="pri" disabled={busy !== null || v.record.status === 'running' || v.record.status === 'starting'} onClick={() => void op('start')}>
            {busy === 'start' ? 'Starting…' : 'Start'}
          </Btn>
          <Btn small disabled={busy !== null || v.record.status !== 'running'} onClick={() => void op('stop')}>
            {busy === 'stop' ? 'Stopping…' : 'Stop'}
          </Btn>
          <Btn small disabled title="node-restart is a planned engine operation (not implemented)">
            Restart (planned)
          </Btn>
          <Btn small tone="line" onClick={() => setPeersOpen((x) => !x)}>
            Inspect peers
          </Btn>
          <Btn small tone="line" disabled={!detail.data} onClick={() => detail.data && setDiag(diagnose(detail.data))}>
            Run diagnostics
          </Btn>
          {v.state === 'running' && (
            <Btn
              small
              tone="danger"
              onClick={() => {
                closeNode();
                nav(`/lab?node=${encodeURIComponent(v.id)}`);
              }}
            >
              Break in Failure Lab
            </Btn>
          )}
        </div>
        <ErrorBox error={opError} />
        <ErrorBox error={detail.error} title="Node detail unavailable" />
        <AnimatePresence initial={false}>
          {peersOpen && (
            <motion.div key="peers" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25, ease }} style={{ overflow: 'hidden' }}>
              <div className="lab" style={{ marginBottom: 6 }}>
                Expected peers (full mesh) · observed state
              </div>
              {neighbours.length === 0 && <div className="sub">Single-node network: no peers expected.</div>}
              {neighbours.map(
                ({ other, edge }) =>
                  other && (
                    <div className="kv" key={other.id}>
                      <span>{other.name}</span>
                      <b className={edge.alive ? 'ok' : 'bad'}>
                        {edge.basis === 'observed' ? 'Connected (peer id seen)' : edge.basis === 'inferred' ? 'Connected (inferred)' : 'Not observed'}
                      </b>
                    </div>
                  ),
              )}
              {(sample?.peers?.list.length ?? 0) > 0 && (
                <div className="sub" style={{ marginTop: 6 }}>
                  system_peers: {sample?.peers?.list.map((p) => shortId(p.peerId, 16)).join(', ')}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
        {diag && (
          <div aria-label="Diagnostics">
            <div className="lab" style={{ margin: '10px 0 6px' }}>
              Diagnostics (from the latest sample)
            </div>
            {diag.map((d, i) => (
              <motion.div key={d.l} className="kv" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.25, delay: i * 0.08, ease }}>
                <span title={d.detail}>
                  {d.l}
                  <br />
                  <small className="sub">{d.detail}</small>
                </span>
                <b className={d.ok ? 'ok' : 'bad'}>{d.ok ? 'Pass' : 'Fail'}</b>
              </motion.div>
            ))}
          </div>
        )}
        <div className="lab" style={{ margin: '14px 0 8px' }}>
          Logs (node log file tail)
        </div>
        <div className="logbar">
          <Seg id="lv" value={lvl} onChange={setLvl} items={[{ v: 'all', l: 'All' }, { v: 'warn', l: 'Warnings' }]} />
          <input aria-label="Search logs" placeholder="Search logs" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <ErrorBox error={logs.error} title="Logs unavailable" />
        <pre className="loglines" aria-label="Log lines">
          {lines.length === 0 ? (logs.loading ? 'Loading…' : 'No matching lines.') : lines.join('\n')}
        </pre>
      </motion.aside>
    </motion.div>
  );
}

export function NodeDrawer() {
  const { drawer, vnet } = useConsole();
  const v = vnet?.nodes.find((x) => x.id === drawer);
  return <AnimatePresence>{v && vnet && <DrawerBody key={v.id} v={v} net={vnet} />}</AnimatePresence>;
}
