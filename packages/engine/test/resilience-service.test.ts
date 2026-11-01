/**
 * ResilienceService (T-9.5): event-driven chain-evidence capture, explicit
 * certification, scoring, and verification over a real SQLite store with a
 * scripted chain (no node processes). Dev key = public `//Alice`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EventBus,
  ResilienceService,
  StateStore,
  isKaizenError,
  type ChainReader,
  type NodeConfig,
  type NodeRecord,
} from '@kaizen/engine';
import { fixtureRun, hashOf } from './resilience-fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

/** A shared fake chain whose heads the test advances. */
class FakeChain {
  best = 100;
  finalized = 98;
  online = true;
  readsBy: string[] = [];
  readerFor(node: NodeRecord): ChainReader {
    return {
      readHeads: async () => {
        this.readsBy.push(node.id);
        if (!this.online) throw new Error('ECONNREFUSED');
        return {
          best: { number: this.best, hash: hashOf(this.best) },
          finalized: { number: this.finalized, hash: hashOf(this.finalized) },
          genesisHash: hashOf(0),
        };
      },
      blockHashAt: async (n: number) => (n <= this.best ? hashOf(n) : null),
      genesisHash: async () => hashOf(0),
    };
  }
}

function setup(opts: { designatedTest?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-res-'));
  const store = new StateStore(':memory:');
  const events = new EventBus();
  cleanups.push(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const now = new Date().toISOString();
  store.insertNetwork({
    id: 'net_1',
    name: 'demo',
    preset: 'two-node',
    status: 'created',
    designatedTest: opts.designatedTest ?? true,
    chain: 'local-spec',
    baseDir: dir,
    createdAt: now,
  });
  for (const [i, label] of ['alice', 'bob'].entries()) {
    const config: NodeConfig = {
      id: `n-${label}`,
      networkId: 'net_1',
      name: label,
      role: 'validator',
      chain: 'local-spec',
      wellKnownKey: label as 'alice' | 'bob',
      bootnodes: [],
      baseDir: path.join(dir, label),
      nodeKeyFile: path.join(dir, `${label}.key`),
      logFile: path.join(dir, `${label}.log`),
      ports: { p2p: 30000 + i, rpc: 31000 + i, ws: 32000 + i, prometheus: 33000 + i },
      expectedPeers: 1,
    };
    store.insertNode({ config, status: 'running', createdAt: now });
  }
  const chain = new FakeChain();
  const svc = new ResilienceService({
    store,
    events,
    capture: true,
    readerForNode: (n) => chain.readerFor(n),
    recoveryTimeoutMs: 10_000,
    recoveryIntervalMs: 1,
    env: {},
  });
  cleanups.push(() => void svc.close());
  const run = fixtureRun({ id: 'run-1', networkId: 'net_1' });
  store.insertScenarioRun(run);
  return { store, events, chain, svc, run };
}

const at = () => new Date().toISOString();

function faultEvent(events: EventBus, to: 'executing' | 'cleaning-up' | 'completed') {
  events.emit('fault.state', {
    faultId: 'f1',
    networkId: 'net_1',
    nodeId: 'n-bob',
    nodeName: 'bob',
    type: 'pause',
    from: 'ready',
    to,
    at: at(),
  });
}

describe('ResilienceService capture', () => {
  it('captures before/during/after evidence from a non-target observer and stores it per run', async () => {
    const { events, chain, svc } = setup();
    events.emit('scenario-run.created', {
      runId: 'run-1',
      scenarioId: 'scn-1',
      scenarioName: 'pause bob',
      networkId: 'net_1',
      requestedBy: 'test',
      steps: 1,
      at: at(),
    });
    await svc.idle();
    faultEvent(events, 'executing');
    await svc.idle();
    chain.best = 103; // production continues, finality stalls
    faultEvent(events, 'cleaning-up');
    await svc.idle();
    chain.best = 106;
    chain.finalized = 104; // finality resumes
    events.emit('scenario-run.finished', {
      runId: 'run-1',
      scenarioId: 'scn-1',
      networkId: 'net_1',
      state: 'completed',
      stepCount: 1,
      warnings: 0,
      at: at(),
    });
    await svc.idle();
    const ev = svc.getEvidence('run-1');
    expect(ev).not.toBeNull();
    expect(ev!.validatorId).toBe('bob');
    expect(ev!.observerNodeId).toBe('n-alice');
    expect(ev!.observations.map((o) => o.phase)).toEqual(['before-fault', 'during-fault', 'during-fault', 'after-recovery']);
    expect(ev!.metrics.recovered).toBe(true);
    expect(ev!.metrics.finalityGapBlocks).toBe(5);
    expect(new Set(chain.readsBy)).toEqual(new Set(['n-alice']));
  });

  it('stores nothing when no fault executed, and nothing for an unknown run', async () => {
    const { events, svc } = setup();
    events.emit('scenario-run.created', { runId: 'run-1', scenarioId: 's', scenarioName: 's', networkId: 'net_1', requestedBy: 't', steps: 0, at: at() });
    events.emit('scenario-run.finished', { runId: 'run-1', scenarioId: 's', networkId: 'net_1', state: 'completed', stepCount: 0, warnings: 0, at: at() });
    events.emit('scenario-run.finished', { runId: 'other', scenarioId: 's', networkId: 'net_9', state: 'completed', stepCount: 0, warnings: 0, at: at() });
    await svc.idle();
    expect(svc.getEvidence('run-1')).toBeNull();
  });

  it('is off unless enabled', async () => {
    const store = new StateStore(':memory:');
    cleanups.push(() => store.close());
    const svc = new ResilienceService({ store, events: new EventBus(), env: {} });
    expect(svc.captureEnabled).toBe(false);
    expect(new ResilienceService({ store, events: new EventBus(), env: { KAIZEN_RESILIENCE_EVIDENCE: '1' } }).captureEnabled).toBe(true);
  });
});

describe('ResilienceService certify / score / verify', () => {
  async function captured() {
    const s = setup();
    s.store.upsertResilienceEvidence('run-1', {
      version: 1,
      networkId: 'net_1',
      validatorId: 'bob',
      observerNodeId: 'n-alice',
      genesisHash: hashOf(0),
      faultStartedAt: '2026-10-24T00:00:01.000Z',
      faultEndedAt: '2026-10-24T00:01:00.000Z',
      recoveredAt: '2026-10-24T00:01:12.000Z',
      observations: [
        { phase: 'before-fault', at: '2026-10-24T00:00:00.000Z', best: { number: 100, hash: hashOf(100) }, finalized: { number: 98, hash: hashOf(98) } },
        { phase: 'after-recovery', at: '2026-10-24T00:01:12.000Z', best: { number: 106, hash: hashOf(106) }, finalized: { number: 103, hash: hashOf(103) } },
      ],
      gaps: [],
      metrics: { recovered: true, timeToRecoverMs: 12_000, finalityGapBlocks: 3, blocksMissed: null, expectedBlockTimeMs: 6_000 },
    });
    return s;
  }

  it('certifies with the dev key only for designated-test networks, idempotently, and emits an event', async () => {
    const { svc, events } = await captured();
    const seen: string[] = [];
    events.subscribe((name) => seen.push(name));
    const cert = await svc.certifyRun('run-1', { allowDevKey: true });
    expect(cert.signature.dev).toBe(true);
    const again = await svc.certifyRun('run-1', { allowDevKey: true });
    expect(again.fingerprint).toBe(cert.fingerprint);
    expect(svc.listCertificates({ validatorId: 'bob' })).toHaveLength(1);
    expect(seen.filter((n) => n === 'resilience.certified')).toHaveLength(1);
    expect(svc.listValidators()).toEqual(['bob']);
  });

  it('refuses certification without evidence or without a signer', async () => {
    const { svc, store } = setup();
    await expect(svc.certifyRun('run-1', { allowDevKey: true })).rejects.toSatisfy(
      (e: unknown) => isKaizenError(e) && e.code === 'RESILIENCE_NOT_CERTIFIABLE',
    );
    store.upsertResilienceEvidence('run-1', { ...(await captured()).svc.getEvidence('run-1')! });
    await expect(svc.certifyRun('run-1')).rejects.toSatisfy(
      (e: unknown) => isKaizenError(e) && e.code === 'RESILIENCE_SIGNER_NOT_CONFIGURED',
    );
  });

  it('scores from certificates and verifies against the chain (offline → unverifiable)', async () => {
    const { svc, chain, store } = await captured();
    const cert = await svc.certifyRun('run-1', { allowDevKey: true });
    chain.best = 110;
    const score = await svc.score('bob', new Date(cert.signedAt));
    expect(score.runs).toBe(1);
    expect(score.excluded).toEqual([]);
    expect(score.score).toBeGreaterThan(0);
    expect((await svc.verify(cert.fingerprint)).status).toBe('verified');
    for (const n of store.listNodes('net_1')) store.updateNodeStatus(n.id, 'stopped', null);
    const off = await svc.verify(cert.fingerprint);
    expect(off.status).toBe('unverifiable');
    expect(off.chain.reason).toMatch(/network offline/);
    expect(() => svc.getCertificate('0xnope')).toThrow();
  });

  it.each([
    ['validatorId', { validatorId: 'alice' }],
    ['networkId', { networkId: 'net_2' }],
    ['runHash', { runHash: `0x${'00'.repeat(32)}` }],
    ['run id', { runId: 'other-run' }],
  ] as const)('excludes a score certificate with tampered top-level %s metadata', async (_field, tampering) => {
    const { svc, store } = await captured();
    const cert = await svc.certifyRun('run-1', { allowDevKey: true });
    const database = (store as unknown as {
      db: { prepare(sql: string): { run(...args: unknown[]): unknown } };
    }).db;
    database.prepare('UPDATE resilience_certificates SET certificate = ? WHERE fingerprint = ?').run(
      JSON.stringify({ ...cert, ...tampering }),
      cert.fingerprint,
    );
    const score = await svc.score('bob', new Date(cert.signedAt));
    expect(score.runs).toBe(0);
    expect(score.excluded).toEqual([cert.fingerprint]);
  });
});
