/**
 * Pure mapping: one recorded drill bundle → the console's existing API
 * response types, so the unchanged pages render real numbers.
 *
 * Rules
 * - Every value is read from the bundle (run record, certificate chain
 *   evidence, step pre/postconditions) or follows deterministically from
 *   the recorded preset in the engine (two-node = validators alice `-a` and
 *   bob `-b`, local chain spec: packages/engine/src/network/topologies.ts).
 * - The network is shown in its state AS RECORDED at the end of the drill.
 *   The runner (and its processes) is gone afterwards; the replay banner
 *   says so.
 * - What was not recorded (ports, data dirs, logs, sync state, peer ids)
 *   stays empty and the UI labels it "not recorded in replay".
 */

import type {
  FaultEvidence,
  FaultExecutionResult,
  FaultRecord,
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkRecord,
  NetworkWithCount,
  NodeHealthReport,
  NodeMonitorSample,
  NodeRecord,
  ScenarioRunRecord,
  ScenarioRunSummary,
  WellKnownKey,
} from '../types';
import type { DrillBundle } from './data';

interface StepLike {
  stepId: string;
  operationType?: string;
  faultType?: string | null;
  nodeLabel?: string;
  nodeId?: string;
  nodeName?: string;
  state: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  faultId?: string | null;
  outcome?: string | null;
  durationMs?: number | null;
  claims?: { applied: boolean; effectObserved: boolean; faultRemoved: boolean; recovered: boolean; recoveryVerified: boolean } | null;
  preconditions?: { kind: string; verdict: string; detail: string; at: string }[];
  postconditions?: { kind: string; verdict: string; detail: string; at: string }[];
}

const steps = (run: ScenarioRunRecord): StepLike[] => ((run as unknown as { steps?: StepLike[] }).steps ?? []);

/** Engine preset → node templates (id suffix, name suffix, dev key). */
const PRESET_NODES: Record<string, { suffix: string; key: WellKnownKey }[]> = {
  'single-node': [{ suffix: 'a', key: 'alice' }],
  'two-node': [
    { suffix: 'a', key: 'alice' },
    { suffix: 'b', key: 'bob' },
  ],
};

export function presetOf(b: DrillBundle): NetworkPreset | null {
  const p = (b.run as unknown as { snapshot?: { requires?: { preset?: string } } }).snapshot?.requires?.preset;
  return (p as NetworkPreset | undefined) ?? null;
}

export function networkOf(b: DrillBundle): NetworkWithCount {
  const run = b.run as unknown as { networkId: string; networkName: string; createdAt: string; finishedAt: string | null; updatedAt: string; snapshot?: { requires?: { designatedTest?: boolean } } };
  const preset = presetOf(b);
  const record: NetworkRecord = {
    id: run.networkId,
    name: run.networkName,
    preset: preset ?? 'custom',
    status: 'running',
    designatedTest: run.snapshot?.requires?.designatedTest === true,
    chain: preset === 'single-node' ? 'dev' : 'local-spec',
    baseDir: '',
    createdAt: run.createdAt,
    updatedAt: run.finishedAt ?? run.updatedAt,
  };
  return { ...record, nodeCount: nodesOf(b).length };
}

/** Last recorded check of a kind for a node (postconditions win over preconditions). */
function lastCheck(b: DrillBundle, nodeId: string, kind: string) {
  const all = steps(b.run)
    .filter((s) => s.nodeId === nodeId)
    .flatMap((s) => [...(s.preconditions ?? []), ...(s.postconditions ?? [])])
    .filter((c) => c.kind === kind);
  return all.sort((x, y) => Date.parse(x.at) - Date.parse(y.at)).pop() ?? null;
}

export function nodesOf(b: DrillBundle): NodeRecord[] {
  const net = b.run as unknown as { networkId: string; networkName: string };
  const preset = presetOf(b);
  const templates = preset ? PRESET_NODES[preset] : undefined;
  // Fallback when the preset is unknown: only the nodes the bundle names.
  const ids = templates
    ? templates.map((t) => ({ id: `${net.networkId}-${t.suffix}`, key: t.key as WellKnownKey | undefined, name: `${net.networkName}-${t.key}` }))
    : [
        { id: b.certificate.chain.observerNodeId, key: undefined, name: b.certificate.chain.observerNodeId },
        ...((b.run as unknown as { targetNodes?: { nodeId: string; nodeName: string }[] }).targetNodes ?? []).map((t) => ({ id: t.nodeId, key: undefined, name: t.nodeName })),
      ];
  return ids.map(({ id, key, name }) => {
    const proc = lastCheck(b, id, 'process-state');
    const pid = proc ? Number(/pid=(\d+)/.exec(proc.detail)?.[1]) : NaN;
    const node: NodeRecord = {
      id,
      networkId: net.networkId,
      name,
      role: 'validator',
      chain: preset === 'single-node' ? 'dev' : 'local-spec',
      ...(key ? { wellKnownKey: key } : {}),
      bootnodes: [],
      baseDir: '',
      nodeKeyFile: '',
      logFile: '',
      ports: { p2p: 0, rpc: 0, ws: 0, prometheus: 0 },
      expectedPeers: Math.max(0, ids.length - 1),
      status: 'running',
      ...(Number.isFinite(pid) ? { pid } : {}),
    };
    return node;
  });
}

const REPLAY_NOTE = 'Replay: values recorded by the drill; sync state, peer ids and uptime were not recorded.';

/** Monitoring snapshot as recorded at the end of the drill. */
export function snapshotOf(b: DrillBundle): NetworkMonitorSnapshot {
  const chain = b.certificate.chain;
  const nodes = nodesOf(b);
  const last = chain.observations[chain.observations.length - 1] ?? null;
  const samples: NodeMonitorSample[] = [];
  const health: NodeHealthReport[] = [];
  const two = nodes.length === 2;
  // Peer count each node reported in its last rpc-reachable check.
  const peersOf = (id: string): { n: number; at: string; head: number | null } | null => {
    const c = lastCheck(b, id, 'rpc-reachable');
    if (!c) return null;
    const m = /peers=(\d+)/.exec(c.detail);
    const h = /head=#(\d+)/.exec(c.detail);
    return m ? { n: Number(m[1]), at: c.at, head: h ? Number(h[1]) : null } : null;
  };
  for (const node of nodes) {
    const isObserver = node.id === chain.observerNodeId;
    const own = peersOf(node.id);
    const other = nodes.find((x) => x.id !== node.id);
    const otherPeers = other ? peersOf(other.id) : null;
    // Two-node network: if the other node reported one connected peer, that
    // peer is this node (libp2p connections are mutual) — labelled inferred.
    const peers = own ? own.n : two && otherPeers && otherPeers.n >= 1 ? 1 : null;
    const warnings = [REPLAY_NOTE];
    if (!own && peers !== null) warnings.push(`Peer count inferred: ${other?.name} reported ${otherPeers?.n} peer in this two-node network.`);
    const head = isObserver && last ? { number: last.best.number, hash: last.best.hash } : own?.head != null ? { number: own.head, hash: '' } : null;
    const finalized = isObserver && last ? { number: last.finalized.number, hash: last.finalized.hash } : null;
    const at = isObserver && last ? last.at : (own?.at ?? last?.at ?? b.run.finishedAt ?? b.publishedAt);
    samples.push({
      networkId: node.networkId,
      nodeId: node.id,
      name: node.name,
      at,
      process: { status: 'running', ...(node.pid ? { pid: node.pid } : {}) },
      rpc: { reachable: Boolean(isObserver ? last : own) },
      health: null,
      peers: peers === null ? null : { count: peers, expected: node.expectedPeers ?? 0, list: [] },
      head,
      finalized,
      genesisHash: chain.genesisHash,
      sync: null,
      uptimeMs: null,
      warnings,
    });
    const reasons: string[] = [];
    if (isObserver && chain.observations.length) {
      const first = chain.observations[0]!;
      reasons.push(`chain observer: RPC answered all ${chain.observations.length} recorded reads; finalized #${first.finalized.number} → #${last!.finalized.number}`);
    }
    for (const s of steps(b.run).filter((x) => x.nodeId === node.id)) {
      if (s.claims) reasons.push(`fault ${s.faultId ?? s.stepId}: recovery ${s.claims.recoveryVerified ? 'verified' : 'NOT verified'} by the engine`);
    }
    if (own) reasons.push(`last check: ${lastCheck(b, node.id, 'rpc-reachable')!.detail}`);
    const ok = reasons.length > 0 && !steps(b.run).some((s) => s.nodeId === node.id && s.claims && !s.claims.recoveryVerified);
    health.push({
      nodeId: node.id,
      state: ok ? 'healthy' : 'unknown',
      reasons: reasons.length ? reasons : ['not recorded in replay'],
      since: chain.recoveredAt ?? at,
      lastSampleAt: at,
      lastHealthyAt: ok ? at : null,
      rpcFailures: 0,
    });
  }
  return {
    networkId: b.run.networkId,
    name: b.run.networkName,
    at: last?.at ?? b.publishedAt,
    intervalMs: 0,
    samples,
    health,
  };
}

/** One executed fault per run step that carried one (pause of the validator). */
export function faultsOf(b: DrillBundle): FaultRecord[] {
  const chain = b.certificate.chain;
  const obs = chain.observations;
  const during = obs.find((o) => o.phase === 'during-fault') ?? null;
  const lastDuring = [...obs].reverse().find((o) => o.phase === 'during-fault') ?? null;
  const after = obs[obs.length - 1] ?? null;
  const snapStep = (id: string) =>
    ((b.run as unknown as { snapshot?: { steps?: { id: string; operation: { config: { durationMs?: number } } }[] } }).snapshot?.steps ?? []).find((s) => s.id === id);
  return steps(b.run)
    .filter((s) => s.faultId && s.faultType)
    .map((s) => {
      const pre = (s.preconditions ?? []).find((c) => c.kind === 'rpc-reachable');
      const preHead = pre ? /head=#(\d+)/.exec(pre.detail) : null;
      const recovery = (s.postconditions ?? []).find((c) => c.kind === 'recovery-verified');
      const pause = s.faultType === 'pause';
      const evidence: FaultEvidence = {
        before: pre ? { at: pre.at, rpcReachable: pre.verdict === 'satisfied', ...(preHead ? { head: { number: Number(preHead[1]), hash: '' } } : {}) } : null,
        applied: chain.faultStartedAt ? { at: chain.faultStartedAt, how: pause ? 'SIGSTOP on the managed validator process' : `${s.faultType} applied` } : null,
        effect:
          s.claims && during
            ? {
                observed: s.claims.effectObserved,
                attempts: 1,
                detail: `observer saw best #${during.best.number}, finalized #${during.finalized.number}${lastDuring && lastDuring !== during ? ` → best #${lastDuring.best.number}, finalized still #${lastDuring.finalized.number}` : ''} (finality stalled)`,
                observation: { at: during.at, rpcReachable: true, head: { number: during.best.number, hash: during.best.hash } },
                at: during.at,
              }
            : null,
        removed: chain.faultEndedAt ? { at: chain.faultEndedAt, how: pause ? 'SIGCONT — process resumed' : `${s.faultType} removed` } : null,
        recovery:
          s.claims && (recovery || chain.recoveredAt)
            ? {
                verified: s.claims.recoveryVerified,
                attempts: 1,
                detail: [recovery?.detail, after ? `finality advanced to #${after.finalized.number}` : null].filter(Boolean).join('; '),
                observation: after ? { at: after.at, rpcReachable: true, head: { number: after.best.number, hash: after.best.hash } } : null,
                at: chain.recoveredAt ?? recovery!.at,
              }
            : null,
        notes: ['Replay: reconstructed from the run step, its pre/postconditions and the certificate chain evidence.'],
      };
      const result: FaultExecutionResult | undefined = s.claims
        ? {
            ok: s.outcome === 'verified',
            outcome: (s.outcome ?? 'inconclusive') as FaultExecutionResult['outcome'],
            faultId: s.faultId!,
            state: 'completed',
            networkId: b.run.networkId,
            nodeId: s.nodeId!,
            type: s.faultType as FaultRecord['type'],
            claims: s.claims,
            evidence,
            durationMs: s.durationMs ?? 0,
          }
        : undefined;
      const rec: FaultRecord = {
        id: s.faultId!,
        networkId: b.run.networkId,
        nodeId: s.nodeId!,
        nodeName: s.nodeName ?? s.nodeId!,
        type: s.faultType as FaultRecord['type'],
        mode: 'execute',
        state: s.state === 'completed' ? 'completed' : s.state === 'failed' ? 'failed' : 'completed',
        requestedBy: `scenario run ${b.run.id}`,
        requestedAt: s.startedAt ?? b.run.startedAt ?? b.run.createdAt,
        updatedAt: s.finishedAt ?? b.run.updatedAt,
        ...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
        ...(snapStep(s.stepId)?.operation.config.durationMs ? { holdDurationMs: snapStep(s.stepId)!.operation.config.durationMs } : {}),
        evidence,
        ...(result ? { result } : {}),
      };
      return rec;
    });
}

export function runSummary(run: ScenarioRunRecord): ScenarioRunSummary {
  const r = run as unknown as ScenarioRunRecord & { steps: StepLike[]; warnings: unknown[]; currentStepOrder?: number | null };
  return {
    id: r.id,
    scenarioId: r.scenarioId,
    scenarioName: r.scenarioName,
    networkId: r.networkId,
    networkName: r.networkName,
    state: r.state,
    currentStepId: r.currentStepId ?? null,
    currentStepOrder: r.currentStepOrder ?? null,
    stepCount: r.steps.length,
    completedSteps: r.steps.filter((s: StepLike) => s.state === 'completed').length,
    requestedBy: r.requestedBy,
    replayOfRunId: r.replayOfRunId ?? null,
    warnings: Array.isArray(r.warnings) ? r.warnings.length : 0,
    error: r.error ?? null,
    cancellation: r.cancellation ?? null,
    createdAt: r.createdAt,
    startedAt: r.startedAt ?? null,
    finishedAt: r.finishedAt ?? null,
  };
}

// ---- canonical JSON + SHA-256 (same algorithm as packages/engine) ----------

export function canonicalJson(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new Error(`unsupported ${typeof v}`);
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `0x${[...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** Engine computeRunHash: SHA-256 of canonical { kaizenAnchor: 1, run }. */
export const runHashOf = (run: unknown): Promise<string> => sha256Hex(canonicalJson({ kaizenAnchor: 1, run }));
