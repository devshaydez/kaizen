/**
 * Replay fetch adapter: plugged into KaizenApiClient as `fetchImpl` when the
 * console is built with VITE_KAIZEN_PUBLIC=1. It answers the client's READ
 * routes from real recorded drills (see ./data.ts, ./map.ts) and live V3
 * reads (./v3.ts), with the exact response envelopes the Kaizen API uses,
 * so the pages render unchanged.
 *
 * Mutating requests are refused with a clear REPLAY_MODE error: nothing is
 * pretended. A read the recordings cannot answer is a 404
 * NOT_RECORDED_IN_REPLAY — the page shows it as an empty/error state.
 */

import { REPLAY_REFUSAL } from '../../lib/mode';
import { loadReplayData, type DrillBundle, type ReplayData } from './data';
import { faultsOf, networkOf, nodesOf, runHashOf, runSummary, snapshotOf } from './map';
import { anchorsOf, contractsOf, probeV3, statusV3, verifyAnchorLive, V3_BLOCK_URL_TEMPLATE } from './v3';

type FetchLike = typeof fetch;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const notRecorded = (what: string) =>
  json(404, { ok: false, error: { code: 'NOT_RECORDED_IN_REPLAY', message: `${what} not recorded in replay — drill bundles carry the run, its chain evidence and the certificate.` } });

const notFound = (what: string) => json(404, { ok: false, error: { code: 'NOT_FOUND', message: `${what} not found in the recorded drills` } });

export const refused = () => json(409, { ok: false, error: { code: 'REPLAY_MODE', message: REPLAY_REFUSAL } });

function bundleByNetwork(d: ReplayData, id: string): DrillBundle | undefined {
  return d.drills.find((b) => b.run.networkId === id || b.run.networkName === id);
}

function allRuns(d: ReplayData) {
  return [...d.drills.map((b) => b.run), ...d.evidenceRuns];
}

/** Route one request. Exported for tests. */
export async function replayRoute(method: string, url: URL, d: ReplayData, liveFetch: FetchLike): Promise<Response> {
  const p = url.pathname.replace(/\/+$/, '');
  const seg = p.split('/').slice(1).map(decodeURIComponent); // ['api', ...]
  if (seg[0] !== 'api') return notFound(p);

  // Reads that are POST in the real API but have no side effect: verify.
  if (method === 'POST' && seg[1] === 'v3' && seg[2] === 'anchors' && seg[4] === 'verify') {
    const a = anchorsOf(d).find((x) => x.id === seg[3]);
    if (!a) return notFound(`Anchor ${seg[3]}`);
    return json(200, { ok: true, verification: await verifyAnchorLive(liveFetch, d, a) });
  }
  if (method !== 'GET') return refused();

  const [, a, b, c, e, f] = seg;
  if (a === 'health') return json(200, { ok: true, service: 'kaizen replay', version: `${d.drills.length} recorded drill${d.drills.length === 1 ? '' : 's'}`, dataDir: 'demo-data branch + docs/evidence' });
  if (a === 'binaries') return notRecorded('The portaldot_dev binary status is');

  if (a === 'networks') {
    if (!b) return json(200, { ok: true, networks: d.drills.map(networkOf) });
    const bundle = bundleByNetwork(d, b);
    if (!bundle) return notFound(`Network ${b}`);
    if (!c) return json(200, { ok: true, network: networkOf(bundle), nodes: nodesOf(bundle) });
    if (c === 'monitor') return json(200, { ok: true, snapshot: snapshotOf(bundle) });
    if (c === 'faults') return json(200, { ok: true, faults: faultsOf(bundle) });
    if (c === 'nodes' && e) {
      const node = nodesOf(bundle).find((n) => n.id === e);
      if (!node) return notFound(`Node ${e}`);
      if (f === 'logs') return notRecorded('Node logs are');
      if (!f) {
        const snap = snapshotOf(bundle);
        return json(200, { ok: true, node, sample: snap.samples.find((s: { nodeId: string }) => s.nodeId === e) ?? null, health: snap.health.find((h: { nodeId: string }) => h.nodeId === e) ?? null });
      }
    }
    return notRecorded(p);
  }

  if (a === 'faults' && b) {
    const fault = d.drills.flatMap(faultsOf).find((x) => x.id === b);
    return fault ? json(200, { ok: true, fault }) : notFound(`Fault ${b}`);
  }

  if (a === 'scenarios') {
    if (b === 'operations') return json(200, { ok: true, operations: [] });
    if (b === 'runs') {
      const runs = allRuns(d);
      if (c) {
        const run = runs.find((r) => r.id === c);
        return run ? json(200, { ok: true, run }) : notFound(`Run ${c}`);
      }
      const q = url.searchParams;
      let list = runs;
      if (q.get('scenarioId')) list = list.filter((r) => r.scenarioId === q.get('scenarioId'));
      if (q.get('networkId')) list = list.filter((r) => r.networkId === q.get('networkId'));
      if (q.get('state')) list = list.filter((r) => r.state === q.get('state'));
      list = [...list].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
      const limit = Number(q.get('limit') ?? 50);
      const offset = Number(q.get('offset') ?? 0);
      return json(200, { ok: true, runs: list.slice(offset, offset + limit).map(runSummary), malformed: [], total: list.length, limit, offset });
    }
    // Saved scenarios = the definitions the recorded runs executed (snapshot).
    const seen = new Map<string, unknown>();
    for (const r of allRuns(d)) {
      const snap = (r as unknown as { snapshot?: { id: string } }).snapshot;
      if (snap && !seen.has(snap.id)) seen.set(snap.id, snap);
    }
    const scenarios = [...seen.values()];
    if (b) {
      const s = scenarios.find((x) => (x as { id: string }).id === b);
      return s ? json(200, { ok: true, scenario: s }) : notFound(`Scenario ${b}`);
    }
    return json(200, { ok: true, scenarios, malformed: [], total: scenarios.length, limit: 50, offset: 0 });
  }

  if (a === 'v3') {
    if (b === 'probe') return json(200, { ok: true, report: await probeV3(liveFetch) });
    if (b === 'status') return json(200, { ok: true, status: await statusV3(liveFetch) });
    if (b === 'anchors') {
      const runId = url.searchParams.get('runId');
      const anchors = anchorsOf(d).filter((x) => !runId || x.runId === runId);
      return json(200, { ok: true, anchors, contracts: contractsOf(d), explorerBlockUrlTemplate: V3_BLOCK_URL_TEMPLATE });
    }
    if (b === 'runs' && c && e === 'hash') {
      const run = allRuns(d).find((r) => r.id === c);
      if (!run) return notFound(`Run ${c}`);
      return json(200, { ok: true, runId: run.id, runHash: await runHashOf(run), state: run.state, anchorable: String(run.state).startsWith('completed') });
    }
  }
  return notRecorded(p);
}

/** A fetch() that serves the Kaizen API from recorded data. */
export function createReplayFetch(liveFetch: FetchLike = globalThis.fetch.bind(globalThis)): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'https://replay.invalid');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && !(method === 'POST' && /\/api\/v3\/anchors\/[^/]+\/verify$/.test(url.pathname))) return refused();
    const d = await loadReplayData(liveFetch);
    return replayRoute(method, url, d, liveFetch);
  }) as FetchLike;
}
