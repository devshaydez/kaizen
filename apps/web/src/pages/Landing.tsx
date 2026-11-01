/**
 * Landing (design match, T-3.6C). Marketing page for the console.
 *
 * Honesty rules (DEC-009) applied to a marketing surface:
 * - every command shown exists in the CLI today, or is labelled with the
 *   phase that will ship it (Docker / Kubernetes = Phase 6)
 * - the control-plane line is a REAL health check against this API
 * - the "Break one" network is an animated ILLUSTRATION and is captioned as
 *   such; live values only ever appear inside the console
 * - V3 facts are the recorded on-chain evidence (README "Testnet evidence")
 */

import { useEffect, useState, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useAsync } from '../state/useAsync';
import { Btn, Planned, ease } from '../components/ui';
import { TopoView, type TopoEdge, type TopoNode } from '../components/Topology';
import { Waves } from '../components/Backdrop';

export const UP_COMMAND = 'npx kaizen up';
const REPO = 'https://github.com/Shaydez-Defi/kaizen';
/** Static public deployment (no Kaizen API behind it): point visitors at the live drills. */
const PUBLIC_DEMO = import.meta.env?.['VITE_KAIZEN_PUBLIC'] === '1';
export const V3_REGISTRY = '0x08fdadd1ebe16234c03b723255cc12fd98a5ef07';
export const V3_CHAIN_ID = 420420777;
/** Same block-link format as the engine (V3AnchorService.blockUrlTemplate). */
export const consoleBlockUrl = (blockHash: string) =>
  `https://node-console.portaldot.dev/?rpc=${encodeURIComponent('wss://test-node-v3.portaldot.dev')}#/explorer/query/${blockHash}`;
export const V3_EVIDENCE = {
  deploy: { block: 136822, hash: '0x567175bb40b891a5103e00c74b1b15b227a67f3da1aa93ef8264a09f580ecef2' },
  anchors: [
    { block: 136899, method: 'contract', hash: '0x2efd3f718fd67b044dd23fc7c2135c4cd69c53f6f5dd99170a9fc5e073eb0c69' },
    { block: 136919, method: 'contract', hash: '0x4f8d4617013382d0c07acb54c7a25ae10a737ed4077ed3383e14b7526b2f7a56' },
    { block: 136940, method: 'remark', hash: '0x9a2b7b6d5522e54e0ec44d486f5e8b5d8e1c075797bde732209b2fa4267fa6f3' },
    { block: 136947, method: 'remark', hash: '0x739af302a1aab00977f1af04c619a8cc5ea97d91e8c36a00c1f0e5699fe9e38a' },
  ],
  runs: 3,
};

/** Shape of real `kaizen up` output (packages/cli/src/up.ts) on a clean machine. */
const TERMINAL = [
  ['c', `$ ${UP_COMMAND}`],
  ['', '✓ portaldot binary ready'],
  ['', '✓ network "kaizen-local" created (4 validators)'],
  ['', '✓ 4 nodes started and healthy'],
  ['', ''],
  ['', '┌─────────┬───────────────────────┐'],
  ['', '│ RPC     │ ws://127.0.0.1:33000  │'],
  ['', '│ Console │ http://127.0.0.1:5173 │'],
  ['', '└─────────┴───────────────────────┘'],
] as const;

const I = {
  plus: <path d="M12 5v14M5 12h14" />,
  pulse: <path d="M3 12h4l2-5 4 10 2-5h6" />,
  bolt: <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.3-4.3" />
    </>
  ),
  undo: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />,
  cube: (
    <>
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3z" />
      <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
    </>
  ),
};
const Icon = ({ d }: { d: ReactNode }) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

const LIFECYCLE: { t: string; d: string; icon: ReactNode; tag?: string }[] = [
  { t: 'Create', d: 'Pick a preset, review, launch a real network.', icon: I.plus },
  { t: 'Monitor', d: 'Nodes, peers, heads and finality, live from RPC.', icon: I.pulse },
  { t: 'Break', d: 'Inject failures on purpose, gated to test networks.', icon: I.bolt },
  { t: 'Diagnose', d: 'Fault evidence with timeline and logs.', icon: I.search, tag: 'Correlation · Phase 4' },
  { t: 'Recover', d: 'Roll the fault back, verify recovery over RPC.', icon: I.undo },
  { t: 'Deploy', d: 'Local processes today; same network to Kubernetes next.', icon: I.cube, tag: 'K8s · Phase 6' },
];

const SIX: { t: string; d: string; status: 'live' | 'blocked'; note: string }[] = [
  { t: 'Stop node', d: 'Halt a node process for a hold', status: 'live', note: 'Live · terminate' },
  { t: 'Restart node', d: 'Bring it back and watch it resync', status: 'live', note: 'Live · after every stop' },
  { t: 'Disconnect peer', d: 'Cut a single link', status: 'blocked', note: 'Blocked in engine · R-22' },
  { t: 'Partition network', d: 'Split nodes into groups', status: 'blocked', note: 'Blocked in engine · R-22' },
  { t: 'Pause validator', d: 'Freeze block production', status: 'live', note: 'Live · SIGSTOP' },
  { t: 'Restore & verify', d: 'Roll back any fault and confirm recovery', status: 'live', note: 'Live · every fault' },
];

const FAQ: [string, string][] = [
  ['Are these real nodes?', 'Yes. Every action goes through the Kaizen control plane to real portaldot_dev processes on your machine. Nothing in the console is simulated.'],
  ['Console or CLI?', 'Both. They share one operations engine, so each does exactly what the other does — same gates, same evidence.'],
  ['What is in an incident?', 'The fault type and target, recorded evidence (applied, effect, removal, recovery) with timestamps, and the node’s log. Automatic detection and correlation are planned for Phase 4.'],
  ['What do I need to get started?', 'Node 24+, then npm install && npm run build and npx kaizen up from the repo. The Portaldot binary ships for linux-x64 and macOS; Settings checks readiness.'],
];

function useHealthLine() {
  const health = useAsync((_s) => apiClient.health({ timeoutMs: 4000 }), []);
  if (PUBLIC_DEMO) return { ok: true, text: 'Hosted console · replay of real recorded drills (read-only)' };
  if (health.data) return { ok: true, text: `Control plane connected · v${health.data.version}` };
  if (health.loading) return { ok: false, text: 'Checking control plane…' };
  return { ok: false, text: 'Control plane unreachable — start it with node apps/api/dist/index.js' };
}

function CopyCmd({ cmd, small }: { cmd: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className={`cmd ${small ? 'sm' : ''}`}>
      <code>
        <span className="d">$</span>
        {cmd}
      </code>
      {!small && (
        <button type="button" onClick={copy} aria-label={`Copy ${cmd}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
  );
}

function CmdBox({ cmd, planned }: { cmd: string; planned?: string }) {
  return (
    <div className={`cbox ${planned ? 'off' : ''}`} title={planned ? `Planned — ${planned}` : undefined}>
      <span className="d">$</span> {cmd}
    </div>
  );
}

/** Lifecycle wave through the six badges (low / high, as in the design). */
function LifecycleWave() {
  const reduce = useReducedMotion();
  const W = 1200;
  const pts = LIFECYCLE.map((_, i) => [((i + 0.5) / 6) * W, i % 2 === 0 ? 87 : 35] as const);
  let d = `M-40 70 C${pts[0]![0] - 80} 70 ${pts[0]![0] - 60} ${pts[0]![1]} ${pts[0]![0]} ${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const m = (x1 - x0) / 2;
    d += ` C${x0 + m} ${y0} ${x1 - m} ${y1} ${x1} ${y1}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` C${last[0] + 60} ${last[1]} ${W - 20} 60 ${W + 40} 60`;
  return (
    <svg className="wave" viewBox={`0 0 ${W} 140`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill="none" stroke="rgba(205,185,255,.45)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
      {!reduce && (
        <motion.path
          d={d}
          fill="none"
          stroke="#fff"
          strokeWidth="2.4"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray="0.05 0.95"
          vectorEffect="non-scaling-stroke"
          style={{ filter: 'drop-shadow(0 0 5px #b79bff)' }}
          initial={{ strokeDashoffset: 0 }}
          animate={{ strokeDashoffset: -1 }}
          transition={{ duration: 9, repeat: Infinity, ease: 'linear' }}
        />
      )}
    </svg>
  );
}

const DEMO_H = 1_284_306;
function demoNet(broken: boolean): { nodes: TopoNode[]; edges: TopoEdge[] } {
  const ids = ['1', '2', '3', '4'];
  const nodes: TopoNode[] = ids.map((id, i) => {
    const down = broken && id === '3';
    const peers = down ? 0 : broken ? 2 : 3;
    return {
      id,
      num: `0${i + 1}`,
      badge: down ? 'Offline' : 'Synced',
      tone: down ? 'bad' : 'ok',
      role: 'Validator',
      peers,
      expected: 3,
      height: down ? DEMO_H - 15 : DEMO_H,
      ariaLabel: `Illustration validator 0${i + 1}, ${down ? 'offline' : 'synced'}`,
      glitch: down,
    };
  });
  const edges: TopoEdge[] = [];
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) edges.push({ a: ids[i]!, b: ids[j]!, alive: !(broken && (i === 2 || j === 2)) });
  return { nodes, edges };
}

function BreakIllustration() {
  const reduce = useReducedMotion();
  const [broken, setBroken] = useState(true);
  useEffect(() => {
    if (reduce) return undefined;
    const t = setInterval(() => setBroken((b) => !b), 4200);
    return () => clearInterval(t);
  }, [reduce]);
  const net = demoNet(broken);
  return (
    <>
    <h2>Break one. Watch the network react.</h2>
    <div className="react">
      <div>
        <div className="rstats">
          <div>
            <div className="lab">Validator 03</div>
            <div className="num">{broken ? <span className="gc">Offline</span> : <span className="g">Synced</span>}</div>
            <div className="sub">{broken ? 'Stopped by Failure Lab' : 'Recovered, verified'}</div>
          </div>
          <div>
            <div className="lab">Peer links</div>
            <div className="num">{broken ? '6→3' : '6'}</div>
            <div className="sub">{broken ? '3 links lost' : 'Full mesh'}</div>
          </div>
          <div>
            <div className="lab">Health</div>
            <div className="num">{broken ? '3/4' : '4/4'}</div>
            <div className="sub">Quorum intact</div>
          </div>
          <div>
            <div className="lab">Incident</div>
            <div className="num">{broken ? <span style={{ background: 'linear-gradient(90deg,#ffd58a,#ffb44f)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>Open</span> : 'Closed'}</div>
            <div className="sub">{broken ? 'Recording evidence' : 'Recovery verified'}</div>
          </div>
        </div>
      </div>
      <figure className="illu" style={{ margin: 0 }}>
        <TopoView nodes={net.nodes} edges={net.edges} />
        <figcaption>Illustration — the console draws this view from live RPC and fault records.</figcaption>
      </figure>
    </div>
    </>
  );
}

export function Landing() {
  const nav = useNavigate();
  const cp = useHealthLine();
  const reduce = useReducedMotion();
  const status = <span className={cp.ok ? 'ok' : 'bad'}>{cp.text}</span>;
  const rise = { initial: reduce ? false : { opacity: 0, y: 18 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, margin: '-60px' }, transition: { duration: reduce ? 0 : 0.2, ease } };
  return (
    <div className="landing" id="top">
      <div className="wrap">
        <header className="lnav">
          <span className="brand">KAIZEN</span>
          <nav aria-label="Landing">
            <a href="#product">Product</a>
            <a href="#lab">Failure Lab</a>
            <a href="#v3">Portaldot V3</a>
            <Link to="/live">Live proof</Link>
            <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">
              Docs
            </a>
          </nav>
          <span className="lnav-cta">
            {PUBLIC_DEMO && <Btn onClick={() => nav('/live')}>See a live drill</Btn>}
            <Btn tone="pri" arrow onClick={() => nav('/overview')}>
              Launch console
            </Btn>
          </span>
        </header>
      </div>

      <div className="hero-wm" aria-hidden>
        KAIZEN
      </div>
      <Waves className="lwave" style={{ top: 330 }} count={7} />
      <div className="wrap">
        <section className="hero">
          <div>
            <div className="eyebrow">Portaldot node operations</div>
            <motion.h1
              initial={reduce ? false : { opacity: 0, y: 14, filter: 'blur(8px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: reduce ? 0 : 0.2, ease }}
            >
              An upgrade can pass
              <br />
              and still break <span className="g">validators.</span>
            </motion.h1>
            <p>Kaizen drills real Portaldot networks and verifies recovery with evidence before a passing upgrade can break validators.</p>
            <p>Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.</p>
            <Btn tone="pri" arrow onClick={() => nav(PUBLIC_DEMO ? '/live' : '/lab')}>
              Run Drill Now
            </Btn>
            <CopyCmd cmd={UP_COMMAND} />
            <div className="targets">
              LOCAL · <s>DOCKER</s>
              <sup>SOON</sup> · <s>KUBERNETES</s>
              <sup>SOON</sup>
            </div>
            <div className="hint">{status}</div>
          </div>
            <motion.div
              className="glass term"
              initial={reduce ? false : { opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduce ? 0 : 0.2, delay: reduce ? 0 : 0.05, ease }}
            >
            <div className="lab">Terminal</div>
            <pre aria-label="kaizen up output">
              {TERMINAL.map(([c, l], i) => (
                <motion.div key={i} className={c} initial={reduce ? false : { opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: reduce ? 0 : 0.05 + i * 0.015, duration: reduce ? 0 : 0.15, ease }}>
                  {l || ' '}
                </motion.div>
              ))}
            </pre>
          </motion.div>
        </section>

        <motion.section className="lstats" aria-label="At a glance" {...rise}>
          <div className="stat">
            <div className="lab">Command</div>
            <div className="num">1</div>
            <div className="sub">To a running network</div>
          </div>
          <div className="stat">
            <div className="lab">Validators</div>
            <div className="num">4</div>
            <div className="sub">Real nodes in the default preset</div>
          </div>
          <div className="stat">
            <div className="lab">Targets</div>
            <div className="num">3</div>
            <div className="sub">Local today · Docker, Kubernetes planned</div>
          </div>
          <div className="stat">
            <div className="lab">Engine</div>
            <div className="num">1</div>
            <div className="sub">Same for CLI and console</div>
          </div>
        </motion.section>

        <motion.section className="lsec" id="product" {...rise}>
          <h2>What Kaizen is, and isn’t</h2>
          <div className="isnt">
            <div>
              <h3>Kaizen operates real Portaldot networks.</h3>
              <p>
                Create a network, watch its nodes and validators, break it on purpose, read what happened and prove the run on Portaldot V3. Every action runs against the
                control plane, not simulated state.
              </p>
            </div>
            <div className="nots">
              {['A wallet', 'A block explorer', 'A token tracker', 'A generic Kubernetes dashboard'].map((x) => (
                <div key={x}>
                  {x}
                  <span>NOT THAT</span>
                </div>
              ))}
              <p>Everything here is about nodes and networks.</p>
            </div>
          </div>
        </motion.section>

        <motion.section className="lsec" id="lifecycle" {...rise}>
          <h2>One lifecycle, start to finish</h2>
          <div className="cycle">
            <LifecycleWave />
            <ol>
              {LIFECYCLE.map((s, i) => (
            <motion.li key={s.t} whileHover={reduce ? undefined : { y: -3 }} whileTap={reduce ? undefined : { scale: 0.99 }} transition={{ duration: reduce ? 0 : 0.2, ease }}>
                  <div className="ic">
                    <Icon d={s.icon} />
                  </div>
                  <div className="n">{String(i + 1).padStart(2, '0')}</div>
                  <b>{s.t}</b>
                  <span className="d">{s.d}</span>
                  {s.tag && <span className="planned">{s.tag}</span>}
                </motion.li>
              ))}
            </ol>
          </div>
        </motion.section>
      </div>

      <Waves className="lwave" style={{ marginTop: -190 }} count={6} amp={30} duration={60} />

      <div className="wrap">
        <motion.section className="lsec" id="lab" {...rise}>
          <BreakIllustration />
        </motion.section>

        <motion.section className="lsec" id="commands" {...rise}>
          <h2>Everything is one line away</h2>
          <div className="three">
            <div>
              <div className="eyebrow">
                Failure Lab <span className="planned live">Live</span>
              </div>
              <h3>Break it on purpose</h3>
              <p>Stop or pause a node for a hold, then watch topology and validator health react while recovery is verified.</p>
              <CmdBox cmd="kaizen run execute <id> -n kaizen-local" />
            </div>
            <div>
              <div className="eyebrow">
                Diagnostics <span className="planned live">Live</span>
              </div>
              <h3>Know what happened</h3>
              <p>Every fault keeps its evidence: what was applied, the observed effect, removal and recovery, step by step.</p>
              <CmdBox cmd="kaizen run get <runId>" />
            </div>
            <div>
              <div className="eyebrow">
                Deployments <Planned phase="Phase 6" />
              </div>
              <h3>Local to Kubernetes</h3>
              <p>Ship the same network to Docker or a cluster and keep monitoring the same validators.</p>
              <CmdBox cmd="kaizen up --target kubernetes" planned="Phase 6" />
            </div>
          </div>
        </motion.section>

        <motion.section className="lsec" id="v3" {...rise}>
          <div className="v3">
            <div>
              <div className="eyebrow" style={{ marginBottom: 14 }}>
                Portaldot V3 test network
              </div>
              <h2>
                Proven on <span className="g">Portaldot V3</span>
              </h2>
              <p>
                Every finished Failure Lab run is fingerprinted (SHA-256 of its canonical record) and anchored on the Portaldot V3 test network — through the
                KaizenRunRegistry contract or a system remark — then re-verified from the chain.
              </p>
              <div className="actions">
                <a className="btn pri" href={consoleBlockUrl(V3_EVIDENCE.anchors[0]!.hash)} target="_blank" rel="noreferrer">
                  Open in node console
                  <i>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </i>
                </a>
                <Btn onClick={() => nav('/v3')}>Anchors in the console</Btn>
              </div>
            </div>
            <div className="v3facts" aria-label="V3 evidence">
              <div>
                <span>Chain id</span>
                <b>
                  <code>{V3_CHAIN_ID}</code>
                </b>
              </div>
              <div>
                <span>Registry</span>
                <b>
                  <a href={consoleBlockUrl(V3_EVIDENCE.deploy.hash)} target="_blank" rel="noreferrer" title={`Deployed in block ${V3_EVIDENCE.deploy.block}`}>
                    <code>{V3_REGISTRY}</code>
                  </a>
                </b>
              </div>
              <div>
                <span>Anchored runs</span>
                <b>
                  {V3_EVIDENCE.runs} runs · {V3_EVIDENCE.anchors.length} finalized anchors
                </b>
              </div>
              <div>
                <span>Blocks</span>
                <b>
                  {V3_EVIDENCE.anchors.map((a, i) => (
                    <span key={a.block}>
                      {i > 0 && ' · '}
                      <a href={consoleBlockUrl(a.hash)} target="_blank" rel="noreferrer" title={`${a.method} anchor`}>
                        #{a.block}
                      </a>
                    </span>
                  ))}
                </b>
              </div>
              <div>
                <span>Verify</span>
                <b>
                  <code>kaizen v3 verify &lt;anchorId&gt;</code>
                </b>
              </div>
            </div>
          </div>
        </motion.section>

        <motion.section className="lsec" id="runs" {...rise}>
          <h2>Where it runs</h2>
          <div className="three">
            <div>
              <div className="eyebrow">
                Local <span className="planned live">Live</span>
              </div>
              <p>Run nodes on your own machine. The fastest way to try a topology.</p>
              <CmdBox cmd="kaizen up --target local" />
            </div>
            <div>
              <div className="eyebrow">
                Docker <Planned phase="Phase 6" />
              </div>
              <p>Containerised nodes on one host, from the same network configuration.</p>
              <CmdBox cmd="kaizen up --target docker" planned="Phase 6" />
            </div>
            <div>
              <div className="eyebrow">
                Kubernetes <Planned phase="Phase 6" />
              </div>
              <p>Set validator and full-node counts, resources and storage, then watch the pods come up.</p>
              <CmdBox cmd="kaizen up --target kubernetes" planned="Phase 6" />
            </div>
          </div>
        </motion.section>

        <motion.section className="lsec" id="break-types" {...rise}>
          <h2>Six ways to break it</h2>
          <div className="six">
            {SIX.map((s, i) => (
              <div key={s.t}>
                <div className="n">{String(i + 1).padStart(2, '0')}</div>
                <b>{s.t}</b>
                <span className="d">{s.d}</span>
                <span className={`planned ${s.status === 'live' ? 'live' : 'blocked'}`}>{s.note}</span>
              </div>
            ))}
          </div>
        </motion.section>

        <motion.section className="lsec" id="faq" {...rise}>
          <h2>Questions</h2>
          <div className="faq">
            {FAQ.map(([q, a]) => (
              <div key={q}>
                <b>{q}</b>
                <p>{a}</p>
              </div>
            ))}
          </div>
        </motion.section>

        <motion.section className="cta" {...rise}>
          <h2>Create your first network</h2>
          <CopyCmd cmd={UP_COMMAND} />
        </motion.section>
      </div>

      <footer className="lfoot">
        <div className="wrap">
          <div className="fcols">
            <div>
              <span className="brand">KAIZEN</span>
              <p>Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.</p>
              <CopyCmd cmd={UP_COMMAND} small />
            </div>
            <div>
              <h4>Product</h4>
              <Link to="/overview">Overview</Link>
              <Link to="/networks">Networks</Link>
              <Link to="/validators">Validators</Link>
            </div>
            <div>
              <h4>Operate</h4>
              <Link to="/lab">Failure Lab</Link>
              <Link to="/scenarios">Scenarios</Link>
              <Link to="/incidents">Incidents</Link>
            </div>
            <div>
              <h4>Deploy</h4>
              <Link to="/deployments">Local</Link>
              <a href="#runs">
                Docker <span className="planned">soon</span>
              </a>
              <a href="#runs">
                Kubernetes <span className="planned">soon</span>
              </a>
            </div>
            <div>
              <h4>Resources</h4>
              <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">
                Docs
              </a>
              <a href={`${REPO}#quickstart`} target="_blank" rel="noreferrer">
                CLI reference
              </a>
              <a href={`${REPO}/blob/main/docs/PROGRESS.md`} target="_blank" rel="noreferrer">
                Changelog
              </a>
            </div>
          </div>
          <div className="fbar">
            <span>© 2026 Kaizen</span>
            {status}
            <a href="#top">Back to top ↑</a>
          </div>
        </div>
        <div className="wrap">
          <div className="bigword" aria-hidden>
            <span>KAIZEN</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
