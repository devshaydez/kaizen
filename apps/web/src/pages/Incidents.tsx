/**
 * Incidents (design import T-3.6B; design match T-3.6C). Automatic
 * incident detection and correlation is Phase 4 and NOT built — it is
 * labelled as such. What this screen shows is real: each executed fault's
 * persisted record and evidence (before / applied / effect / removed /
 * recovery observations), laid out as the design's cause → effect incident,
 * plus the tail of the affected node's real log file.
 *
 * The incident number is the fault's position in this network's recorded
 * fault history (oldest = #0001) — a display index, not a separate record.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import type { FaultRecord } from '../api/types';
import { Btn, Empty, NoNet, Planned, ease } from '../components/ui';
import { formatTs, shortId } from '../components/fmt';
import { ACTIVE_FAULT_STATES, healthyCount } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';
import { useAsync } from '../state/useAsync';
import { nodeTitle } from './Lab';
import { REPLAY } from '../lib/mode';

interface TimelineEntry {
  t: string | null;
  msg: string;
  lvl: 'ok' | 'warn';
}

export function faultTimeline(f: FaultRecord): TimelineEntry[] {
  const ev = f.evidence;
  const out: TimelineEntry[] = [{ t: f.requestedAt, msg: `${f.type} requested on ${f.nodeName} by ${f.requestedBy}`, lvl: 'ok' }];
  if (ev?.before) out.push({ t: ev.before.at, msg: `Before: RPC ${ev.before.rpcReachable ? 'reachable' : 'unreachable'}${ev.before.head ? `, head #${ev.before.head.number}` : ''}`, lvl: 'ok' });
  if (ev?.applied) out.push({ t: ev.applied.at, msg: `Applied: ${ev.applied.how}`, lvl: 'warn' });
  if (ev?.effect) out.push({ t: ev.effect.at, msg: `Effect ${ev.effect.observed ? 'observed' : 'NOT observed'}: ${ev.effect.detail}`, lvl: 'warn' });
  if (ev?.removed) out.push({ t: ev.removed.at, msg: `Removed: ${ev.removed.how}`, lvl: 'ok' });
  if (ev?.recovery) out.push({ t: ev.recovery.at, msg: `Recovery ${ev.recovery.verified ? 'verified' : 'NOT verified'}: ${ev.recovery.detail}`, lvl: ev.recovery.verified ? 'ok' : 'warn' });
  if (f.finishedAt) out.push({ t: f.finishedAt, msg: `Finished: ${f.state}${f.result ? ` (${f.result.outcome})` : ''}`, lvl: f.state === 'completed' ? 'ok' : 'warn' });
  return out;
}

export interface CauseStep {
  label: string;
  t: string | null;
  warn: boolean;
  done: boolean;
}

/** The design's five-beat cause → effect strip, filled only from recorded evidence. */
export function causeSteps(f: FaultRecord): CauseStep[] {
  const ev = f.evidence;
  const pause = f.type === 'pause';
  return [
    { label: pause ? 'Paused' : 'Stopped', t: ev?.applied?.at ?? null, warn: true, done: Boolean(ev?.applied) },
    { label: ev?.effect && !ev.effect.observed ? 'Effect not seen' : 'RPC lost', t: ev?.effect?.at ?? null, warn: true, done: Boolean(ev?.effect) },
    { label: pause ? 'Resumed' : 'Restarted', t: ev?.removed?.at ?? null, warn: false, done: Boolean(ev?.removed) },
    { label: ev?.recovery && !ev.recovery.verified ? 'Not verified' : 'Recovery verified', t: ev?.recovery?.at ?? null, warn: Boolean(ev?.recovery && !ev.recovery.verified), done: Boolean(ev?.recovery) },
    { label: 'Closed', t: f.finishedAt ?? null, warn: f.state !== 'completed' && Boolean(f.finishedAt), done: Boolean(f.finishedAt) },
  ];
}

const clock = (t: string | null) => {
  if (!t) return '—';
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? (formatTs(t).split(', ').pop() ?? '—') : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
};
/** Drop a leading ISO-ish date so the time and message fit the log card. */
export const logLine = (l: string) => l.replace(/^\d{4}-\d{2}-\d{2}[ T]/, '');

export function Incidents() {
  const nav = useNavigate();
  const { network, faults, vnet } = useConsole();
  const [pick, setPick] = useState<string | null>(null);
  const executed = faults.filter((f) => f.mode === 'execute');
  const f = executed.find((x) => x.id === pick) ?? executed[0] ?? null;
  const logs = useAsync((_s) => (network && f ? apiClient.nodeLogs(network.id, f.nodeId, 8_192) : Promise.resolve(null)), [network?.id, f?.id]);
  if (!network) return <NoNet />;
  const banner = (
    <div className="sub" style={{ marginTop: 18 }}>
      Recorded Failure Lab faults and recovery evidence; automatic detection is not implemented (Phase 4).
    </div>
  );
  if (!f)
    return (
      <>
        <Empty
          title="No fault evidence yet"
          text="Break something in the Failure Lab and its observed evidence (applied, effect, removal, recovery) appears here as an incident."
          action={
            <Btn tone="pri" arrow onClick={() => nav('/lab')}>
              Open Failure Lab
            </Btn>
          }
        />
        {banner}
      </>
    );
  const live = ACTIVE_FAULT_STATES.has(f.state);
  const claims = f.result?.claims;
  const number = String(executed.length - executed.indexOf(f)).padStart(4, '0');
  const steps = causeSteps(f);
  const pct = (steps.filter((s) => s.done).length / steps.length) * 100;
  const title = vnet ? nodeTitle(vnet, f.nodeId) : f.nodeName;
  const label = f.nodeName.replace(`${network.name}-`, '');
  const badge = live ? 'Active' : claims?.recoveryVerified ? 'Recovered' : f.state === 'completed' ? 'Closed' : f.state;
  const effect = f.evidence?.effect;
  const lines = (logs.data?.lines ?? []).filter((l) => l.trim()).slice(-6);
  return (
    <div>
      {executed.length > 1 && (
        <div className="chips" aria-label="Recorded faults">
          {executed.slice(0, 10).map((x, i) => (
            <button type="button" key={x.id} className={`chip ${x.id === f.id ? 'sel' : ''}`} onClick={() => setPick(x.id)}>
              #{String(executed.length - i).padStart(4, '0')} · {x.type} · {x.nodeName.replace(`${network.name}-`, '')}
            </button>
          ))}
        </div>
      )}
      <div className="eyebrow">
        {f.type === 'pause' ? 'Validator pause' : 'Node stop'} · {network.name}
      </div>
      <div className="inc-head">
        <h1>Incident #{number}</h1>
        <span className={`chip ${live ? 'warn' : claims?.recoveryVerified ? 'ok' : 'bad'}`}>{badge}</span>
        <span className="mono-s" title={f.id}>
          fault {shortId(f.id, 18)}
        </span>
      </div>
      <div className="cause">
        <div className="lab">Cause → effect</div>
        <div className="cause-row">
          {steps.map((s) => (
            <div key={s.label} className={s.warn && s.done ? 'warn' : ''} style={{ opacity: s.done ? 1 : 0.4 }}>
              <b>{s.label}</b>
              <span>{clock(s.t)}</span>
            </div>
          ))}
        </div>
        <div className="cause-bar">
          <motion.i initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease }} />
        </div>
      </div>
      <div className="inc-cols">
        <section>
          <div className="lab">What happened</div>
          <p className="big">
            {title} ({label}) was {f.type === 'pause' ? 'paused' : 'stopped'} by a Failure Lab run requested by {f.requestedBy}
            {f.holdDurationMs ? ` for a ${f.holdDurationMs / 1000}s hold` : ''}.{f.evidence?.applied ? ` ${f.evidence.applied.how}.` : ''}
          </p>
          <div className="lab">Affected</div>
          <div className="kv">
            <b>{title}</b>
            <span className="chip bad">{f.type === 'pause' ? 'Paused' : 'Offline'}</span>
          </div>
        </section>
        <section>
          <div className="lab">Impact</div>
          <p className="big">{effect ? `${effect.observed ? '' : 'Not observed: '}${effect.detail}` : live ? 'Not observed yet.' : 'No effect observation recorded.'}</p>
          <div className="lab">Recovery</div>
          <div className="kv">
            <b>{claims ? (claims.recoveryVerified ? 'Successful' : claims.recovered ? 'Unverified' : 'Failed') : live ? 'In progress' : '—'}</b>
            {vnet && (
              <span className="chip">
                Healthy {healthyCount(vnet)}/{vnet.nodes.length}
              </span>
            )}
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            {claims ? (claims.recoveryVerified ? 'Verified independently over RPC.' : claims.recovered ? 'Recovered, but not independently verified.' : 'Not recovered.') : live ? 'Not finished yet.' : '—'}
          </div>
        </section>
        <section>
          <div className="lab">Relevant logs</div>
          <div className="logbox" aria-label="Node log tail">
            {logs.loading && <div className="muted">Loading {label} log…</div>}
            {!logs.loading && lines.length === 0 && (
              <div className="muted" style={{ whiteSpace: 'normal' }}>
                {REPLAY ? 'Not recorded in replay: drill bundles do not carry node log files.' : `No log lines available for ${label}.`}
              </div>
            )}
            {lines.map((l, i) => (
              <div key={i} className={/WARN|ERROR|error/.test(l) ? 'w' : ''} title={l}>
                {logLine(l)}
              </div>
            ))}
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            {REPLAY ? 'The runner log on GitHub has the full drill output.' : <>Tail of {label}&apos;s log file (current, not time-filtered).</>}
          </div>
        </section>
      </div>
      {f.error && <div className="wbox" style={{ marginTop: 18 }}>{f.error.message}</div>}
      <details className="more" open={live}>
        <summary>Full evidence timeline</summary>
        <ol className="tl">
          {faultTimeline(f).map((e, i) => (
            <li key={i} className={e.lvl}>
              <time>{clock(e.t)}</time>
              <span>{e.msg}</span>
            </li>
          ))}
        </ol>
      </details>
      <div className="actions" style={{ marginTop: 22 }}>
        <Btn tone="pri" arrow onClick={() => nav('/lab')}>
          Failure Lab
        </Btn>
        <Btn onClick={() => nav('/overview')}>View network</Btn>
      </div>
      {banner}
    </div>
  );
}
