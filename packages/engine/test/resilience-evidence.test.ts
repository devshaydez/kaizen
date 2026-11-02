/**
 * Chain-bound evidence + recovery metrics (T-9.1). Offline: heads come from
 * a scripted reader / fake fetch; no node is started.
 */

import { describe, expect, it } from 'vitest';
import { xxhashAsU8a } from '@polkadot/util-crypto';
import {
  ChainEvidenceRecorder,
  ChainUnreachableError,
  computeRecoveryMetrics,
  createHttpChainReader,
  type BlockRef,
  type ChainObservation,
  type HeadReader,
} from '@kaizen/engine';

const h = (n: number, fork = 0): string => `0x${(n * 16 + fork).toString(16).padStart(64, '0')}`;
const ref = (n: number): BlockRef => ({ number: n, hash: h(n) });
const storageKey = (pallet: string, item: string): string =>
  `0x${Buffer.from(xxhashAsU8a(Buffer.from(pallet), 128)).toString('hex')}${Buffer.from(xxhashAsU8a(Buffer.from(item), 128)).toString('hex')}`;
const at = (s: number): string => new Date(Date.UTC(2026, 9, 24, 0, 0, s)).toISOString();
const obs = (phase: ChainObservation['phase'], s: number, best: number, fin: number): ChainObservation => ({
  phase,
  at: at(s),
  best: ref(best),
  finalized: ref(fin),
});

describe('computeRecoveryMetrics', () => {
  it('derives time-to-recover, finality gap, and blocks missed from observations', () => {
    const m = computeRecoveryMetrics({
      observations: [
        obs('before-fault', 0, 100, 98),
        obs('during-fault', 60, 104, 98), // 10 slots, 4 produced → 6 missed
        obs('after-recovery', 66, 105, 98), // finality not advanced yet
        obs('after-recovery', 72, 106, 103), // recovered
      ],
      faultStartedAt: at(1),
      faultEndedAt: at(60),
    });
    expect(m).toEqual({
      recovered: true,
      recoveredAt: at(72),
      timeToRecoverMs: 12_000,
      finalityGapBlocks: 7,
      blocksMissed: 6,
      expectedBlockTimeMs: 6_000,
    });
  });

  it('is order-independent and never reports recovery without finality advancing', () => {
    const m = computeRecoveryMetrics({
      observations: [obs('after-recovery', 90, 120, 98), obs('before-fault', 0, 100, 98), obs('during-fault', 30, 101, 98)],
      faultStartedAt: at(1),
      faultEndedAt: at(30),
    });
    expect(m.recovered).toBe(false);
    expect(m.timeToRecoverMs).toBeNull();
    expect(m.recoveredAt).toBeNull();
    expect(m.finalityGapBlocks).toBe(22);
  });

  it('does not report a cross-set best/finalized height gap as validator lag', () => {
    const m = computeRecoveryMetrics({
      observations: [{
        ...obs('during-fault', 30, 120, 98),
        bestGrandpaSetId: '9',
        bestGrandpaAuthoritiesHash: 'new-set',
        finalizedGrandpaSetId: '8',
        finalizedGrandpaAuthoritiesHash: 'old-set',
      }],
      faultStartedAt: at(1),
      faultEndedAt: at(30),
    });
    expect(m.finalityGapBlocks).toBeNull();
  });

  it('measures finality lag when both heads share the same GRANDPA context', () => {
    const m = computeRecoveryMetrics({
      observations: [{
        ...obs('during-fault', 30, 120, 98),
        bestGrandpaSetId: '9',
        bestGrandpaAuthoritiesHash: 'set-nine',
        finalizedGrandpaSetId: '9',
        finalizedGrandpaAuthoritiesHash: 'set-nine',
      }],
      faultStartedAt: at(1),
      faultEndedAt: at(30),
    });
    expect(m.finalityGapBlocks).toBe(22);
  });

  it('excludes best/finalized gaps spanning a GRANDPA set or authority change', () => {
    const transition = computeRecoveryMetrics({
      observations: [{
        ...obs('during-fault', 30, 120, 98),
        bestGrandpaSetId: '9',
        bestGrandpaAuthoritiesHash: 'same-set-id-new-authorities',
        finalizedGrandpaSetId: '9',
        finalizedGrandpaAuthoritiesHash: 'old-authorities',
      }],
      faultStartedAt: at(1),
      faultEndedAt: at(30),
    });
    expect(transition.finalityGapBlocks).toBeNull();
  });

  it('returns null metrics when the observations needed are missing', () => {
    const m = computeRecoveryMetrics({ observations: [], faultStartedAt: null, faultEndedAt: null });
    expect(m).toMatchObject({ recovered: false, timeToRecoverMs: null, finalityGapBlocks: null, blocksMissed: null });
  });

  it('clamps blocksMissed at zero and honours a custom block time', () => {
    const m = computeRecoveryMetrics({
      observations: [obs('before-fault', 0, 100, 99), obs('during-fault', 12, 110, 99)],
      faultStartedAt: at(0),
      faultEndedAt: at(12),
      expectedBlockTimeMs: 3_000,
    });
    expect(m.blocksMissed).toBe(0);
    expect(m.expectedBlockTimeMs).toBe(3_000);
  });

  it('falls back to the fault start when no end was recorded', () => {
    const m = computeRecoveryMetrics({
      observations: [obs('before-fault', 0, 10, 8), obs('after-recovery', 20, 13, 11)],
      faultStartedAt: at(5),
      faultEndedAt: null,
    });
    expect(m.timeToRecoverMs).toBe(15_000);
  });

  it('rejects a non-positive block time and malformed timestamps', () => {
    expect(() => computeRecoveryMetrics({ observations: [], faultStartedAt: null, faultEndedAt: null, expectedBlockTimeMs: 0 })).toThrow();
    expect(() =>
      computeRecoveryMetrics({ observations: [], faultStartedAt: 'not-a-date', faultEndedAt: null }),
    ).not.toThrow(); // unused when nothing recovered
    expect(() =>
      computeRecoveryMetrics({
        observations: [obs('before-fault', 0, 1, 1), obs('after-recovery', 5, 3, 2)],
        faultStartedAt: 'not-a-date',
        faultEndedAt: null,
      }),
    ).toThrow(/invalid timestamp/);
  });
});

describe('ChainEvidenceRecorder', () => {
  function scripted(heads: Array<[number, number] | Error>): HeadReader & { calls: number } {
    const r = {
      calls: 0,
      async readHeads() {
        const next = heads[Math.min(r.calls, heads.length - 1)];
        r.calls += 1;
        if (next instanceof Error) throw next;
        return { best: ref(next[0]), finalized: ref(next[1]), genesisHash: h(0) };
      },
    };
    return r;
  }

  function clock(startS = 0) {
    let t = Date.UTC(2026, 9, 24, 0, 0, startS);
    return {
      now: () => new Date(t),
      sleep: async (msTime: number) => {
        t += msTime;
      },
      advance: (msTime: number) => {
        t += msTime;
      },
    };
  }

  it('records phases, polls until finality advances, and computes metrics', async () => {
    const c = clock();
    const reader = scripted([
      [100, 98],
      [101, 98],
      [101, 98],
      [104, 102],
    ]);
    const rec = new ChainEvidenceRecorder({
      networkId: 'net-1',
      validatorId: 'node-b',
      observerNodeId: 'node-a',
      reader,
      now: c.now,
      sleep: c.sleep,
    });
    await rec.observe('before-fault');
    rec.markFaultStarted();
    c.advance(30_000);
    await rec.observe('during-fault');
    rec.markFaultEnded();
    expect(await rec.awaitRecovery({ timeoutMs: 20_000, intervalMs: 2_000 })).toBe(true);
    const ev = rec.finish();
    expect(ev.observations.map((o) => o.phase)).toEqual(['before-fault', 'during-fault', 'after-recovery', 'after-recovery']);
    expect(ev.genesisHash).toBe(h(0));
    expect(ev.metrics).toMatchObject({ recovered: true, timeToRecoverMs: 2_000, blocksMissed: 4, finalityGapBlocks: 3 });
    expect(ev.recoveredAt).not.toBeNull();
    expect(ev.gaps).toEqual([]);
  });

  it('records unreachable reads as gaps and gives up at the timeout without claiming recovery', async () => {
    const c = clock();
    const rec = new ChainEvidenceRecorder({
      networkId: 'n',
      validatorId: 'v',
      observerNodeId: 'o',
      reader: scripted([[10, 8], new Error('ECONNREFUSED')]),
      now: c.now,
      sleep: c.sleep,
    });
    await rec.observe('before-fault');
    rec.markFaultStarted();
    await rec.observe('during-fault');
    rec.markFaultEnded();
    expect(await rec.awaitRecovery({ timeoutMs: 5_000, intervalMs: 2_000 })).toBe(false);
    const ev = rec.finish();
    expect(ev.metrics.recovered).toBe(false);
    expect(ev.observations).toHaveLength(1);
    expect(ev.gaps.length).toBeGreaterThanOrEqual(2);
    expect(ev.gaps[0]).toMatchObject({ phase: 'during-fault', reason: 'ECONNREFUSED' });
  });

  it('refuses malformed headers and a changing genesis hash', async () => {
    let n = 0;
    const rec = new ChainEvidenceRecorder({
      networkId: 'n',
      validatorId: 'v',
      observerNodeId: 'o',
      reader: {
        async readHeads() {
          n += 1;
          if (n === 1) return { best: ref(1), finalized: ref(1), genesisHash: h(0) };
          if (n === 2) return { best: ref(2), finalized: ref(1), genesisHash: h(0, 1) };
          return { best: { number: 3, hash: 'nope' }, finalized: ref(1), genesisHash: null };
        },
      },
    });
    await rec.observe('before-fault');
    await rec.observe('during-fault');
    await rec.observe('during-fault');
    const ev = rec.finish();
    expect(ev.observations).toHaveLength(1);
    expect(ev.gaps.map((g) => g.reason)).toEqual(['genesis hash changed between observations', 'node returned a malformed header']);
  });
});

describe('createHttpChainReader', () => {
  function fakeFetch(chain: Record<number, string>, best: number, finalized: number) {
    return async (_url: string, init: RequestInit): Promise<Response> => {
      const { method, params } = JSON.parse(String(init.body)) as { method: string; params: unknown[] };
      let result: unknown = null;
      if (method === 'chain_getBlockHash') result = chain[params[0] as number] ?? null;
      if (method === 'chain_getFinalizedHead') result = chain[finalized];
      if (method === 'state_getStorage') {
        const key = params[0] as string;
        if (key === storageKey('Grandpa', 'CurrentSetId')) result = `0x${'01'}${'00'.repeat(7)}`;
        if (key === storageKey('Grandpa', 'Authorities')) result = `0x04${'44'.repeat(32)}${'0100000000000000'}`;
      }
      if (method === 'chain_getHeader') {
        const hash = params[0] as string | undefined;
        const num = hash ? Number(Object.entries(chain).find(([, v]) => v === hash)?.[0]) : best;
        result = { number: `0x${num.toString(16)}` };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    };
  }

  it('reads best/finalized heads and block hashes by number', async () => {
    const chain = { 0: h(0), 7: h(7), 9: h(9) };
    const r = createHttpChainReader('http://127.0.0.1:1', { fetch: fakeFetch(chain, 9, 7) });
    await expect(r.readHeads()).resolves.toMatchObject({ best: { ...ref(9), grandpaSetId: "1", grandpaAuthoritiesHash: expect.any(String) }, finalized: { ...ref(7), grandpaSetId: "1", grandpaAuthoritiesHash: expect.any(String) }, genesisHash: h(0) });
    await expect(r.blockHashAt(7)).resolves.toBe(h(7));
    await expect(r.blockHashAt(8)).resolves.toBeNull();
  });

  it('maps transport failures to ChainUnreachableError and RPC errors to plain errors', async () => {
    const down = createHttpChainReader('http://127.0.0.1:1', {
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await expect(down.blockHashAt(1)).rejects.toBeInstanceOf(ChainUnreachableError);
    const rpcErr = createHttpChainReader('http://127.0.0.1:1', {
      fetch: async () => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 200 }),
    });
    await expect(rpcErr.blockHashAt(1)).rejects.toThrow('chain_getBlockHash: boom');
    await expect(rpcErr.blockHashAt(1)).rejects.not.toBeInstanceOf(ChainUnreachableError);
  });
});
