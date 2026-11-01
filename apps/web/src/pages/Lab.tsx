/**
 * Failure Lab (design import T-3.6B; design match T-3.6C) over the REAL
 * FailureInjector API.
 *
 * - supported mechanisms (terminate = "Stop node", pause) execute via POST
 *   faults/execute with mode:'execute' after an explicit confirm; the
 *   request blocks until applied → held → removed → recovery verified, while
 *   the failure-active view follows the persisted fault record + fault.state
 *   WS events
 * - "Recover node" cancels the in-flight fault (the injector rolls back and
 *   verifies recovery) — the engine has one rollback path, so the design's
 *   separate "Reverse failure" button is not duplicated
 * - peer-disconnect / partition are typed-BLOCKED in the engine (R-22) and
 *   are shown disabled with the reason — never simulated (DEC-009)
 * - the warning preview is an EXPECTATION computed from the live view-model
 *   (links that would drop, health, GRANDPA 2/3 threshold) and says so
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type { FaultExecutionResult, FaultPreview, FaultRecord, FaultType } from '../api/types';
import { Topology } from '../components/Topology';
import { Btn, ErrorBox, NoNet, Num, Stat, ease, useNow } from '../components/ui';
import { shortId } from '../components/fmt';
import { ACTIVE_FAULT_STATES, healthyCount, liveLinks, type VNet, type VNode } from '../lib/model';
import { eventLevel, eventText, eventTime } from '../lib/eventText';
import { useConsole } from '../state/ConsoleContext';
import { useEventsContext } from '../state/EventsContext';

export const FAULTS: { id: FaultType; label: string; short: string; blurb: string; supported: boolean; reason?: string }[] = [
  { id: 'terminate', label: 'Stop node', short: 'Stop', blurb: 'Halts the node process for the hold, then restarts it and verifies recovery', supported: true },
  {
    id: 'peer-disconnect',
    label: 'Disconnect peer',
    short: 'Disconnect',
    blurb: 'Cut one link',
    supported: false,
    reason: 'Blocked in the engine: reserved-peer removal only works on reserved-only wiring (R-22 B2).',
  },
  {
    id: 'partition',
    label: 'Partition',
    short: 'Partition',
    blurb: 'Split into groups',
    supported: false,
    reason: 'Blocked in the engine: needs topology rewiring or privileged kernel isolation (R-22 C2/C4/C5, DEC-018).',
  },
  { id: 'pause', label: 'Pause validator', short: 'Pause', blurb: 'Freezes the process (SIGSTOP) for the hold, then resumes it and verifies recovery', supported: true },
];

const STRIP_SUB: Record<string, string> = {
  terminate: 'Halt a node process',
  'peer-disconnect': 'Cut one link',
  partition: 'Split into groups',
  pause: 'Stop block production',
};

const HOLDS = [10_000, 30_000, 60_000];

const CLAIMS: [keyof FaultExecutionResult['claims'], string][] = [
  ['applied', 'Mechanism applied'],
  ['effectObserved', 'Effect observed (RPC/process)'],
  ['faultRemoved', 'Fault removed'],
  ['recovered', 'Target recovered'],
  ['recoveryVerified', 'Recovery independently verified'],
];

export function nodeTitle(net: VNet, nodeId: string | undefined): string {
  const i = net.nodes.findIndex((v) => v.id === nodeId);
  const v = net.nodes[i];
  if (!v) return 'Node';
  return `${v.role} ${String(i + 1).padStart(2, '0')}`;
}

/** GRANDPA finalizes with strictly more than 2/3 of authorities. */
export function quorumAfter(validators: number, upAfter: number): boolean {
  return validators > 0 && upAfter * 3 > validators * 2;
}

/** Expected impact of faulting `node` (prediction from live state, not a measurement). */
export function expectedImpact(net: VNet, node: VNode) {
  const live = liveLinks(net);
  const lost = net.edges.filter((e) => e.alive && (e.a === node.id || e.b === node.id)).length;
  const healthy = healthyCount(net);
  const up = node.state === 'running' ? 1 : 0;
  const vals = net.nodes.filter((v) => v.role === 'Validator');
  const valsUp = vals.filter((v) => v.state === 'running').length;
  const valsAfter = valsUp - (node.role === 'Validator' ? up : 0);
  return { live, after: live - lost, healthyAfter: healthy - up, total: net.nodes.length, quorum: quorumAfter(vals.length, valsAfter) };
}

const Warn = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#ff8f7c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3 2 20h20L12 3z" />
    <path d="M12 10v4M12 17.5v.01" />
  </svg>
);
const Bolt = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
  </svg>
);
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function Lab() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { vnet, network, faults, refresh } = useConsole();
  const { events } = useEventsContext();
  const now = useNow(1000);
  const [target, setTarget] = useState<string | null>(params.get('node'));
  const [kind, setKind] = useState<FaultType>('terminate');
  const [hold, setHold] = useState(30_000);
  const [confirm, setConfirm] = useState(false);
  const [inFlight, setInFlight] = useState(false);
  const [result, setResult] = useState<FaultExecutionResult | null>(null);
  const [preview, setPreview] = useState<FaultPreview | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const seen = useRef(new Map<string, number>());
  const injectedAt = useRef<number | null>(null);

  const active: FaultRecord | null = useMemo(
    () => faults.find((f) => f.mode === 'execute' && ACTIVE_FAULT_STATES.has(f.state)) ?? null,
    [faults],
  );
  useEffect(() => {
    if (active && !seen.current.has(active.id)) seen.current.set(active.id, injectedAt.current ?? Date.now());
  }, [active]);
  const logEvents = useMemo(() => {
    if (!network) return [];
    return events
      .filter((e) =>
        active
          ? e.payload['faultId'] === active.id || (e.payload['nodeId'] === active.nodeId && /^(node\.status|monitor\.health)$/.test(e.name))
          : e.name.startsWith('fault.') && e.payload['networkId'] === network.id,
      )
      .slice(-6);
  }, [events, active, network]);

  if (!vnet || !network) return <NoNet />;
  const running = network.status === 'running' || network.status === 'degraded';
  const live = inFlight || active !== null;
  const node = vnet.nodes.find((x) => x.id === target) ?? vnet.nodes.find((x) => x.state === 'running') ?? vnet.nodes[0];
  const fail = FAULTS.find((f) => f.id === kind) ?? FAULTS[0]!;
  if (!node) return <NoNet />;
  const idx = vnet.nodes.findIndex((v) => v.id === node.id);
  const title = nodeTitle(vnet, node.id);
  const imp = expectedImpact(vnet, node);
  const verb = kind === 'pause' ? 'freezes (process stopped, stays allocated)' : 'goes offline';
  const warn = `${title} (${node.label}) ${verb} for ${hold / 1000} s. Expected: links ${imp.live} → ${imp.after}, health ${imp.healthyAfter}/${imp.total}, ${imp.quorum ? 'quorum intact' : 'finality likely stalls (below 2/3 validators)'}. Kaizen then restores it and verifies recovery over RPC.`;

  const doPreview = async () => {
    setError(null);
    setPreview(null);
    try {
      const res = await apiClient.dryRunFault(network.id, { nodeId: node.id, type: kind, options: { durationMs: hold }, requestedBy: 'web' });
      setPreview(res.preview);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0);
      const p = err.details?.['preview'] as FaultPreview | undefined;
      if (p) setPreview(p);
      else setError(err);
    }
  };

  const inject = async () => {
    setConfirm(false);
    setError(null);
    setResult(null);
    setPreview(null);
    setInFlight(true);
    injectedAt.current = Date.now();
    refresh();
    try {
      const res = await apiClient.executeFault(network.id, { nodeId: node.id, type: kind, options: { durationMs: hold }, requestedBy: 'web' });
      setResult(res.result);
      if (res.result.error) setError(new ApiError(res.result.error.message, res.result.error.code, 200));
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setInFlight(false);
      injectedAt.current = null;
      refresh();
    }
  };

  const rollback = async () => {
    if (!active) return;
    setCancelling(true);
    try {
      await apiClient.cancelFault(active.id);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setCancelling(false);
      refresh();
    }
  };

  const done = !live && result !== null;

  if (live) {
    const fNode = active ? vnet.nodes.find((v) => v.id === active.nodeId) : node;
    const fType = active?.type ?? kind;
    const fTitle = nodeTitle(vnet, fNode?.id);
    const state = fType === 'pause' ? 'paused' : 'offline';
    const startedAt = active ? (seen.current.get(active.id) ?? injectedAt.current ?? now) : (injectedAt.current ?? now);
    const vals = vnet.nodes.filter((v) => v.role === 'Validator');
    const valsUp = vals.filter((v) => v.state === 'running').length;
    const lv = liveLinks(vnet);
    return (
      <>
        <div className="lab-wrap active" style={{ marginTop: '4vh' }}>
          <div>
            <div className="eyebrow bad" aria-live="polite">
              Failure active · {mmss(now - startedAt)}
              {active ? ` · ${active.state}` : ' · requesting'}
            </div>
            <h1 aria-label={`${fTitle} ${state}`}>
              {fTitle} <span className="gc">{state}</span>
            </h1>
            <div className="actions">
              <Btn tone="pri" arrow disabled={!active || cancelling} onClick={() => void rollback()}>
                {cancelling ? 'Recovering…' : 'Recover node'}
              </Btn>
              <Btn onClick={() => nav('/incidents')}>Open incident</Btn>
            </div>
            <div className="sub">Recover now, or let the hold expire to remove the fault and verify recovery.</div>
            <Topology net={vnet} />
          </div>
          <aside className="glass livelog" aria-label="Live fault log">
            <div className="lab" style={{ marginBottom: 8 }}>
              Live log{active ? ` · ${shortId(active.id, 14)}` : ''}
            </div>
            {logEvents.length === 0 && <div className="sub">Waiting for fault events…</div>}
            {logEvents.map((e) => (
              <motion.div key={e.seq} className={`evt ${eventLevel(e) !== 'ok' ? 'hot' : ''}`} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 0.3, ease }}>
                <span>{eventText(e).split(`${network.name}-`).join('')}</span>
                <time>{eventTime(e)}</time>
              </motion.div>
            ))}
          </aside>
        </div>
        <div className="stats">
          <Stat label={fTitle} tone="bad" sub={fType === 'pause' ? 'Frozen by Failure Lab' : 'Stopped by Failure Lab'}>
            {fNode?.stateLabel ?? state}
          </Stat>
          <Stat label="Peer links" sub={`${vnet.edges.length - lv} link${vnet.edges.length - lv === 1 ? '' : 's'} lost`}>
            {vnet.edges.length}→<Num v={lv} />
          </Stat>
          <Stat label="Validator health" sub={quorumAfter(vals.length, valsUp) ? 'Quorum intact' : 'Below 2/3 — finality at risk'}>
            <Num v={valsUp} />/{vals.length}
          </Stat>
          <Stat label={active ? `Incident ${shortId(active.id, 10)}` : 'Incident'} tone="warn" sub={active ? `${active.state}…` : 'Opening…'}>
            Open
          </Stat>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="lab-wrap">
        <div>
          <div className={`eyebrow ${done ? (result.ok ? 'ok' : 'bad') : ''}`}>{done ? (result.ok ? 'Recovered' : `Outcome: ${result.outcome}`) : `Failure Lab · ${network.name}`}</div>
          <p className="sub">Run controlled failures on the selected test network; compare live impact with verified recovery.</p>
          {done ? (
            <h1 aria-label={result.ok ? 'Recovery verified' : 'Fault did not verify'}>
              {result.ok ? (
                <>
                  Recovery <span className="g">verified</span>
                </>
              ) : (
                <>
                  Fault did not <span className="gc">verify</span>
                </>
              )}
            </h1>
          ) : (
            <h1 aria-label="Break it on purpose">
              Break it on <span className="g">purpose</span>
            </h1>
          )}
          <Topology net={vnet} sel={node.id} onSelect={setTarget} />
          {!network.designatedTest && <div className="wbox">This network is not a designated test network — the engine refuses faults on it (DEC-008).</div>}
        </div>
        <aside className="glass panel danger inj">
          <div className="inj-h">
            <span className="lab">Inject failure</span>
            <span className="chip">Draft</span>
          </div>
          <div className="lab">Target</div>
          <label className="fieldcard">
            <span className="badge">{String(idx + 1).padStart(2, '0')}</span>
            <span>
              <b>{title}</b>
              <small>
                {node.label} · {node.stateLabel} · {node.height !== null ? `#${node.height.toLocaleString('en-US')}` : '# —'}
              </small>
            </span>
            <span className="chev">⌄</span>
            <select aria-label="Target node" value={node.id} onChange={(e) => setTarget(e.target.value)}>
              {vnet.nodes.map((v, i) => (
                <option key={v.id} value={v.id}>
                  {String(i + 1).padStart(2, '0')} · {v.label} ({v.stateLabel})
                </option>
              ))}
            </select>
          </label>
          <div className="lab">Failure</div>
          <label className="fieldcard">
            <span className="badge ic">
              <Bolt />
            </span>
            <span>
              <b>{fail.label}</b>
              <small>{fail.blurb.split(',')[0]}</small>
            </span>
            <span className="chev">⌄</span>
            <select
              aria-label="Failure"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as FaultType);
                setPreview(null);
              }}
            >
              {FAULTS.map((f) => (
                <option key={f.id} value={f.id} disabled={!f.supported}>
                  {f.label}
                  {f.supported ? '' : ' (blocked — R-22)'}
                </option>
              ))}
            </select>
          </label>
          <div className="fieldrow">
            <div>
              <div className="lab" style={{ marginBottom: 8 }}>
                Duration
              </div>
              <label className="fieldcard sm">
                <b>{hold / 1000} s</b>
                <span className="chev">⌄</span>
                <select aria-label="Hold duration" value={hold} onChange={(e) => setHold(Number(e.target.value))}>
                  {HOLDS.map((h) => (
                    <option key={h} value={h}>
                      {h / 1000} s
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <div className="lab" style={{ marginBottom: 8 }}>
                Start
              </div>
              <label className="fieldcard sm" title="Scheduled starts are not built; faults start immediately">
                <b>Now</b>
                <span className="chev">⌄</span>
                <select aria-label="Start" value="now" onChange={() => undefined}>
                  <option value="now">Now</option>
                  <option value="later" disabled>
                    Scheduled (not built)
                  </option>
                </select>
              </label>
            </div>
          </div>
          <div className="wbox">
            <Warn />
            <span>Intentional disruption. {warn}</span>
          </div>
          {result && (
            <div className={result.ok ? 'okbox' : 'wbox'} aria-label="Last result" style={{ display: 'block' }}>
              Last fault {shortId(result.faultId, 14)} — {result.outcome} in {(result.durationMs / 1000).toFixed(1)}s
              {CLAIMS.map(([k, l]) => (
                <div key={k} className="kv" style={{ padding: '4px 0' }}>
                  <span>{l}</span>
                  <b className={result.claims[k] ? 'ok' : 'bad'}>{result.claims[k] ? 'yes' : 'no'}</b>
                </div>
              ))}
            </div>
          )}
          {preview && (
            <div className={preview.preflight.ok ? 'okbox' : 'wbox'} aria-label="Dry-run preflight" style={{ display: 'block' }}>
              <b>Dry run: {preview.preflight.ok ? 'ready' : 'refused'}</b>
              {preview.preflight.checks.map((c) => (
                <div key={c.id} className="kv" style={{ padding: '4px 0' }}>
                  <span title={c.detail}>{c.id}</span>
                  <b className={c.ok ? 'ok' : 'bad'}>{c.ok ? 'pass' : 'fail'}</b>
                </div>
              ))}
              {preview.preflight.blockingReasons.map((r) => (
                <div key={r} className="sub">
                  {r}
                </div>
              ))}
            </div>
          )}
          <ErrorBox error={error} />
          <Btn tone="danger" arrow disabled={!running || !fail.supported} onClick={() => setConfirm(true)}>
            Inject failure
          </Btn>
          <div className="actions" style={{ justifyContent: 'space-between', margin: 0 }}>
            <button type="button" className="linkbtn" disabled={!fail.supported} onClick={() => void doPreview()}>
              Dry run
            </button>
            <button type="button" className="linkbtn" onClick={() => nav('/scenarios')}>
              Scripted scenarios
            </button>
            <button type="button" className="linkbtn" onClick={() => nav('/incidents')}>
              Fault evidence
            </button>
          </div>
          {!running && <div className="sub">Start the network first (Overview).</div>}
        </aside>
      </div>
      <div className="ftypes" role="group" aria-label="Fault type">
        {FAULTS.map((f, i) => (
          <button
            type="button"
            key={f.id}
            className={`ftype ${f.id === kind ? 'on' : ''}`}
            disabled={!f.supported}
            title={f.reason}
            aria-pressed={f.id === kind}
            onClick={() => {
              setKind(f.id);
              setPreview(null);
            }}
          >
            <span className="lab">
              {String(i + 1).padStart(2, '0')}
              {f.id === kind ? ' · Selected' : ''}
              {!f.supported && <span className="planned blocked">Blocked · R-22</span>}
            </span>
            <b>{f.label}</b>
            <small>{STRIP_SUB[f.id]}</small>
          </button>
        ))}
      </div>
      <AnimatePresence>
        {confirm && (
          <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} onClick={() => setConfirm(false)}>
            <motion.div
              className="glass dialog"
              role="dialog"
              aria-modal
              aria-label="Confirm fault"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.26, ease }}
              onClick={(e) => e.stopPropagation()}
            >
              <h2>{fail.label}?</h2>
              <p>{warn} This runs against the real portaldot_dev process.</p>
              <div className="actions">
                <Btn onClick={() => setConfirm(false)}>Cancel</Btn>
                <Btn tone="danger" onClick={() => void inject()}>
                  Inject failure
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
