/**
 * Scenarios (design import, T-3.6B) over the REAL scenario + run API:
 * list / create / update / delete / validate, explicit execute against the
 * selected network (confirm first), run progress from the persisted run
 * record, cancel, replay, and a hand-off to V3 anchoring. Operation support
 * comes from the engine's operation registry — blocked/planned operations
 * are shown disabled with the engine's reason.
 */

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiClient } from '../api/client';
import type {
  NetworkPreset,
  ScenarioInput,
  ScenarioRecord,
  ScenarioRunRecord,
  ScenarioRunState,
  ScenarioValidationResult,
  SerializedOperationDefinition,
} from '../api/types';
import { Btn, ErrorBox, ease } from '../components/ui';
import { formatTs, shortId } from '../components/fmt';
import { nodeLabel } from '../lib/model';
import { useConsole } from '../state/ConsoleContext';
import { useEventsContext } from '../state/EventsContext';
import { useAsync, useInterval } from '../state/useAsync';

export const TERMINAL_RUN_STATES: ReadonlySet<ScenarioRunState> = new Set([
  'rejected',
  'completed',
  'completed-with-warnings',
  'failed',
  'cancelled',
  'cleanup-failed',
]);

export interface DraftStep {
  op: string;
  node: string;
  delayS: number;
  holdS: number;
}

export interface Draft {
  id: string | null;
  name: string;
  steps: DraftStep[];
}

const PRE = ['rpc-reachable', 'process-state'] as const;
const POST = ['recovery-verified', 'rpc-reachable'] as const;

export function draftFromRecord(r: ScenarioRecord): Draft {
  return {
    id: r.id,
    name: r.name,
    steps: r.steps.map((s) => ({
      op: s.operation.type,
      node: s.operation.config.node,
      delayS: Math.round(s.delayBeforeMs / 1000),
      holdS: s.operation.type === 'pause' ? Math.round((s.operation.config.durationMs ?? 10_000) / 1000) : 0,
    })),
  };
}

/** Draft → API input with the standard evidence-carrying conditions. */
export function inputFromDraft(d: Draft, preset: string | null, ops: SerializedOperationDefinition[]): ScenarioInput {
  return {
    name: d.name.trim(),
    tags: ['failure-lab'],
    requires: { designatedTest: true, ...(preset && preset !== 'custom' ? { preset: preset as NetworkPreset } : {}) },
    steps: d.steps.map((s, i) => {
      const def = ops.find((o) => o.type === s.op);
      const pre = PRE.filter((k) => !def || def.supportedPreconditions.includes(k));
      const post = POST.filter((k) => !def || def.supportedPostconditions.includes(k));
      return {
        id: `${s.op}-${s.node}-${i + 1}`.replace(/[^a-z0-9-]/g, '').slice(0, 32),
        order: i,
        operation: { type: s.op, config: s.op === 'pause' ? { node: s.node, durationMs: s.holdS * 1000 } : { node: s.node } },
        delayBeforeMs: s.delayS * 1000,
        delayAfterMs: 0,
        timeoutMs: Math.max(180_000, s.holdS * 1000 + 120_000),
        preconditions: pre.map((k) => (k === 'rpc-reachable' ? { kind: k, node: s.node, expect: true } : { kind: k, node: s.node, expect: ['running' as const] })),
        postconditions: post.map((k) => (k === 'rpc-reachable' ? { kind: k, node: s.node, expect: true } : { kind: k, node: s.node })),
      };
    }),
  };
}

const runTone = (s: ScenarioRunState) => (s.startsWith('completed') ? 'ok' : TERMINAL_RUN_STATES.has(s) ? 'bad' : 'warn');

export function Scenarios() {
  const nav = useNavigate();
  const { network, nodes } = useConsole();
  const { events } = useEventsContext();
  const list = useAsync(() => apiClient.listScenarios({ limit: 50 }), []);
  const ops = useAsync(() => apiClient.scenarioOperations(), []);
  const runs = useAsync(() => apiClient.listScenarioRuns({ limit: 10 }), []);
  const labels = useMemo(() => (network ? nodes.map((n) => nodeLabel(network, n)) : []), [network, nodes]);
  const blank = (): Draft => ({ id: null, name: 'pause drill', steps: [{ op: 'pause', node: labels[0] ?? 'alice', delayS: 0, holdS: 10 }] });
  const [draft, setDraft] = useState<Draft>(blank);
  const [validation, setValidation] = useState<ScenarioValidationResult | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'run' | 'replay'; runId?: string } | null>(null);
  const [run, setRun] = useState<ScenarioRunRecord | null>(null);
  const [seenSeq, setSeenSeq] = useState(0);

  // Pick the first saved scenario once loaded (if the draft is still blank).
  useEffect(() => {
    const first = list.data?.scenarios[0];
    if (first && draft.id === null && seenSeq === 0) setDraft(draftFromRecord(first));
  }, [list.data]);

  // Refresh history/list on run + scenario events.
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > seenSeq);
    if (!fresh.length) return;
    setSeenSeq(fresh[fresh.length - 1]!.seq);
    if (fresh.some((e) => e.name.startsWith('scenario-run.'))) runs.reload();
    if (fresh.some((e) => e.name.startsWith('scenario.'))) list.reload();
  }, [events]);

  const tracking = run !== null && !TERMINAL_RUN_STATES.has(run.state);
  useInterval(() => {
    if (!run) return;
    apiClient
      .getScenarioRun(run.id)
      .then((r) => setRun(r.run))
      .catch(() => undefined);
  }, tracking ? 2_000 : null);

  const operations = ops.data?.operations ?? [];
  const opItems = operations.length
    ? operations.map((o) => ({ v: o.type, l: o.displayName, disabled: o.status !== 'supported', why: o.statusReason }))
    : [
        { v: 'pause', l: 'Pause', disabled: false, why: undefined },
        { v: 'terminate', l: 'Terminate', disabled: false, why: undefined },
      ];
  const nominal = draft.steps.reduce<{ at: number; t: number }[]>((acc, s) => {
    const prev = acc[acc.length - 1];
    const at = (prev ? prev.t : 0) + s.delayS;
    acc.push({ at, t: at + Math.max(s.holdS, 2) });
    return acc;
  }, []);
  const total = Math.max(12, ...nominal.map((x) => x.t + 2));
  const upd = (i: number, p: Partial<DraftStep>) => setDraft((d) => ({ ...d, steps: d.steps.map((x, k) => (k === i ? { ...x, ...p } : x)) }));
  const wrap = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(String(e), 'INTERNAL', 0));
    } finally {
      setBusy(null);
    }
  };
  const input = () => inputFromDraft(draft, network?.preset ?? null, operations);

  const validate = () =>
    wrap('validate', async () => {
      const res = await apiClient.validateScenario(input());
      setValidation(res.result);
    });
  const save = async (): Promise<string | null> => {
    let id: string | null = null;
    await wrap('save', async () => {
      const res = draft.id ? await apiClient.updateScenario(draft.id, input()) : await apiClient.createScenario(input());
      setValidation(res.scenario.validation);
      setDraft(draftFromRecord(res.scenario));
      id = res.scenario.id;
      list.reload();
    });
    return id;
  };
  const remove = () =>
    wrap('delete', async () => {
      if (!draft.id) return;
      await apiClient.deleteScenario(draft.id);
      setDraft(blank());
      setValidation(null);
      list.reload();
    });
  const execute = async () => {
    if (!network || !confirm) return;
    const c = confirm;
    setConfirm(null);
    if (c.kind === 'replay' && c.runId) {
      await wrap('run', async () => {
        const res = await apiClient.replayScenarioRun(c.runId!, { networkIdOrName: network.id, requestedBy: 'web' });
        setRun(res.run);
        runs.reload();
      });
      return;
    }
    const id = await save();
    if (!id) return;
    await wrap('run', async () => {
      const res = await apiClient.executeScenario(id, { networkIdOrName: network.id, requestedBy: 'web' });
      setRun(res.run);
      runs.reload();
    });
  };
  const cancel = () =>
    wrap('cancel', async () => {
      if (!run) return;
      const res = await apiClient.cancelScenarioRun(run.id, 'web');
      setRun(res.run);
    });

  const curStep = run?.steps.find((s) => s.stepId === run.currentStepId);
  return (
    <>
      <div className="head">
        <div>
          <div className="lab">Scenarios · {network ? `target ${network.name}` : 'no network selected'}</div>
          <h1>Replay failures on demand</h1>
          <p className="sub">Build or replay a failure sequence and inspect its recovery evidence.</p>
        </div>
      </div>
      <ErrorBox error={list.error} title="Scenarios unavailable" />
      <div className="split sc">
        <div>
          <div className="lab" style={{ marginBottom: 8 }}>
            Saved
          </div>
          {list.data?.scenarios.length === 0 && <div className="sub">No saved scenarios yet.</div>}
          {list.data?.scenarios.map((x) => (
            <button
              type="button"
              key={x.id}
              className={`li ${x.id === draft.id ? 'on' : ''}`}
              onClick={() => {
                setDraft(draftFromRecord(x));
                setValidation(x.validation);
              }}
            >
              <b>{x.name}</b>
              <span>
                {x.steps.length} step{x.steps.length === 1 ? '' : 's'} · {x.validationStatus}
              </span>
            </button>
          ))}
          <Btn
            small
            tone="line"
            onClick={() => {
              setDraft(blank());
              setValidation(null);
            }}
          >
            New scenario
          </Btn>
        </div>
        <div>
          <label className="field-l" htmlFor="sn">
            Name
          </label>
          <input id="sn" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <div className="lab" style={{ margin: '22px 0 8px' }}>
            Timeline (nominal: delays + holds; verification time not included)
          </div>
          <div className="trk" aria-label="Scenario timeline">
            {nominal.map((st, i) => (
              <motion.div key={i} className="mk bad" layout style={{ left: `${(st.at / total) * 100}%` }}>
                <i />
                <span>{st.at}s</span>
              </motion.div>
            ))}
          </div>
          <div className="steps-ed">
            {draft.steps.map((st, i) => (
              <div className="sr" key={i}>
                <input aria-label={`Step ${i + 1} delay in seconds`} type="number" min={0} max={300} value={st.delayS} onChange={(e) => upd(i, { delayS: Math.max(0, Math.min(300, Number(e.target.value) || 0)) })} />
                <span className="sub">s delay</span>
                <select aria-label={`Step ${i + 1} operation`} value={st.op} onChange={(e) => upd(i, { op: e.target.value, holdS: e.target.value === 'pause' ? st.holdS || 10 : 0 })}>
                  {opItems.map((a) => (
                    <option key={a.v} value={a.v} disabled={a.disabled} title={a.why}>
                      {a.l}
                      {a.disabled ? ' (not available)' : ''}
                    </option>
                  ))}
                </select>
                <select aria-label={`Step ${i + 1} node`} value={st.node} onChange={(e) => upd(i, { node: e.target.value })}>
                  {(labels.includes(st.node) ? labels : [st.node, ...labels]).map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
                {st.op === 'pause' && (
                  <>
                    <input aria-label={`Step ${i + 1} hold in seconds`} type="number" min={1} max={600} value={st.holdS} onChange={(e) => upd(i, { holdS: Math.max(1, Math.min(600, Number(e.target.value) || 1)) })} />
                    <span className="sub">s hold</span>
                  </>
                )}
                <button type="button" className="x" aria-label={`Remove step ${i + 1}`} onClick={() => setDraft({ ...draft, steps: draft.steps.filter((_, k) => k !== i) })}>
                  ×
                </button>
              </div>
            ))}
            <Btn small tone="line" disabled={draft.steps.length >= 50} onClick={() => setDraft({ ...draft, steps: [...draft.steps, { op: 'pause', node: labels[0] ?? 'alice', delayS: 3, holdS: 10 }] })}>
              Add step
            </Btn>
          </div>
          {validation && (
            <div className={validation.valid ? 'okbox' : 'wbox'} style={{ marginTop: 14 }} aria-label="Validation">
              {validation.valid ? `Valid · worst case ${Math.round(validation.worstCaseDurationMs / 1000)}s` : `${validation.errorCount} error(s)`}
              {validation.issues.map((is) => (
                <div key={is.code + is.path} className="sub">
                  {is.severity}: {is.message} ({is.path})
                </div>
              ))}
            </div>
          )}
          <ErrorBox error={error} />
          <div className="actions" style={{ marginTop: 18 }}>
            {tracking ? (
              <Btn tone="danger" disabled={busy !== null || run?.state === 'cancel-requested'} onClick={() => void cancel()}>
                {run?.state === 'cancel-requested' ? 'Cancelling…' : 'Cancel run'}
              </Btn>
            ) : (
              <Btn tone="pri" arrow disabled={busy !== null || !draft.steps.length || !network} onClick={() => setConfirm({ kind: 'run' })}>
                Run scenario
              </Btn>
            )}
            <Btn disabled={busy !== null} onClick={() => void save()}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </Btn>
            <Btn tone="line" disabled={busy !== null} onClick={() => void validate()}>
              Validate
            </Btn>
            {draft.id && (
              <Btn tone="line" disabled={busy !== null || tracking} onClick={() => void remove()}>
                Delete
              </Btn>
            )}
          </div>
          {run && (
            <div className="glass card" aria-label="Current run" style={{ marginTop: 8 }}>
              <div className="kv">
                <span>Run {run.id}</span>
                <b className={runTone(run.state)}>{run.state}</b>
              </div>
              <div className="sub">
                {curStep ? `Step ${curStep.order + 1}/${run.steps.length}: ${curStep.operationType} ${curStep.nodeLabel} · ${curStep.state}` : `${run.steps.filter((s) => s.state.startsWith('completed')).length}/${run.steps.length} steps completed`}
                {run.error ? ` · ${run.error.message}` : ''}
              </div>
              {TERMINAL_RUN_STATES.has(run.state) && run.state.startsWith('completed') && (
                <Btn small tone="line" onClick={() => nav(`/v3?run=${encodeURIComponent(run.id)}`)}>
                  Anchor on Portaldot V3
                </Btn>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="lab">Run history</div>
      <ErrorBox error={runs.error} title="Run history unavailable" />
      {runs.data?.runs.length === 0 && <div className="sub">No runs yet. Run a scenario and its result appears here.</div>}
      <div className="list" aria-label="Run history">
        {runs.data?.runs.map((r) => (
          <div key={r.id} className="rowline">
            <span>
              <b>{r.scenarioName}</b>
              <br />
              <small className="sub mono-s" title={r.id}>
                {shortId(r.id, 22)}
                {r.replayOfRunId ? ` · replay of ${shortId(r.replayOfRunId, 14)}` : ''}
              </small>
            </span>
            <span className="sub">
              {r.networkName} · {formatTs(r.finishedAt ?? r.createdAt)}
            </span>
            <span className={runTone(r.state)}>
              {r.state} ({r.completedSteps}/{r.stepCount})
            </span>
            <span>
              <Btn small tone="line" disabled={!TERMINAL_RUN_STATES.has(r.state) || tracking || !network} onClick={() => setConfirm({ kind: 'replay', runId: r.id })}>
                Replay
              </Btn>
              {r.state.startsWith('completed') && (
                <Btn small tone="line" onClick={() => nav(`/v3?run=${encodeURIComponent(r.id)}`)}>
                  Anchor
                </Btn>
              )}
            </span>
          </div>
        ))}
      </div>
      <AnimatePresence>
        {confirm && network && (
          <motion.div className="modal" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setConfirm(null)}>
            <motion.div className="glass dialog" role="dialog" aria-modal aria-label="Confirm run" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.26, ease }} onClick={(e) => e.stopPropagation()}>
              <h2>{confirm.kind === 'replay' ? 'Replay this run?' : `Run “${draft.name}”?`}</h2>
              <p>
                Target: <b>{network.name}</b>. Steps run against real portaldot_dev processes; the engine re-checks every safety gate first.
                {confirm.kind === 'replay' ? ' A replay repeats the recorded actions — identical outcomes are not guaranteed.' : ' The scenario is saved before it runs.'}
              </p>
              <div className="actions">
                <Btn onClick={() => setConfirm(null)}>Cancel</Btn>
                <Btn tone="danger" onClick={() => void execute()}>
                  {confirm.kind === 'replay' ? 'Replay' : 'Run'}
                </Btn>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
