/**
 * Proof-of-Resilience API (T-9.5): read-only routes over a real Fastify app
 * + real SQLite. A certificate is issued in-process with the public DEV key
 * (test material); there is no HTTP route that signs.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEngine, type KaizenEngine, type ScenarioRunRecord } from '@kaizen/engine';
import { createServer } from '../src/server';

const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

describe('resilience API', () => {
  let engine: KaizenEngine;
  let app: FastifyInstance;
  let dir: string;
  let fingerprint: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-res-api-'));
    engine = createEngine({ dataDir: dir, binaryCacheDir: path.join(dir, 'bin'), resilienceCapture: false });
    app = createServer(engine);
    await app.ready();
    const at = '2026-10-24T00:00:00.000Z';
    engine.store.insertNetwork({
      id: 'net_1', name: 'demo', preset: 'two-node', status: 'created', designatedTest: true,
      chain: 'local-spec', baseDir: path.join(dir, 'net'), createdAt: at,
    });
    engine.store.insertScenarioRun({
      id: 'run-done', scenarioId: 'scn', scenarioName: 'pause bob', scenarioSchemaVersion: 1,
      snapshot: { id: 'scn' }, networkId: 'net_1', networkName: 'demo', targetNodes: [], requestedBy: 'test',
      replayOfRunId: null, state: 'completed', currentStepId: null, currentStepOrder: null, steps: [],
      validation: null, warnings: [], error: null, cleanup: null, cancellation: null,
      createdAt: at, startedAt: at, updatedAt: at, finishedAt: at,
    } as unknown as ScenarioRunRecord);
    engine.store.upsertResilienceEvidence('run-done', {
      version: 1, networkId: 'net_1', validatorId: 'bob', observerNodeId: 'n-alice', genesisHash: h(0),
      faultStartedAt: at, faultEndedAt: '2026-10-24T00:00:06.000Z', recoveredAt: '2026-10-24T00:00:12.000Z',
      observations: [
        { phase: 'before-fault', at, best: { number: 10, hash: h(10) }, finalized: { number: 8, hash: h(8) } },
        { phase: 'during-fault', at: '2026-10-24T00:00:06.000Z', best: { number: 11, hash: h(11) }, finalized: { number: 8, hash: h(8) } },
        { phase: 'after-recovery', at: '2026-10-24T00:00:12.000Z', best: { number: 13, hash: h(13) }, finalized: { number: 11, hash: h(11) } },
      ],
      gaps: [],
      metrics: { recovered: true, timeToRecoverMs: 6_000, finalityGapBlocks: 3, blocksMissed: 0, expectedBlockTimeMs: 6_000 },
    });
    fingerprint = (await engine.resilience.certifyRun('run-done', { allowDevKey: true })).fingerprint;
  });

  afterAll(async () => {
    await app.close();
    await engine.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves scores for all validators and one validator', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/resilience/scores' });
    expect(all.statusCode).toBe(200);
    expect(all.json().scores.map((s: { validatorId: string }) => s.validatorId)).toEqual(['bob']);
    const one = await app.inject({ method: 'GET', url: '/api/resilience/scores/bob' });
    expect(one.json().score).toMatchObject({ validatorId: 'bob', runs: 1, version: 2 });
    const none = await app.inject({ method: 'GET', url: '/api/resilience/scores/nobody' });
    expect(none.json().score).toMatchObject({ score: 0, runs: 0 });
  });

  it('lists and fetches certificates; validates params; 404 for unknown', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/resilience/certificates?validator=bob' });
    expect(list.json().certificates).toHaveLength(1);
    const one = await app.inject({ method: 'GET', url: `/api/resilience/certificates/${fingerprint}` });
    expect(one.json().certificate.signature).toMatchObject({ dev: true, scheme: 'sr25519' });
    expect(one.body).not.toContain('//Alice');
    expect((await app.inject({ method: 'GET', url: '/api/resilience/certificates/xyz' })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: `/api/resilience/certificates/0x${'0'.repeat(64)}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('RESILIENCE_CERTIFICATE_NOT_FOUND');
  });

  it('verify reports unverifiable when the network is offline; evidence is readable', async () => {
    const v = await app.inject({ method: 'POST', url: `/api/resilience/certificates/${fingerprint}/verify` });
    expect(v.statusCode).toBe(200);
    expect(v.json().verification.status).toBe('unverifiable');
    const ev = await app.inject({ method: 'GET', url: '/api/resilience/runs/run-done/evidence' });
    expect(ev.json().evidence.validatorId).toBe('bob');
  });

  it('exposes no signing route', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/resilience/certificates', payload: { runId: 'run-done' } });
    expect(res.statusCode).toBe(404);
  });
});
