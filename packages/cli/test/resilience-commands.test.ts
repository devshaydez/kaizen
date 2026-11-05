/**
 * CLI Proof-of-Resilience commands (T-9.5): certify / certificates / score /
 * verify-certificate over a REAL engine + temp dataDir. Evidence is seeded
 * directly (no node processes); the signer is the public DEV key.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { createEngine, type KaizenEngine, type ScenarioRunRecord } from '@kaizen/engine';
import { buildProgram } from '../src/program';

let dir: string;
const h = (n: number): string => `0x${n.toString(16).padStart(64, '0')}`;

function engineFactory(): KaizenEngine {
  return createEngine({ dataDir: dir, resilienceCapture: false });
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** exitOverride must cover subcommands (they are created inside buildProgram,
 *  before a root-level exitOverride() call could propagate). */
function enableExitOverride(cmd: Command): void {
  cmd.exitOverride();
  for (const sub of cmd.commands) enableExitOverride(sub);
}

async function runCli(
  argv: string[],
  factory: () => KaizenEngine = engineFactory,
): Promise<CliResult> {
  const program = buildProgram({ engineFactory: factory });
  let out = '';
  let err = '';
  enableExitOverride(program);
  program.configureOutput({
    writeOut: (str) => {
      out += str;
    },
    writeErr: (str) => {
      err += str;
    },
  });
  // Capture at ALL three levels: commander help/errors (configureOutput —
  // subcommands do not inherit it after buildProgram), human-mode
  // console.log/error, and printJson's direct process.stdout.write.
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out += `${args.join(' ')}\n`;
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err += `${args.join(' ')}\n`;
  });
  const outWriteSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      out += String(chunk);
      return true;
    });
  const errWriteSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      err += String(chunk);
      return true;
    });
  const savedExit = process.exitCode;
  process.exitCode = undefined;
  let code = 0;
  try {
    await program.parseAsync(['node', 'kaizen', ...argv]);
    code = process.exitCode ?? 0;
  } catch (e) {
    const exitCode = (e as { exitCode?: number }).exitCode;
    code = typeof exitCode === 'number' ? exitCode : 1;
  } finally {
    process.exitCode = savedExit;
    logSpy.mockRestore();
    errSpy.mockRestore();
    outWriteSpy.mockRestore();
    errWriteSpy.mockRestore();
  }
  return { code, stdout: out, stderr: err };
}

function json<T = Record<string, unknown>>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}


beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaizen-cli-res-'));
  const engine = engineFactory();
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
    faultStartedAt: at, faultEndedAt: '2026-10-24T00:01:00.000Z', recoveredAt: '2026-10-24T00:01:12.000Z',
    observations: [
      { phase: 'before-fault', at, best: { number: 10, hash: h(10) }, finalized: { number: 8, hash: h(8) } },
      { phase: 'during-fault', at: '2026-10-24T00:01:00.000Z', best: { number: 20, hash: h(20) }, finalized: { number: 15, hash: h(15) } },
      { phase: 'after-recovery', at: '2026-10-24T00:01:12.000Z', best: { number: 22, hash: h(22) }, finalized: { number: 19, hash: h(19) } },
    ],
    gaps: [],
    metrics: { recovered: true, timeToRecoverMs: 12_000, finalityGapBlocks: 5, blocksMissed: 0, expectedBlockTimeMs: 6_000 },
  });
  await engine.close();
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('kaizen certify / score', () => {
  let fingerprint = '';

  it('refuses to certify without a signer, then certifies with the labelled dev key', async () => {
    const saved = { ...process.env };
    delete process.env['KAIZEN_RESILIENCE_SIGNER_SURI'];
    delete process.env['KAIZEN_RESILIENCE_SIGNER_FILE'];
    try {
      const refused = await runCli(['--json', 'certify', 'run-done']);
      expect(refused.code).toBe(1);
      expect(json<{ error: { code: string } }>(refused).error.code).toBe('RESILIENCE_SIGNER_NOT_CONFIGURED');
      const r = await runCli(['certify', 'run-done', '--dev-key']);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('DEV KEY');
      expect(r.stdout).toContain('validator  : bob');
      const j = json<{ certificate: { fingerprint: string } }>(await runCli(['--json', 'certify', 'run-done', '--dev-key']));
      fingerprint = j.certificate.fingerprint;
      expect(fingerprint).toMatch(/^0x[0-9a-f]{64}$/);
    } finally {
      process.env = saved;
    }
  });

  it('lists certificates and scores the validator', async () => {
    const list = await runCli(['certificates', '--validator', 'bob']);
    expect(list.stdout).toContain(fingerprint);
    expect(list.stdout).toContain('[dev key]');
    const s = json<{ scores: { validatorId: string; score: number; runs: number }[] }>(await runCli(['--json', 'score', 'bob']));
    expect(s.scores).toHaveLength(1);
    expect(s.scores[0]).toMatchObject({ validatorId: 'bob', runs: 1 });
    expect(s.scores[0]!.score).toBeGreaterThan(0);
    const all = await runCli(['score']);
    expect(all.stdout).toMatch(/bob\s+\d+\/100/);
  });

  it('verify-certificate reports unverifiable (network offline) and exits 1', async () => {
    const r = await runCli(['verify-certificate', fingerprint]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('UNVERIFIABLE');
    expect(r.stdout).toContain('network offline');
  });
});
