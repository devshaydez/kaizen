/**
 * CLI Proof-of-Resilience commands (T-9.5): certify / certificates / score /
 * verify-certificate over a REAL engine + temp dataDir. Evidence is seeded
 * directly (no node processes); the signer is the public DEV key.
 */

import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
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
      { phase: 'after-recovery', at: '2026-10-24T00:01:12.000Z', best: { number: 16, hash: h(16) }, finalized: { number: 13, hash: h(13) } },
    ],
    gaps: [],
    metrics: { recovered: true, timeToRecoverMs: 12_000, finalityGapBlocks: 3, blocksMissed: 2, expectedBlockTimeMs: 6_000 },
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

  it('score --v2 discounts signed-local evidence and never upgrades it when the network is offline', async () => {
    type Scores = { scores: { confidence: number; effectiveRuns: number; score: number }[] };
    const v1 = json<Scores>(await runCli(['--json', 'score', 'bob'])).scores[0]!;
    const v2 = json<Scores>(await runCli(['--json', 'score', 'bob', '--v2'])).scores[0]!;
    expect(v2.effectiveRuns / v1.effectiveRuns).toBeCloseTo(0.7, 3);
    expect(v2.confidence).toBeLessThan(v1.confidence);
    const offline = json<Scores>(await runCli(['--json', 'score', 'bob', '--v2', '--verify-chain'])).scores[0]!;
    expect(offline.effectiveRuns).toBeCloseTo(v2.effectiveRuns, 4);
    const misuse = await runCli(['--json', 'score', 'bob', '--verify-chain']);
    expect(misuse.code).toBe(1);
  });

  it('verify-certificate reports unverifiable (network offline) and exits 1', async () => {
    const r = await runCli(['verify-certificate', fingerprint]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('UNVERIFIABLE');
    expect(r.stdout).toContain('network offline');
  });

  describe('portable bundle', () => {
    let bundleFile = '';
    let server: http.Server;
    let rpcUrl = '';
    let tamper = false;

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += String(c)));
        req.on('end', () => {
          const { params } = JSON.parse(body) as { params: number[] };
          const n = params[0]!;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: tamper ? h(n + 1000) : h(n) }));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      bundleFile = path.join(dir, 'bundle.json');
    });

    afterAll(async () => {
      await new Promise((r) => server.close(r));
    });

    it('exports a bundle and verifies it from the file against an RPC endpoint', async () => {
      const exp = await runCli(['--json', 'export-certificate', fingerprint, '--out', bundleFile]);
      expect(exp.code).toBe(0);
      const ok = await runCli(['--json', 'verify-certificate', '--bundle', bundleFile, '--rpc', rpcUrl]);
      expect(ok.code, ok.stdout).toBe(0);
      expect(json<{ verification: { status: string } }>(ok).verification.status).toBe('verified');
    });

    it('is unverifiable without --rpc and mismatches when the chain disagrees', async () => {
      const offline = await runCli(['verify-certificate', '--bundle', bundleFile]);
      expect(offline.code).toBe(1);
      expect(offline.stdout).toContain('UNVERIFIABLE');
      tamper = true;
      const bad = await runCli(['verify-certificate', '--bundle', bundleFile, '--rpc', rpcUrl]);
      tamper = false;
      expect(bad.code).toBe(1);
      expect(bad.stdout).toContain('MISMATCH');
    });

    it('detects an edited bundle and rejects malformed input', async () => {
      const edited = JSON.parse(fs.readFileSync(bundleFile, 'utf8')) as { certificate: { chain: { metrics: { timeToRecoverMs: number } } } };
      edited.certificate.chain.metrics.timeToRecoverMs = 1;
      const editedFile = path.join(dir, 'edited.json');
      fs.writeFileSync(editedFile, JSON.stringify(edited));
      const r = await runCli(['verify-certificate', '--bundle', editedFile, '--rpc', rpcUrl]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain('MISMATCH');
      expect(r.stdout).toContain('fingerprint does not match');
      const junk = path.join(dir, 'junk.json');
      fs.writeFileSync(junk, '{"hello":1}');
      const bad = await runCli(['--json', 'verify-certificate', '--bundle', junk]);
      expect(bad.code).toBe(1);
      expect(json<{ error: { code: string } }>(bad).error.code).toBe('INVALID_INPUT');
      const none = await runCli(['--json', 'verify-certificate']);
      expect(none.code).toBe(1);
    });
  });
});

describe('kaizen attest (A2)', () => {
  let server: http.Server;
  let rpcUrl = '';
  let attestFingerprint = '';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        const { params } = JSON.parse(body) as { params: number[] };
        const n = params[0]!;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: h(n) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    rpcUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const certs = json<{ certificates: { fingerprint: string }[] }>(
      await runCli(['--json', 'certificates', '--validator', 'bob']),
    );
    expect(certs.certificates.length).toBeGreaterThan(0);
    attestFingerprint = certs.certificates[0]!.fingerprint;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it('refuses to attest without KAIZEN_ATTESTER_SURI', async () => {
    const saved = { ...process.env };
    delete process.env['KAIZEN_ATTESTER_SURI'];
    delete process.env['KAIZEN_ATTESTER_SURI_FILE'];
    try {
      const r = await runCli(['--json', 'attest', attestFingerprint, '--rpc', rpcUrl]);
      expect(r.code).toBe(1);
      expect(json<{ error: { code: string } }>(r).error.code).toBe('ATTESTATION_SIGNER_NOT_CONFIGURED');
    } finally {
      process.env = saved;
    }
  });

  it('attests with an independent key after a full chain match; verify-certificate lists it; score --v2 upgrades to 1.0', async () => {
    const saved = { ...process.env };
    process.env['KAIZEN_ATTESTER_SURI'] = '//Bob';
    type Scores = { scores: { effectiveRuns: number }[] };
    const before = json<Scores>(await runCli(['--json', 'score', 'bob', '--v2'])).scores[0]!;
    const r = await runCli(['--json', 'attest', attestFingerprint, '--rpc', rpcUrl]);
    expect(r.code, r.stdout).toBe(0);
    const att = json<{ attestation: { verdict: string; certificateFingerprint: string; attester: { address: string } } }>(r).attestation;
    expect(att.verdict).toBe('verified');
    expect(att.certificateFingerprint).toBe(attestFingerprint);
    // the certificate is signed by the dev //Alice key; the attester must differ
    expect(att.attester.address).not.toBe('5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY');

    const v = await runCli(['verify-certificate', attestFingerprint, '--rpc', rpcUrl]);
    expect(v.code, v.stdout).toBe(0);
    expect(v.stdout).toContain('attestations: 1');
    expect(v.stdout).toContain('verified');

    const after = json<Scores>(await runCli(['--json', 'score', 'bob', '--v2'])).scores[0]!;
    expect(after.effectiveRuns / before.effectiveRuns).toBeCloseTo(1 / 0.7, 3);
    const withNotes = json<{ scores: { notes: number }[] }>(await runCli(['--json', 'score', 'bob', '--v2']));
    expect(withNotes.scores[0]!.notes).toEqual([]);
    process.env = saved;
  });

  it('refuses to attest an unknown certificate (exit 1)', async () => {
    const r = await runCli(['--json', 'attest', '0x' + '9'.repeat(64), '--rpc', rpcUrl]);
    expect(r.code).toBe(1);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('RESILIENCE_CERTIFICATE_NOT_FOUND');
  });
});
