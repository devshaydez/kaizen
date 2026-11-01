/**
 * Replay mode (hosted console): the recorded drill → API mapping, the fetch
 * adapter's routing/refusals, and the browser BLAKE2b used to find recorded
 * V3 extrinsics. The fixture is a REAL published bundle (GitHub Actions run
 * 40105314125), copied verbatim from the demo-data branch.
 */

import { describe, expect, it } from 'vitest';
import bundleJson from './__fixtures__/drill-2026-10-24T15-05-40-467Z-e2a5cb69.json';
import { blake2b, bytesToHex } from '../../lib/blake2b';
import type { DrillBundle, ReplayData } from './data';
import { faultsOf, networkOf, nodesOf, runHashOf, snapshotOf } from './map';
import { createReplayFetch, replayRoute } from './fetch';
import { KaizenApiClient } from '../client';
import { anchorsOf } from './v3';
import evidence from '../../../../../docs/evidence/v3-anchors.json';
import cert from '../../../../../docs/evidence/resilience/certificate-517b2ffb81ec.json';

const bundle = bundleJson as unknown as DrillBundle;
const data: ReplayData = {
  drills: [bundle],
  index: [{ id: bundle.id, publishedAt: bundle.publishedAt, fingerprint: bundle.certificate.fingerprint, workflowUrl: bundle.workflow?.url ?? null }],
  problems: [],
  evidenceRuns: [],
  evidenceAnchors: (evidence as unknown as { anchors: ReplayData['evidenceAnchors'] }).anchors,
  evidenceContracts: (evidence as unknown as { contracts: ReplayData['evidenceContracts'] }).contracts,
  ciCertificate: cert as unknown as ReplayData['ciCertificate'],
  ciVerification: { status: 'verified', reasons: [] },
  ciScore: { score: 35, quality: 0, confidence: 0, runs: 1, faultsSurvived: 1 },
};
const noLive = (() => Promise.reject(new Error('no network in tests'))) as unknown as typeof fetch;
const get = (path: string) => replayRoute('GET', new URL(path, 'https://replay.invalid'), data, noLive);

describe('replay mapping (real drill bundle)', () => {
  it('maps the drill network and its two preset validators', () => {
    const net = networkOf(bundle);
    expect(net).toMatchObject({ id: 'net_9fce9536', name: 'res-it', preset: 'two-node', designatedTest: true, nodeCount: 2, chain: 'local-spec' });
    const nodes = nodesOf(bundle);
    expect(nodes.map((n) => [n.id, n.name, n.wellKnownKey])).toEqual([
      ['net_9fce9536-a', 'res-it-alice', 'alice'],
      ['net_9fce9536-b', 'res-it-bob', 'bob'],
    ]);
    // bob's pid is recorded in the process-state precondition; alice's is not.
    expect(nodes[1]!.pid).toBe(2268);
    expect(nodes[0]!.pid).toBeUndefined();
  });

  it('snapshot uses recorded heads/finality only; unrecorded fields stay null', () => {
    const snap = snapshotOf(bundle);
    const alice = snap.samples.find((s: { nodeId: string }) => s.nodeId === 'net_9fce9536-a')!;
    const bob = snap.samples.find((s: { nodeId: string }) => s.nodeId === 'net_9fce9536-b')!;
    expect(alice.head?.number).toBe(6);
    expect(alice.finalized?.number).toBe(4);
    expect(bob.head?.number).toBe(5); // "head=#5" from the post-recovery check
    expect(bob.finalized).toBeNull();
    expect(bob.peers?.count).toBe(1);
    expect(alice.uptimeMs).toBeNull();
    expect(alice.sync).toBeNull();
    expect(alice.warnings.join(' ')).toMatch(/inferred/);
  });

  it('rebuilds the paused-validator fault with the recorded claims and timestamps', () => {
    const [f] = faultsOf(bundle);
    expect(f).toMatchObject({ id: 'flt-mvmj66vg-21ba5657', type: 'pause', mode: 'execute', state: 'completed', nodeName: 'res-it-bob', holdDurationMs: 15000 });
    expect(f!.result?.claims.recoveryVerified).toBe(true);
    expect(f!.evidence?.applied?.at).toBe(bundle.certificate.chain.faultStartedAt);
    expect(f!.evidence?.recovery?.at).toBe(bundle.certificate.chain.recoveredAt);
  });

  it('recomputes the certified run hash from the recorded run', async () => {
    expect(await runHashOf(bundle.run)).toBe(bundle.certificate.runHash);
  });
});

describe('replay fetch adapter', () => {
  it('answers reads with the API envelopes', async () => {
    const list = await (await get('/api/networks')).json();
    expect(list.networks).toHaveLength(1);
    const monitor = await (await get('/api/networks/net_9fce9536/monitor')).json();
    expect(monitor.snapshot.samples).toHaveLength(2);
    const runs = await (await get('/api/scenarios/runs?limit=10')).json();
    expect(runs.runs[0]).toMatchObject({ id: 'run-mvmj66v4-42cd9817', state: 'completed', stepCount: 1, completedSteps: 1 });
    const hash = await (await get('/api/v3/runs/run-mvmj66v4-42cd9817/hash')).json();
    expect(hash.runHash).toBe(bundle.certificate.runHash);
  });

  it('labels unrecorded data instead of inventing it', async () => {
    const res = await get('/api/networks/net_9fce9536/nodes/net_9fce9536-b/logs?maxBytes=100');
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_RECORDED_IN_REPLAY');
  });

  it('refuses every mutation through the real client with REPLAY_MODE', async () => {
    const client = new KaizenApiClient({ fetchImpl: createReplayFetch(noLive) });
    await expect(client.startNetwork('net_9fce9536')).rejects.toMatchObject({ code: 'REPLAY_MODE', status: 409 });
    await expect(client.executeFault('net_9fce9536', { nodeId: 'net_9fce9536-b', type: 'pause' })).rejects.toThrow(/Replay mode: drills run on fresh GitHub runners/);
    await expect(client.anchorRun('run-mvmj66v4-42cd9817')).rejects.toMatchObject({ code: 'REPLAY_MODE' });
  });

  it('lists the recorded V3 anchors, newest block first, including the resilience registry anchor', () => {
    const anchors = anchorsOf(data);
    expect(anchors[0]).toMatchObject({ blockNumber: 167478, contractAddress: '0x8ec2b52a5e407926309f983f6e7d019d66da764a', runHash: cert.runHash });
    expect(anchors.length).toBe(1 + evidence.anchors.length);
  });
});

describe('blake2b (browser extrinsic hashing)', () => {
  it('matches the RFC 7693 / reference vectors', () => {
    expect(bytesToHex(blake2b(new TextEncoder().encode('abc'), 64))).toBe(
      '0xba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
    expect(bytesToHex(blake2b(new Uint8Array(0), 32))).toBe('0x0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8');
    const long = new Uint8Array(768).map((_, i) => i % 256);
    expect(bytesToHex(blake2b(long, 32))).toBe('0xb8007121274217790e2923e0ad7027986e5a99d5531ef6ae7d294140fc81615d');
  });
});
