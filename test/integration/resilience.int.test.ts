/**
 * LIVE test — Proof-of-Resilience (T-9.1/T-9.2/T-9.5) against a REAL
 * two-node portaldot_dev network (designatedTest, DEC-008).
 *
 * A pause drill on one validator runs through the normal ScenarioEngine
 * with evidence capture on. The test then checks, independently over its
 * own RPC calls, that the captured block hashes are the chain's canonical
 * hashes; certifies with the public DEV key; verifies against the running
 * network (verified) and after stopping it (unverifiable: network offline).
 *
 * The sandbox is arm64 (RSK-31): this suite is meant for an x86_64 host
 * (CI: .github/workflows/resilience-live.yml). Set KAIZEN_ATTESTATION_DIR
 * to write the issued certificate + verification JSON for upload.
 */

import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDrillRecord,
  createEngine,
  parseCertificateBundle,
  verifyCertificateBundle,
  type KaizenEngine,
  type ScenarioInput,
} from '@kaizen/engine';
import { LIVE, SHARED_BIN_CACHE, ensureSharedBinary, httpRpc, testRoot, waitFor } from './testkit';

interface Health {
  peers: number;
}

describe.runIf(LIVE)('Proof-of-Resilience (live, real network)', () => {
  let engine: KaizenEngine;
  let dir: string;
  let networkId: string;
  let observerPort: number;
  let victimLabel: string;
  const out = process.env['KAIZEN_ATTESTATION_DIR'];

  beforeAll(async () => {
    await ensureSharedBinary();
    dir = testRoot('resilience');
    engine = createEngine({ dataDir: dir, binaryCacheDir: SHARED_BIN_CACHE, healthTimeoutMs: 120_000, resilienceCapture: true });
    const net = await engine.networks.create({ name: 'res-it', preset: 'two-node' });
    networkId = net.id;
    const { nodes } = engine.networks.getNetwork(networkId);
    observerPort = nodes[0]!.ports.rpc;
    victimLabel = nodes[1]!.name.replace('res-it-', '');
    const start = await engine.networks.start(networkId);
    expect(start.ok, JSON.stringify(start.error)).toBe(true);
    await waitFor(
      async () =>
        (await httpRpc<Health>(nodes[0]!.ports.rpc, 'system_health')).peers >= 1 &&
        (await httpRpc<Health>(nodes[1]!.ports.rpc, 'system_health')).peers >= 1,
      { timeoutMs: 90_000, label: 'peers >= 1' },
    );
    // wait for finality to move so the baseline is meaningful
    await waitFor(
      async () => Number.parseInt((await httpRpc<{ number: string }>(observerPort, 'chain_getHeader', [await httpRpc<string>(observerPort, 'chain_getFinalizedHead')])).number, 16) >= 2,
      { timeoutMs: 120_000, label: 'finalized >= 2' },
    );
  }, 300_000);

  afterAll(async () => {
    try {
      for (const n of engine.networks.list()) if (n.status === 'running' || n.status === 'starting') await engine.networks.stop(n.id);
    } finally {
      await engine.processes.killAll();
      await engine.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures chain evidence around a pause drill, certifies it, and verifies it against the chain', async () => {
    const scenario = engine.scenarios.create(
      {
        name: 'resilience pause drill',
        description: 'live proof-of-resilience test',
        requires: { designatedTest: true, preset: 'two-node' },
        steps: [
          {
            id: 's1',
            operation: { type: 'pause', config: { node: victimLabel, durationMs: 15_000 } },
            timeoutMs: 90_000,
            preconditions: [
              { kind: 'rpc-reachable', node: victimLabel, expect: true },
              { kind: 'process-state', node: victimLabel, expect: ['running'] },
            ],
            postconditions: [
              { kind: 'recovery-verified', node: victimLabel },
              { kind: 'rpc-reachable', node: victimLabel, expect: true },
            ],
          },
        ],
      } as unknown as ScenarioInput,
      'it',
    );
    const accepted = engine.scenarioRuns.execute({ scenarioId: scenario.id, networkIdOrName: networkId, mode: 'execute', requestedBy: 'it' });
    const run = await engine.scenarioRuns.wait(accepted.id, 180_000);
    expect(run.state).toBe('completed');
    await engine.resilience.idle();

    const ev = engine.resilience.getEvidence(run.id);
    expect(ev, 'evidence captured').not.toBeNull();
    expect(ev!.observations.map((o) => o.phase)).toContain('before-fault');
    expect(ev!.observations.map((o) => o.phase)).toContain('during-fault');
    expect(ev!.metrics.recovered).toBe(true);
    // Independent check: every captured hash is the canonical hash at that number.
    for (const o of ev!.observations) {
      expect(await httpRpc<string>(observerPort, 'chain_getBlockHash', [o.finalized.number])).toBe(o.finalized.hash);
    }

    // Commit-reveal drill record bound to a real finalized block of this chain.
    const seedNumber = ev!.observations[ev!.observations.length - 1]!.finalized.number;
    const seedHash = await httpRpc<string>(observerPort, 'chain_getBlockHash', [seedNumber]);
    const drill = buildDrillRecord({
      validatorId: ev!.validatorId,
      commitBlock: Math.max(0, seedNumber - 1),
      seedBlockNumber: seedNumber,
      seedBlockHash: seedHash,
    });
    const cert = await engine.resilience.certifyRun(run.id, { allowDevKey: true, drill });
    expect(cert.drill).toBeDefined();
    expect(ev!.observations.some((o) => o.finalized.author !== undefined || o.best.author !== undefined)).toBe(true);
    // GRANDPA finality evidence: finalized head advanced past the start and the lag was measured.
    expect(ev!.metrics.finalityGapBlocks).not.toBeNull();
    const finals = ev!.observations.map((o) => o.finalized.number);
    expect(finals[finals.length - 1]!).toBeGreaterThan(finals[0]!);
    expect(cert.signature.dev).toBe(true);
    const online = await engine.resilience.verify(cert.fingerprint);
    const score = await engine.resilience.score(cert.validatorId);
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, `certificate-${cert.fingerprint.slice(2, 14)}.json`), JSON.stringify(cert, null, 2));
      fs.writeFileSync(path.join(out, 'verification-online.json'), JSON.stringify(online, null, 2));
      fs.writeFileSync(path.join(out, 'score.json'), JSON.stringify(score, null, 2));
      // Public live demo: the persisted run record lets anyone recompute the
      // certificate fingerprint offline (sha256 of the canonical document).
      fs.writeFileSync(path.join(out, 'run.json'), JSON.stringify(engine.scenarioRuns.get(run.id), null, 2));
    }
    expect(online.status, online.reasons.join('; ')).toBe('verified');
    // The same certificate as a portable bundle, verified from the file contents alone
    // (no state store) against the live node: drill + BABE author + GRANDPA evidence in one document.
    const bundle = engine.resilience.exportBundle(cert.fingerprint);
    const fromBundle = await verifyCertificateBundle(
      parseCertificateBundle(JSON.stringify(bundle)),
      engine.resilience.readerForNetwork(networkId),
    );
    expect(fromBundle.status, fromBundle.reasons.join('; ')).toBe('verified');
    if (out) fs.writeFileSync(path.join(out, 'certificate.bundle.json'), JSON.stringify(bundle, null, 2));
    expect(score.runs).toBe(1);

    await engine.networks.stop(networkId);
    const offline = await engine.resilience.verify(cert.fingerprint);
    if (out) fs.writeFileSync(path.join(out, 'verification-offline.json'), JSON.stringify(offline, null, 2));
    expect(offline.status).toBe('unverifiable');
    expect(offline.chain.reason).toMatch(/network offline/);
  }, 400_000);
});
