/**
 * Replay-mode data: REAL recorded drills only.
 *
 * 1. Drill bundles published by .github/workflows/drill-live.yml
 *    (scripts/demo/publish-drill.mjs) to the `demo-data` branch: a real
 *    two-node portaldot_dev network on a fresh GitHub runner, one validator
 *    paused, recovery read from GRANDPA finality, certified + scored.
 * 2. Evidence committed in the repo (docs/evidence): local scenario runs
 *    anchored on Portaldot V3, and the CI Proof-of-Resilience certificate
 *    from run 40042905143.
 *
 * Nothing here is generated. A value a source did not record stays absent.
 */

import type { ScenarioRunRecord, V3AnchorRecord, V3ContractRecord } from '../types';
import evidenceAnchors from '../../../../../docs/evidence/v3-anchors.json';
import evidenceRun1 from '../../../../../docs/evidence/runs/run-mvim409r-32019a7e.json';
import evidenceRun2 from '../../../../../docs/evidence/runs/run-mvim7jct-5df7ea0f.json';
import evidenceRun3 from '../../../../../docs/evidence/runs/run-mvim9v7m-875cdcaa.json';
import ciCertificate from '../../../../../docs/evidence/resilience/certificate-517b2ffb81ec.json';
import ciVerification from '../../../../../docs/evidence/resilience/verification-online.json';
import ciScore from '../../../../../docs/evidence/resilience/score.json';

export const DEMO_OWNER = 'Shaydez-Defi';
export const DEMO_REPO = `https://github.com/${DEMO_OWNER}/kaizen`;
export const DEMO_DATA = `https://raw.githubusercontent.com/${DEMO_OWNER}/kaizen/demo-data`;
/** How many of the newest published drills the console loads. */
export const MAX_DRILLS = 8;

export interface BlockRef {
  number: number;
  hash: string;
}

export interface ChainEvidence {
  networkId: string;
  validatorId: string;
  observerNodeId: string;
  genesisHash: string;
  faultStartedAt: string | null;
  faultEndedAt: string | null;
  recoveredAt: string | null;
  observations: { phase: string; at: string; best: BlockRef; finalized: BlockRef }[];
  gaps: unknown[];
  metrics: { recovered: boolean; timeToRecoverMs: number | null; finalityGapBlocks: number | null; blocksMissed: number | null; expectedBlockTimeMs?: number };
}

export interface Certificate {
  version: number;
  fingerprint: string;
  runId: string;
  runHash: string;
  validatorId: string;
  networkId: string;
  chain: ChainEvidence;
  signature: { address: string; publicKey?: string; scheme?: string; dev: boolean };
  signedAt: string;
}

export interface Verification {
  status: string;
  reasons: string[];
}

export interface Score {
  score: number;
  quality: number;
  confidence: number;
  runs: number;
  faultsSurvived: number;
}

export interface DrillAnchor {
  status: string;
  reason?: string;
  blockHash?: string;
  blockNumber?: number;
  extrinsicIndex?: number | null;
  txHash?: string;
  remark?: string;
  signer?: string;
  network?: { ws: string; genesisHash: string };
}

export interface DrillBundle {
  kaizenDemoBundle: number;
  id: string;
  publishedAt: string;
  certificate: Certificate;
  run: ScenarioRunRecord;
  verificationOnline: Verification | null;
  verificationOffline: Verification | null;
  score: Score | null;
  anchor: DrillAnchor;
  workflow: { runId: string; url: string; event: string; sha: string } | null;
}

export interface DrillIndexItem {
  id: string;
  publishedAt: string;
  fingerprint: string;
  workflowUrl: string | null;
}

export interface ReplayData {
  /** Newest first; only bundles that actually loaded. */
  drills: DrillBundle[];
  /** Index entries (newest first), including ones not loaded. */
  index: DrillIndexItem[];
  /** Problems reading the published data (shown, never hidden). */
  problems: string[];
  /** Local scenario runs committed under docs/evidence/runs. */
  evidenceRuns: ScenarioRunRecord[];
  /** V3 anchors + registry deployment committed in docs/evidence/v3-anchors.json. */
  evidenceAnchors: V3AnchorRecord[];
  evidenceContracts: V3ContractRecord[];
  /** CI Proof-of-Resilience certificate (run 40042905143; run record not committed). */
  ciCertificate: Certificate;
  ciVerification: Verification;
  ciScore: Score;
}

export const CI_EVIDENCE_RUN_URL = `${DEMO_REPO}/actions/runs/40042905143`;

type FetchLike = typeof fetch;

async function loadDrills(fetchImpl: FetchLike): Promise<Pick<ReplayData, 'drills' | 'index' | 'problems'>> {
  const problems: string[] = [];
  let index: DrillIndexItem[] = [];
  try {
    const r = await fetchImpl(`${DEMO_DATA}/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(r.status === 404 ? 'no drill has been published yet' : `HTTP ${r.status}`);
    index = ((await r.json()) as { drills: DrillIndexItem[] }).drills ?? [];
  } catch (e) {
    problems.push(`Published drill index unavailable: ${(e as Error).message}`);
  }
  const loaded = await Promise.all(
    index.slice(0, MAX_DRILLS).map(async (it) => {
      try {
        const r = await fetchImpl(`${DEMO_DATA}/drills/${encodeURIComponent(it.id)}.json`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = (await r.json()) as DrillBundle;
        if (b.kaizenDemoBundle !== 1 || !b.run || !b.certificate) throw new Error('not a Kaizen drill bundle');
        return b;
      } catch (e) {
        problems.push(`Drill ${it.id} could not be read: ${(e as Error).message}`);
        return null;
      }
    }),
  );
  return { drills: loaded.filter((b): b is DrillBundle => b !== null), index, problems };
}

let cache: Promise<ReplayData> | null = null;

/** Load once per page session (reload the page to pick up a newer drill). */
export function loadReplayData(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<ReplayData> {
  if (!cache) {
    cache = loadDrills(fetchImpl).then((d) => ({
      ...d,
      evidenceRuns: [evidenceRun1, evidenceRun2, evidenceRun3] as unknown as ScenarioRunRecord[],
      evidenceAnchors: (evidenceAnchors as unknown as { anchors: V3AnchorRecord[] }).anchors,
      evidenceContracts: (evidenceAnchors as unknown as { contracts: V3ContractRecord[] }).contracts,
      ciCertificate: ciCertificate as unknown as Certificate,
      ciVerification: ciVerification as unknown as Verification,
      ciScore: ciScore as unknown as Score,
    }));
  }
  return cache;
}

/** Test hook. */
export function resetReplayCache(): void {
  cache = null;
}

/** Short id shown to people: the fingerprint prefix the bundle id ends with. */
export const drillShortId = (b: Pick<DrillBundle, 'id'>): string => b.id.split('-').pop() ?? b.id;
