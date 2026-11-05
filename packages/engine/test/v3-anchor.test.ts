/**
 * V3 run anchoring unit tests (T-8.2). Offline: the chain is a scripted
 * fake `V3ChainConnector`; the store is a real SQLite store; the signer is a
 * real sr25519 pair derived from a well-known DEV URI (`//Alice` — public
 * test material, never a real secret). Live coverage:
 * test/integration/v3-anchor.int.test.ts (gated KAIZEN_TEST_V3_WRITE=1).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  EventBus,
  KAIZEN_RUN_REGISTRY_ARTIFACT,
  REGISTRY_SIGNATURES,
  RUN_ANCHORED_TOPIC,
  StateStore,
  V3AnchorService,
  canonicalJson,
  computeRunHash,
  decodeRunAnchoredLog,
  decodeUintReturn,
  encodeAnchorCall,
  encodeAnchoredAtCall,
  isKaizenError,
  loadV3Signer,
  makeScrubber,
  remarkPayload,
  runAnchorMeta,
  selectorOf,
  type KaizenEventMap,
  type RegistryLog,
  type ScenarioRunRecord,
  type V3ChainConnector,
  type V3ChainInfo,
  type V3ChainSession,
  type V3TxReceipt,
} from '@kaizen/engine';
import { redactDeep, redactSecrets } from '../src/fault/redact';

const DEV_SURI = '//Alice';
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const GENESIS = '0x' + 'd4'.repeat(32);
const REGISTRY = '0x' + 'ab'.repeat(20);

const stores: StateStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});

function makeRun(store: StateStore, overrides: Partial<ScenarioRunRecord> = {}): ScenarioRunRecord {
  const at = '2026-10-21T10:00:00.000Z';
  const record = {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    scenarioId: 'scn-1',
    scenarioName: 'pause alice',
    scenarioSchemaVersion: 1,
    snapshot: { id: 'scn-1', name: 'pause alice', schemaVersion: 1, steps: [] },
    networkId: 'net_1',
    networkName: 'demo',
    targetNodes: [],
    requestedBy: 'test',
    replayOfRunId: null,
    state: 'completed',
    currentStepId: null,
    currentStepOrder: null,
    steps: [],
    validation: null,
    warnings: [],
    error: null,
    cleanup: null,
    cancellation: null,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
    finishedAt: at,
    ...overrides,
  } as unknown as ScenarioRunRecord;
  store.insertScenarioRun(record);
  return store.getScenarioRun(record.id);
}

interface FakeOptions {
  balance?: bigint;
  failSubmit?: Error;
  dropLog?: boolean;
  noRemarkEvent?: boolean;
  finalized?: boolean;
  anchoredAt?: bigint;
  connectError?: Error;
  blockHashAt?: string | null;
  remarkText?: string | null;
  txSuccess?: boolean;
}

class FakeChain implements V3ChainConnector {
  calls: { kind: string; args: unknown[] }[] = [];
  closed = 0;
  constructor(public opts: FakeOptions = {}) {}

  receipt(overrides: Partial<V3TxReceipt> = {}): V3TxReceipt {
    return {
      txHash: '0x' + '11'.repeat(32),
      blockHash: '0x' + '22'.repeat(32),
      blockNumber: 4242,
      extrinsicIndex: 2,
      finalized: this.opts.finalized ?? true,
      events: ['system.ExtrinsicSuccess'],
      logs: [],
      instantiated: null,
      remarkHash: null,
      ...overrides,
    };
  }

  async connect(): Promise<V3ChainSession> {
    if (this.opts.connectError) throw this.opts.connectError;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- closure-heavy fake session
    const self = this;
    const info: V3ChainInfo = {
      chainName: 'PortaldotV3 Test',
      genesisHash: GENESIS,
      specName: 'portaldot-v3',
      specVersion: 3002,
      tokenSymbol: 'tPOT',
      tokenDecimals: 14,
      bestNumber: 5000,
    };
    return {
      info: async () => info,
      freeBalance: async () => self.opts.balance ?? 10n ** 16n,
      evmAddressOf: async () => '0x' + '31'.repeat(20),
      blockHashAt: async () => (self.opts.blockHashAt !== undefined ? self.opts.blockHashAt : '0x' + '22'.repeat(32)),
      deploymentAt: async (_b, tx) =>
        tx === '0x' + '00'.repeat(32)
          ? null
          : { contract: tx === '0x' + '33'.repeat(32) ? null : REGISTRY, signer: ALICE, blockNumber: 4000, success: true, events: ['revive.Instantiated'] },
      extrinsicAt: async (_b, tx) =>
        tx === '0x' + '00'.repeat(32)
          ? null
          : {
              signer: ALICE,
              blockNumber: 4242,
              success: self.opts.txSuccess ?? true,
              events: ['system.ExtrinsicSuccess'],
              logs: [],
              remarkHash: null,
              instantiated: null,
            },
      remarkAt: async () => (self.opts.remarkText !== undefined ? self.opts.remarkText : null),
      submitRemark: async (_signer, payload) => {
        self.calls.push({ kind: 'remark', args: [payload] });
        if (self.opts.failSubmit) throw self.opts.failSubmit;
        return self.receipt({
          events: self.opts.noRemarkEvent ? ['system.ExtrinsicSuccess'] : ['system.Remarked', 'system.ExtrinsicSuccess'],
        });
      },
      deployContract: async (_signer, code) => {
        self.calls.push({ kind: 'deploy', args: [code] });
        if (self.opts.failSubmit) throw self.opts.failSubmit;
        return self.receipt({ instantiated: REGISTRY, events: ['revive.Instantiated', 'system.ExtrinsicSuccess'] });
      },
      callContract: async (_signer, contract, calldata) => {
        self.calls.push({ kind: 'call', args: [contract, calldata] });
        if (self.opts.failSubmit) throw self.opts.failSubmit;
        const runHash = '0x' + calldata.slice(10, 74);
        const meta = 'kaizen';
        const log: RegistryLog = {
          contract,
          topics: [RUN_ANCHORED_TOPIC, runHash, '0x' + '00'.repeat(12) + '31'.repeat(20)],
          data:
            '0x' +
            (1_761_000_000).toString(16).padStart(64, '0') +
            (64).toString(16).padStart(64, '0') +
            meta.length.toString(16).padStart(64, '0') +
            Buffer.from(meta).toString('hex').padEnd(64, '0'),
        };
        return self.receipt({ logs: self.opts.dropLog ? [] : [log], events: ['revive.ContractEmitted', 'system.ExtrinsicSuccess'] });
      },
      readContract: async (_origin, contract, calldata) => {
        self.calls.push({ kind: 'read', args: [contract, calldata] });
        return '0x' + (self.opts.anchoredAt ?? 1_761_000_000n).toString(16).padStart(64, '0');
      },
      close: async () => {
        self.closed += 1;
      },
    };
  }
}

function setup(opts: FakeOptions = {}, env: NodeJS.ProcessEnv = { KAIZEN_V3_SIGNER_SURI: DEV_SURI }) {
  const store = new StateStore(':memory:');
  stores.push(store);
  const events = new EventBus();
  const seen: KaizenEventMap['v3.anchor'][] = [];
  events.subscribe((name, payload) => {
    if (name === 'v3.anchor') seen.push(payload as KaizenEventMap['v3.anchor']);
  });
  const chain = new FakeChain(opts);
  const evmRpc = {
    post: async (input: { method: string }) => ({
      httpStatus: 200,
      json: {
        jsonrpc: '2.0',
        id: 1,
        result: input.method === 'eth_chainId' ? `0x${(420420777).toString(16)}` : '0x6080',
      },
      id: 1,
    }),
  };
  const svc = new V3AnchorService({ store, events, connector: chain, env, evmRpc });
  return { store, events, seen, chain, svc };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(isKaizenError(e) ? e.code : String(e)).toBe(code);
    return e as Error;
  }
  throw new Error(`expected ${code}, resolved instead`);
}

// ---------------------------------------------------------------------------

describe('canonical run hash', () => {
  it('is key-order independent and stable across store round trips', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 'x', c: null }], u: undefined })).toBe('{"a":[1,{"c":null,"d":"x"}],"b":1}');
    const store = new StateStore(':memory:');
    stores.push(store);
    const run = makeRun(store);
    const again = store.getScenarioRun(run.id);
    expect(computeRunHash(run)).toBe(computeRunHash(again));
    expect(computeRunHash(run)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('changes when any recorded field changes', () => {
    const store = new StateStore(':memory:');
    stores.push(store);
    const a = makeRun(store, { id: 'run-a' });
    const b = { ...a, warnings: ['x'] } as ScenarioRunRecord;
    expect(computeRunHash(a)).not.toBe(computeRunHash(b));
  });

  it('refuses values JSON cannot represent', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ b: 10n })).toThrow(/unsupported bigint/);
  });

  it('builds bounded, secret-free meta and remark payloads', () => {
    const meta = runAnchorMeta({ id: 'run-1', scenarioName: 'evil;name\n', state: 'completed' });
    expect(meta).toBe('kaizen:v1:run=run-1:scenario=evil_name_:state=completed');
    expect(remarkPayload('0x' + 'aa'.repeat(32), 'run-1')).toBe(`kaizen:v1:0x${'aa'.repeat(32)}:run-1`);
  });
});

describe('registry ABI codec', () => {
  it('derives selectors that match solc methodIdentifiers in the committed artifact', () => {
    const ids = KAIZEN_RUN_REGISTRY_ARTIFACT.methodIdentifiers as Record<string, string>;
    expect(selectorOf(REGISTRY_SIGNATURES.anchor)).toBe(`0x${ids['anchor(bytes32,string)']}`);
    expect(selectorOf(REGISTRY_SIGNATURES.anchoredAt)).toBe(`0x${ids['anchoredAt(bytes32)']}`);
    expect(selectorOf(REGISTRY_SIGNATURES.totalAnchors)).toBe(`0x${ids['totalAnchors()']}`);
    expect(KAIZEN_RUN_REGISTRY_ARTIFACT.bytecode).toMatch(/^0x60806040/);
  });

  it('encodes anchor(bytes32,string) with the dynamic string tail', () => {
    const hash = '0x' + 'cd'.repeat(32);
    const data = encodeAnchorCall(hash, 'hi');
    expect(data.slice(0, 10)).toBe('0x1a8512ea');
    const body = data.slice(10);
    expect(body.slice(0, 64)).toBe('cd'.repeat(32));
    expect(BigInt('0x' + body.slice(64, 128))).toBe(64n);
    expect(BigInt('0x' + body.slice(128, 192))).toBe(2n);
    expect(body.slice(192)).toBe('6869'.padEnd(64, '0'));
    expect(encodeAnchoredAtCall(hash)).toBe('0x9591a610' + 'cd'.repeat(32));
    expect(() => encodeAnchorCall('0x12', 'x')).toThrow(/32 bytes/);
    expect(() => encodeAnchorCall(hash, 'x'.repeat(257))).toThrow(/256/);
  });

  it('decodes RunAnchored logs and uint returns; ignores foreign logs', () => {
    const runHash = '0x' + 'ee'.repeat(32);
    const meta = 'kaizen:v1:run=r';
    const log: RegistryLog = {
      contract: REGISTRY,
      topics: [RUN_ANCHORED_TOPIC, runHash, '0x' + '00'.repeat(12) + '31'.repeat(20)],
      data:
        '0x' +
        (7).toString(16).padStart(64, '0') +
        (64).toString(16).padStart(64, '0') +
        meta.length.toString(16).padStart(64, '0') +
        Buffer.from(meta).toString('hex').padEnd(64, '0'),
    };
    expect(decodeRunAnchoredLog(log)).toEqual({ runHash, submitter: '0x' + '31'.repeat(20), anchoredAt: 7n, meta });
    expect(decodeRunAnchoredLog({ ...log, topics: ['0x' + '00'.repeat(32), runHash, runHash] })).toBeNull();
    expect(decodeUintReturn('0x' + '0'.repeat(63) + 'f')).toBe(15n);
    expect(() => decodeUintReturn('0x12')).toThrow(/malformed/);
  });
});

describe('V3 signer handling', () => {
  it('derives only the public address and refuses missing/invalid secrets without echoing them', async () => {
    const signer = await loadV3Signer({ KAIZEN_V3_SIGNER_SURI: DEV_SURI });
    expect(signer.address).toBe(ALICE);
    await expectCode(loadV3Signer({}), 'V3_SIGNER_NOT_CONFIGURED');
    const bad = 'not a valid uri at all !!!';
    const err = await expectCode(loadV3Signer({ KAIZEN_V3_SIGNER_SURI: bad }), 'V3_SIGNER_INVALID');
    expect(err.message).not.toContain(bad);
  });

  it('scrubs the exact secret and mnemonic fragments; redaction covers SURI assignments', () => {
    const phrase = 'bottom drive obey lake curtain smoke basket hold race lonely fit walk';
    const scrub = makeScrubber(phrase);
    expect(scrub(`boom: ${phrase}`)).not.toContain('curtain smoke basket');
    expect(scrub('leak drive obey lake here')).toBe('leak [redacted] here');
    expect(redactSecrets('KAIZEN_V3_SIGNER_SURI=//Secret//path')).toBe('[redacted]');
    expect(redactDeep({ suri: 'x', signerSuri: 'y', measuring: 'ok' })).toEqual({
      suri: '[redacted]',
      signerSuri: '[redacted]',
      measuring: 'ok',
    });
  });
});

describe('V3AnchorService', () => {
  it('anchors via the remark method when explicitly chosen and persists chain evidence', async () => {
    const { svc, store, seen, chain } = setup();
    const run = makeRun(store);
    const anchor = await svc.anchorRun(run.id, { method: 'remark', requestedBy: 'cli' });
    expect(anchor).toMatchObject({
      runId: run.id,
      runHash: computeRunHash(run),
      method: 'remark',
      status: 'finalized',
      payload: remarkPayload(computeRunHash(run), run.id),
      contractAddress: null,
      signerAddress: ALICE,
      genesisHash: GENESIS,
      txHash: '0x' + '11'.repeat(32),
      blockNumber: 4242,
      extrinsicIndex: 2,
      requestedBy: 'cli',
      error: null,
    });
    expect(chain.calls).toEqual([{ kind: 'remark', args: [anchor.payload] }]);
    expect(seen.map((e) => e.status)).toEqual(['pending', 'finalized']);
    expect(store.listV3Anchors({ runId: run.id })).toHaveLength(1);
    expect(chain.closed).toBe(1);
  });

  it('requires a registry (or an explicit remark choice) — never silently falls back', async () => {
    const { svc, store, chain } = setup();
    const run = makeRun(store);
    await expectCode(svc.anchorRun(run.id), 'V3_REGISTRY_NOT_DEPLOYED');
    await expectCode(svc.anchorRun(run.id, { method: 'contract' }), 'V3_REGISTRY_NOT_DEPLOYED');
    expect(chain.calls).toEqual([]);
    expect(store.listV3Anchors()).toEqual([]);
  });

  it('deploys the registry, records it, and then anchors through the contract by default', async () => {
    const { svc, store, chain } = setup();
    const deployed = await svc.deployRegistry();
    expect(deployed).toMatchObject({ address: REGISTRY, genesisHash: GENESIS, blockNumber: 4242, deployerAddress: ALICE });
    expect(chain.calls[0]).toEqual({ kind: 'deploy', args: [KAIZEN_RUN_REGISTRY_ARTIFACT.bytecode] });
    expect(svc.contracts()).toHaveLength(1);

    const run = makeRun(store);
    const anchor = await svc.anchorRun(run.id);
    expect(anchor.method).toBe('contract');
    expect(anchor.contractAddress).toBe(REGISTRY);
    expect(anchor.status).toBe('finalized');
    expect(chain.calls[1]).toEqual({ kind: 'call', args: [REGISTRY, encodeAnchorCall(anchor.runHash, anchor.payload)] });
  });

  it('honours KAIZEN_V3_REGISTRY_ADDRESS and validates it', async () => {
    const { svc, store } = setup({}, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY.toUpperCase().replace('0X', '0x') });
    const run = makeRun(store);
    expect((await svc.anchorRun(run.id)).contractAddress).toBe(REGISTRY);
    const bad = setup({}, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: 'nope' });
    await expectCode(bad.svc.anchorRun(makeRun(bad.store).id), 'INVALID_INPUT');
  });

  it('marks an included tx without the expected RunAnchored log as failed (never anchored)', async () => {
    const { svc, store } = setup({ dropLog: true }, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY });
    const anchor = await svc.anchorRun(makeRun(store).id);
    expect(anchor.status).toBe('failed');
    expect(anchor.txHash).toBe('0x' + '11'.repeat(32));
    expect(anchor.error).toMatch(/no RunAnchored/);
  });

  it('marks a remark without a Remarked event as failed and records in-block when finality is not seen', async () => {
    const a = setup({ noRemarkEvent: true });
    expect((await a.svc.anchorRun(makeRun(a.store).id, { method: 'remark' })).status).toBe('failed');
    const b = setup({ finalized: false });
    expect((await b.svc.anchorRun(makeRun(b.store).id, { method: 'remark' })).status).toBe('in-block');
  });

  it('refuses non-terminal and rejected runs before touching the chain', async () => {
    const { svc, store, chain } = setup();
    for (const state of ['running', 'waiting', 'rejected'] as const) {
      await expectCode(svc.anchorRun(makeRun(store, { state }).id, { method: 'remark' }), 'V3_RUN_NOT_ANCHORABLE');
    }
    await expectCode(svc.anchorRun('run-missing', { method: 'remark' }), 'SCENARIO_RUN_NOT_FOUND');
    expect(chain.calls).toEqual([]);
  });

  it('refuses a second anchor of the same run hash on the same chain + method, but allows retry after failure', async () => {
    const { svc, store, chain } = setup();
    const run = makeRun(store);
    await svc.anchorRun(run.id, { method: 'remark' });
    await expectCode(svc.anchorRun(run.id, { method: 'remark' }), 'V3_ALREADY_ANCHORED');

    const f = setup({ failSubmit: new Error('pool full') });
    const fr = makeRun(f.store);
    await expectCode(f.svc.anchorRun(fr.id, { method: 'remark' }), 'INTERNAL');
    expect(f.store.listV3Anchors({ runId: fr.id })[0]?.status).toBe('failed');
    f.chain.opts.failSubmit = undefined;
    expect((await f.svc.anchorRun(fr.id, { method: 'remark' })).status).toBe('finalized');
    expect(chain.calls.length).toBe(1);
  });

  it('requires a signer, refuses unfunded signers, and never leaks the secret in errors or records', async () => {
    const none = setup({}, {});
    await expectCode(none.svc.anchorRun(makeRun(none.store).id, { method: 'remark' }), 'V3_SIGNER_NOT_CONFIGURED');

    const poor = setup({ balance: 0n });
    await expectCode(poor.svc.anchorRun(makeRun(poor.store).id, { method: 'remark' }), 'V3_INSUFFICIENT_FUNDS');
    await expectCode(poor.svc.deployRegistry(), 'V3_INSUFFICIENT_FUNDS');
    expect(poor.chain.calls).toEqual([]);

    const leaky = setup({ failSubmit: new Error(`signing with ${DEV_SURI} failed`) });
    const run = makeRun(leaky.store);
    const err = await expectCode(leaky.svc.anchorRun(run.id, { method: 'remark' }), 'INTERNAL');
    expect(err.message).not.toContain(DEV_SURI);
    const rec = leaky.store.listV3Anchors({ runId: run.id })[0];
    expect(rec?.status).toBe('failed');
    expect(JSON.stringify(rec)).not.toContain(DEV_SURI);
    expect(JSON.stringify(leaky.seen)).not.toContain(DEV_SURI);
  });

  it('carries tx/block refs from a dispatch failure into the failed record', async () => {
    const { KaizenError } = await import('@kaizen/engine');
    const { svc, store } = setup({
      failSubmit: new KaizenError('V3_TX_FAILED', 'dispatch failed', { txHash: '0x' + '99'.repeat(32), blockHash: '0x' + '88'.repeat(32) }),
    });
    const run = makeRun(store);
    await expectCode(svc.anchorRun(run.id, { method: 'remark' }), 'V3_TX_FAILED');
    expect(store.listV3Anchors({ runId: run.id })[0]).toMatchObject({
      status: 'failed',
      txHash: '0x' + '99'.repeat(32),
      blockHash: '0x' + '88'.repeat(32),
    });
  });

  it('reports status without throwing when the chain is unreachable', async () => {
    const { svc } = setup({ connectError: new Error('ECONNREFUSED') });
    const status = await svc.status();
    expect(status.signer).toMatchObject({ configured: true, address: ALICE, freeBalance: null });
    expect(status.error).toMatch(/ECONNREFUSED/);
    expect(status.explorerBlockUrlTemplate).toContain('#/explorer/query/{block}');
    const ok = setup({ balance: 5n });
    const s2 = await ok.svc.status();
    expect(s2).toMatchObject({ chainName: 'PortaldotV3 Test', genesisHash: GENESIS, error: null });
    expect(s2.signer).toMatchObject({ freeBalance: '5', tokenSymbol: 'tPOT', tokenDecimals: 14 });
  });

  it('verifies contract anchors end to end and flags tampering', async () => {
    const { svc, store } = setup({}, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY });
    const run = makeRun(store);
    const anchor = await svc.anchorRun(run.id);
    const v = await svc.verify(anchor.id);
    expect(v).toMatchObject({
      verdict: 'verified',
      hashMatches: true,
      blockHashMatches: true,
      contractCodePresent: true,
      chainIdMatches: true,
      contractAddressMatches: true,
      txHashMatches: true,
      txSucceeded: true,
      onChainRecordMatches: true,
    });
    expect(v.onChainAnchoredAt).toBe(1_761_000_000);
    expect(v.evmChainId).toBe(420420777);

    const notOnChain = setup({ anchoredAt: 0n }, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY });
    const a2 = await notOnChain.svc.anchorRun(makeRun(notOnChain.store).id);
    expect((await notOnChain.svc.verify(a2.id)).verdict).toBe('mismatch');

    await expectCode(svc.verify('anc-missing'), 'V3_ANCHOR_NOT_FOUND');
  });

  it('verifies remark anchors against the remark text in the block', async () => {
    const good = setup();
    const run = makeRun(good.store);
    const anchor = await good.svc.anchorRun(run.id, { method: 'remark' });
    good.chain.opts.remarkText = anchor.payload;
    expect((await good.svc.verify(anchor.id)).verdict).toBe('verified');
    good.chain.opts.remarkText = 'something else';
    expect((await good.svc.verify(anchor.id)).verdict).toBe('mismatch');
    good.chain.opts.remarkText = anchor.payload;
    good.chain.opts.blockHashAt = '0x' + '00'.repeat(31) + '01';
    expect((await good.svc.verify(anchor.id)).verdict).toBe('mismatch');
  });

  it('reports a failed transaction receipt, a missing transaction and a chain-id mismatch', async () => {
    const failed = setup({ txSuccess: false }, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY });
    const a1 = await failed.svc.anchorRun(makeRun(failed.store).id);
    const v1 = await failed.svc.verify(a1.id);
    expect(v1.txSucceeded).toBe(false);
    expect(v1.verdict).toBe('mismatch');
    expect(v1.notes.join('\n')).toMatch(/did not report system.ExtrinsicSuccess/);

    const missing = setup();
    const a2 = await missing.svc.anchorRun(makeRun(missing.store).id, { method: 'remark' });
    const store = missing.store as unknown as { db: { prepare(sql: string): { run(...args: unknown[]): unknown } } };
    store.db.prepare('UPDATE v3_anchors SET tx_hash = ? WHERE id = ?').run('0x' + '00'.repeat(32), a2.id);
    const v2 = await missing.svc.verify(a2.id);
    expect(v2.txHashMatches).toBe(false);
    expect(v2.verdict).toBe('mismatch');
    expect(v2.notes.join('\n')).toMatch(/was not found in the recorded block/);
  });

  it('reports an EVM chain-id mismatch even when the Substrate block matches', async () => {
    const s = setup(undefined, { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY });
    const anchor = await s.svc.anchorRun(makeRun(s.store).id);
    const other = new V3AnchorService({
      store: s.store,
      events: new EventBus(),
      connector: s.chain,
      env: { KAIZEN_V3_SIGNER_SURI: DEV_SURI, KAIZEN_V3_REGISTRY_ADDRESS: REGISTRY },
      evmRpc: {
        post: async () => ({ httpStatus: 200, json: { jsonrpc: '2.0', id: 1, result: '0x1' }, id: 1 }),
      },
    });
    const v = await other.verify(anchor.id);
    expect(v.evmChainId).toBe(1);
    expect(v.chainIdMatches).toBe(false);
    expect(v.verdict).toBe('mismatch');
    expect(v.notes.join('\n')).toMatch(/does not match the configured expected chain id/);
  });

  it('imports a past deployment only from chain evidence', async () => {
    const { svc, store } = setup();
    const rec = await svc.importDeployment('0x' + '22'.repeat(32), '0x' + '44'.repeat(32));
    expect(rec).toMatchObject({ address: REGISTRY, deployerAddress: ALICE, blockNumber: 4000, genesisHash: GENESIS });
    expect(store.listV3Contracts()).toHaveLength(1);
    await expectCode(svc.importDeployment('0x' + '22'.repeat(32), '0x' + '00'.repeat(32)), 'V3_TX_FAILED');
    await expectCode(svc.importDeployment('0x' + '22'.repeat(32), '0x' + '33'.repeat(32)), 'V3_TX_FAILED');
    await expectCode(svc.importDeployment('0x12', '0x34'), 'INVALID_INPUT');
  });

  it('exposes a stable offline hash of a run', () => {
    const { svc, store } = setup();
    const run = makeRun(store);
    expect(svc.hashRun(run.id)).toEqual({ runId: run.id, runHash: computeRunHash(run), state: 'completed', anchorable: true });
  });
});

describe('committed V3 testnet evidence (docs/evidence)', () => {
  it('recomputes the exact run hashes that were anchored on the V3 test network', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = path.resolve(__dirname, '../../../docs/evidence');
    const anchors = JSON.parse(fs.readFileSync(path.join(root, 'v3-anchors.json'), 'utf8')) as {
      anchors: { runId: string; runHash: string; status: string }[];
    };
    const landed = anchors.anchors.filter((a) => a.status === 'finalized' || a.status === 'in-block');
    expect(landed.length).toBeGreaterThanOrEqual(3);
    for (const a of landed) {
      const run = JSON.parse(fs.readFileSync(path.join(root, 'runs', `${a.runId}.json`), 'utf8')) as ScenarioRunRecord;
      expect(computeRunHash(run)).toBe(a.runHash);
    }
  });
});
