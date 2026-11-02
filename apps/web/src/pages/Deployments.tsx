/**
 * Deployments (design import T-3.6B; design match T-3.6C). Local-process
 * deployment is what the engine runs today and is shown with REAL per-node
 * process data in the design's pods layout. Docker and Kubernetes/Helm
 * adapters are Phase 6 (planned scope, spec §6.6): their target buttons are
 * disabled and the Kubernetes view is a clearly marked, empty PREVIEW of the
 * planned UI — no generated manifests, no fake pods, no fake statuses.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { Btn, NoNet, Num, Planned, Seg, Stat, ease } from '../components/ui';
import { formatUptime } from '../components/fmt';
import { healthyCount, liveLinks } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';
import { REPLAY } from '../lib/mode';

type Target = 'Local' | 'Docker' | 'Kubernetes';

export function Deployments() {
  const nav = useNavigate();
  const { vnet, network, openNode } = useConsole();
  const [t, setT] = useState<Target>('Local');
  if (!vnet || !network) return <NoNet />;
  const running = vnet.nodes.filter((v) => v.record.status === 'running').length;
  const n = vnet.nodes.length;
  const healthy = healthyCount(vnet);
  const first = vnet.nodes[0];
  return (
    <>
      <div className="dep">
        <div>
          <div className="eyebrow">Local processes · {network.name}</div>
          <h1 aria-label={running ? 'Running as local processes' : 'Local processes (stopped)'}>
            {running} of {n}
            <br />
            nodes up
          </h1>
          <p className="sub">View local node processes. Docker and Kubernetes targets are not implemented yet.</p>
          {REPLAY ? (
            <p>
              Recorded as local processes on a fresh GitHub Actions runner (state at the end of the drill; the runner and its processes are gone). Chain{' '}
              <span className="mono-s">{network.chain}</span>; data directory not recorded in replay.
            </p>
          ) : (
            <p>
              {running ? 'Running as local processes' : 'Local processes (stopped)'} on this host. Chain <span className="mono-s">{network.chain}</span>, data in{' '}
              <span className="mono-s">{network.baseDir}</span>.
            </p>
          )}
          <div className="actions">
            <Btn tone="pri" arrow onClick={() => nav('/overview')}>
              View network
            </Btn>
            <Btn onClick={() => first && openNode(first.id)} disabled={!first}>
              View logs
            </Btn>
          </div>
          <div style={{ marginTop: 22 }}>
            <div className="lab" style={{ marginBottom: 10 }}>
              Deployment target
            </div>
            <Seg
              id="tg"
              label="Deployment target"
              value={t}
              onChange={setT}
              items={[
                { v: 'Local', l: 'Local' },
                { v: 'Docker', l: 'Docker', disabled: true, title: 'Planned — Phase 6' },
                { v: 'Kubernetes', l: 'Kubernetes', disabled: true, title: 'Planned — Phase 6' },
              ]}
            />
            <div className="sub" style={{ marginTop: 10 }}>
              Docker and Kubernetes/Helm adapters <Planned phase="Phase 6" />
            </div>
          </div>
        </div>
        <aside className="glass pods" aria-label="Local processes">
          <div className="lab" style={{ marginBottom: 4 }}>
            Processes · {running} of {n} running
          </div>
          {vnet.nodes.map((v) => (
            <div className="pod" key={v.id}>
              <b>
                {v.label}
                <small>
                  {v.role} · {v.record.pid ? `pid ${v.record.pid}` : 'no process'} · up {formatUptime(v.sample?.uptimeMs)}
                </small>
              </b>
              <motion.span key={v.record.status} className={`chip ${v.record.status === 'running' ? 'running' : v.record.status === 'starting' ? 'deploying' : 'pending'}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
                {v.record.status === 'starting' ? 'Starting' : v.record.status === 'running' ? 'Running' : v.record.status}
              </motion.span>
              {v.record.status === 'starting' && (
                <div className="bar">
                  <motion.i animate={{ width: ['10%', '70%'] }} transition={{ duration: 6, ease }} />
                </div>
              )}
            </div>
          ))}
        </aside>
      </div>
      <section className="preview" aria-label="Kubernetes preview">
        <div className="actions" style={{ justifyContent: 'space-between', margin: 0 }}>
          <span className="lab">Kubernetes · preview of the planned view</span>
          <Planned phase="Phase 6">Not connected to a cluster — coming in</Planned>
        </div>
        <p style={{ marginTop: 10 }}>
          The same network as a StatefulSet: one pod per node with CPU, memory and persistent storage, watched with the same validator health checks. Nothing below is
          live.
        </p>
        <div className="podgrid">
          {vnet.nodes.slice(0, 4).map((v, i) => (
            <div className="pod" key={v.id}>
              <b>
                {v.role === 'Validator' ? 'validator' : 'full'}-{i}
                <small>pod · CPU / memory / storage at deploy time</small>
              </b>
              <span className="chip">not deployed</span>
            </div>
          ))}
        </div>
      </section>
      <div className="stats">
        <Stat label="Nodes" sub="Running processes">
          <Num v={running} />/{n}
        </Stat>
        <Stat label="Health" sub={healthy === n ? 'All healthy' : `${n - healthy} not healthy`} tone={healthy < n ? 'warn' : undefined}>
          <Num v={healthy} />/{n}
        </Stat>
        <Stat label="Peer links" sub={`of ${vnet.edges.length} expected`}>
          <Num v={liveLinks(vnet)} />
        </Stat>
        <Stat label="Target" sub="Docker · Kubernetes planned">
          Local
        </Stat>
      </div>
    </>
  );
}
