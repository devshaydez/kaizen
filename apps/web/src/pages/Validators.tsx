/**
 * Validators (design import, T-3.6B). Shows the REAL validator nodes (role,
 * dev authority key, process/health, head, peers). Staking, session-key
 * rotation, validate/chill and participation metrics are Phase 5 (validator
 * operations) — shown disabled and labelled, never simulated.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Btn, NoNet, Num, Planned, Stat } from '../components/ui';
import { useConsole } from '../state/ConsoleContext';
import { REPLAY } from '../lib/mode';

export function Validators() {
  const { vnet, network, openNode } = useConsole();
  const [sel, setSel] = useState<string | null>(null);
  if (!vnet || !network) return <NoNet />;
  const vals = vnet.nodes.filter((v) => v.role === 'Validator');
  const v = vals.find((x) => x.id === sel) ?? vals[0];
  const authoring = vals.filter((x) => x.state === 'running').length;
  return (
    <>
      <div className="head">
        <div>
          <div className="lab">
            {network.name} · {vals.length} validator{vals.length === 1 ? '' : 's'} (dev authority keys)
          </div>
          <h1>Validators</h1>
          <p className="sub">Inspect validator health, chain head, peers, and dev keys.</p>
        </div>
      </div>
      <div className="split">
        {REPLAY && <div className="sub">Replay validator snapshot · recorded drill data, not live validator state</div>}
        <div>
          <div className="tbl" role="table" aria-label="Validators">
            <div className="tr th" role="row">
              <span>Validator</span>
              <span>Status</span>
              <span>Head</span>
              <span>Peers</span>
              <span>Key</span>
            </div>
            {vals.map((x) => (
              <motion.div key={x.id} layout role="row" className={`tr row ${x.id === v?.id ? 'on' : ''}`} onClick={() => setSel(x.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(x.id)}>
                <span>
                  <b>{x.label}</b>
                </span>
                <span>
                  <span className={`chip ${x.state === 'running' ? 'running' : x.state === 'offline' ? 'bad' : 'deploying'}`}>{x.stateLabel}</span>
                </span>
                <span className="mono">{x.height !== null ? `#${x.height.toLocaleString('en-US')}` : '—'}</span>
                <span className="mono">
                  {x.peers ?? '—'}/{x.expectedPeers}
                </span>
                <span className="mono">{x.record.wellKnownKey ? `//${x.record.wellKnownKey}` : '—'}</span>
              </motion.div>
            ))}
          </div>
          {vals.length === 0 && <div className="sub">This network has no validator nodes.</div>}
        </div>
        <aside className="glass panel">
          <div className="lab">{v ? v.name : 'No validator'}</div>
          <div className="stack">
            <div>
              <div className="field-l">Staking</div>
              <div className="inline">
                <input aria-label="Amount to bond" disabled placeholder="—" />
                <Btn small tone="pri" disabled>
                  Bond
                </Btn>
              </div>
            </div>
            <div>
              <div className="field-l">Validation</div>
              <Btn small disabled>
                Start / stop validating
              </Btn>
            </div>
            <div>
              <div className="field-l">Session keys</div>
              <Btn small disabled>
                Rotate keys
              </Btn>
            </div>
            <div>
              <Planned phase="Phase 5" /> <span className="sub">Validator operations (staking, session keys, participation) are not built yet.</span>
            </div>
            {v && (
              <Btn small tone="line" onClick={() => openNode(v.id)}>
                Inspect node
              </Btn>
            )}
          </div>
        </aside>
      </div>
      <div className="stats">
        <Stat label="Healthy validators" sub="Process + RPC + health">
          <Num v={authoring} />/{vals.length}
        </Stat>
        <Stat label="Best head" sub="Among validators">
          <Num v={vals.reduce<number | null>((m, x) => (x.height !== null && (m === null || x.height > m) ? x.height : m), null)} />
        </Stat>
        <Stat label="Participation" sub="Phase 5">—</Stat>
        <Stat label="Total stake" sub="Phase 5">—</Stat>
      </div>
    </>
  );
}
