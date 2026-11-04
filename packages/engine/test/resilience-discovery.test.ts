/**
 * Dynamic validator discovery (T-9.7B) over a scripted runtime facade.
 *
 * These tests prove the read/normalize/cache logic and failure handling of
 * the discovery layer. They do NOT connect to a Portaldot node; live reads
 * are exercised only by `test/integration/resilience.int.test.ts` behind
 * KAIZEN_TEST_LIVE=1.
 */

import { describe, expect, it } from 'vitest';
import {
  ValidatorDiscovery,
  type ConsensusRuntime,
  type ConsensusRuntimeView,
  type SessionKeySet,
} from '@kaizen/engine';

const hash = (n: number): string => `0x${(n * 16).toString(16).padStart(64, '0')}`;
const key = (byte: string): string => `0x${byte.repeat(32)}`;
const sess = (babe: string | null, grandpa: string | null = null): SessionKeySet => ({
  babe,
  grandpa,
  raw: { ...(babe ? { babe } : {}), ...(grandpa ? { grandpa } : {}) },
});

function view(overrides: Partial<ConsensusRuntimeView> = {}): ConsensusRuntimeView {
  const base: ConsensusRuntimeView = {
    blockNumber: async () => 100,
    babePreDigest: async () => ({ kind: 'primary', slot: 100, authorityIndex: 1 }),
    babeEpoch: async () => ({ epoch: 0, startSlot: 0, durationSlots: 600, randomness: key('11') }),
    babeAuthorities: async () => [
      { key: key('aa'), weight: '1' },
      { key: key('bb'), weight: '1' },
    ],
    grandpaAuthorities: async () => [
      { key: key('cc'), weight: '1' },
      { key: key('dd'), weight: '1' },
    ],
    grandpaSetId: async () => 1,
    sessionIndex: async () => 3,
    sessionValidators: async () => ['alice', 'bob'],
    sessionQueuedKeys: async () => [
      { accountId: 'alice', keys: sess(key('aa'), key('cc')) },
      { accountId: 'bob', keys: sess(key('bb'), key('dd')) },
    ],
    sessionNextKeys: async () => [
      { accountId: 'alice', keys: sess(key('ee')) },
      { accountId: 'carol', keys: sess(key('ff')) },
    ],
    activeEra: async () => 5,
    eraRewardPoints: async () => ({ total: 30, byValidator: [{ validatorId: 'alice', points: 30 }] }),
    ...overrides,
  };
  return base;
}

function runtime(views: Record<string, Partial<ConsensusRuntimeView>>, best = { number: 100, hash: hash(100) }) {
  const calls = { best: 0, at: [] as string[] };
  const rt: ConsensusRuntime = {
    async bestBlock() {
      calls.best += 1;
      return best;
    },
    async at(blockHash: string) {
      calls.at.push(blockHash);
      return view({ blockNumber: async () => Number.parseInt(blockHash.slice(2), 16) / 16, ...(views[blockHash] ?? {}) });
    },
    async close() {},
  };
  return { rt, calls };
}

describe('ValidatorDiscovery.snapshot', () => {
  it('discovers validators, current session keys and next-session keys without a hardcoded list', async () => {
    const { rt } = runtime({});
    const d = new ValidatorDiscovery({ runtime: rt });
    const s = await d.snapshot(hash(100));
    expect(s.at).toEqual({ number: 100, hash: hash(100) });
    expect(s.sessionIndex).toBe(3);
    expect(s.babeEpoch).toMatchObject({ epoch: 0, startSlot: 0, durationSlots: 600 });
    expect(s.babeAuthorities).toHaveLength(2);
    expect(s.grandpaAuthorities).toHaveLength(2);
    expect(s.grandpaSetId).toBe(1);
    expect(s.validators.map((v) => v.accountId)).toEqual(['alice', 'bob']);
    expect(s.validators[0]).toMatchObject({ source: 'queued-keys' });
    expect(s.validators[0]!.nextSessionKeys?.babe).toBe(key('ee'));
    expect(s.nextValidators.map((v) => v.accountId)).toEqual(['alice', 'carol']);
    expect(s.era).toMatchObject({ index: 5, points: { total: 30 } });
    expect(s.unavailable).toEqual([]);
  });

  it('maps BABE authority keys to validator accounts (current then next session)', async () => {
    const { rt } = runtime({});
    const d = new ValidatorDiscovery({ runtime: rt });
    const s = await d.snapshot(hash(100));
    const map = d.keyMap(s);
    expect(map.get(key('aa'))).toBe('alice');
    expect(map.get(key('bb'))).toBe('bob');
    expect(map.get(key('ee'))).toBe('alice');
    expect(map.get(key('ff'))).toBe('carol');
  });

  it('caches one snapshot per block: repeated reads while the best block is unchanged do not re-query state', async () => {
    const { rt, calls } = runtime({});
    const d = new ValidatorDiscovery({ runtime: rt });
    await d.snapshot();
    await d.snapshot();
    await d.snapshot();
    expect(calls.best).toBe(3);
    expect(calls.at).toEqual([hash(100)]);
  });

  it('reads historical state at the requested hash, never the current state', async () => {
    const { rt, calls } = runtime({
      [hash(50)]: {
        blockNumber: async () => 50,
        babeEpoch: async () => ({ epoch: 0, startSlot: 0, durationSlots: 600, randomness: key('11') }),
        babeAuthorities: async () => [{ key: key('aa'), weight: '1' }],
        sessionValidators: async () => ['alice-old'],
        sessionQueuedKeys: async () => [{ accountId: 'alice-old', keys: sess(key('aa')) }],
      },
    });
    const d = new ValidatorDiscovery({ runtime: rt });
    const s = await d.snapshot(hash(50));
    expect(calls.at).toEqual([hash(50)]);
    expect(s.validators.map((v) => v.accountId)).toEqual(['alice-old']);
  });

  it('degrades failed queries to null and records them, without throwing', async () => {
    const { rt } = runtime({
      [hash(100)]: {
        babeAuthorities: async () => {
          throw new Error('babe.authorities unavailable');
        },
        sessionNextKeys: async () => {
          throw new Error('nextKeys unavailable');
        },
        eraRewardPoints: async () => {
          throw new Error('erasRewardPoints unavailable');
        },
      },
    });
    const d = new ValidatorDiscovery({ runtime: rt });
    const s = await d.snapshot(hash(100));
    expect(s.babeAuthorities).toBeNull();
    expect(s.validators.map((v) => v.accountId)).toEqual(['alice', 'bob']);
    expect(s.era?.points).toBeNull();
    expect(s.unavailable).toEqual(
      expect.arrayContaining(['babe.authorities', 'session.nextKeys', 'staking.erasRewardPoints']),
    );
  });

  it('keeps working when staking is absent (era is context, never identity)', async () => {
    const { rt } = runtime({
      [hash(100)]: {
        activeEra: async () => {
          throw new Error('staking pallet absent');
        },
        eraRewardPoints: async () => {
          throw new Error('staking pallet absent');
        },
      },
    });
    const d = new ValidatorDiscovery({ runtime: rt });
    const s = await d.snapshot(hash(100));
    expect(s.era).toBeNull();
    const a = await d.attribute({ number: 100, hash: hash(100) });
    expect(a?.authorship.outcome).toBe('authored');
    expect(a?.authorship.validatorId).toBe('bob');
  });
});

describe('ValidatorDiscovery.attribute', () => {
  it('attributes the block through the digest authority index and the keys at that block', async () => {
    const { rt } = runtime({});
    const d = new ValidatorDiscovery({ runtime: rt });
    const result = await d.attribute({ number: 100, hash: hash(100) });
    expect(result).not.toBeNull();
    expect(result!.authorship).toMatchObject({
      blockNumber: 100,
      blockHash: hash(100),
      authorityIndex: 1,
      validatorId: 'bob',
      outcome: 'authored',
      epoch: 0,
      sessionId: 3,
    });
    expect(result!.authoritySet.authoritySetId).toMatch(/^babe:0:/);
    expect(result!.authoritySet.authorities?.[1]?.validatorId).toBe('bob');
  });

  it('resolves unnamed session keys through session.keyOwner instead of a tuple index', async () => {
    const { rt } = runtime({
      [hash(100)]: {
        // portaldot_dev encodes SessionKeys as a tuple: no `babe` field.
        sessionQueuedKeys: async () => [
          { accountId: 'alice', keys: { babe: null, grandpa: null, raw: { field0: key('aa'), field1: key('aa') } } },
          { accountId: 'bob', keys: { babe: null, grandpa: null, raw: { field0: key('bb'), field1: key('bb') } } },
        ],
        keyOwner: async (k) => (k === key('aa') ? 'alice' : k === key('bb') ? 'bob' : null),
      },
    });
    const d = new ValidatorDiscovery({ runtime: rt });
    const result = await d.attribute({ number: 100, hash: hash(100) });
    expect(result!.authorship.outcome).toBe('authored');
    expect(result!.authorship.validatorId).toBe('bob');
    expect(result!.authoritySet.authorities?.[1]?.validatorId).toBe('bob');
  });

  it('returns null when the block has no BABE pre-digest, rather than guessing', async () => {
    const { rt } = runtime({ [hash(100)]: { babePreDigest: async () => null } });
    const d = new ValidatorDiscovery({ runtime: rt });
    expect(await d.attribute({ number: 100, hash: hash(100) })).toBeNull();
  });

  it('marks authorship inconclusive when the observed authority set is missing', async () => {
    const { rt } = runtime({ [hash(100)]: { babeAuthorities: async () => null } });
    const d = new ValidatorDiscovery({ runtime: rt });
    const result = await d.attribute({ number: 100, hash: hash(100) });
    expect(result?.authorship.outcome).toBe('inconclusive');
    expect(result?.authorship.reasons.join(' ')).toMatch(/not readable/);
  });

  it('does not substitute the current set for a historical block whose authorities cannot be read', async () => {
    const { rt, calls } = runtime({
      [hash(60)]: {
        babeAuthorities: async () => null,
        babeEpoch: async () => null,
        sessionQueuedKeys: async () => [{ accountId: 'current-alice', keys: sess(key('aa')) }],
      },
    });
    const d = new ValidatorDiscovery({ runtime: rt });
    const result = await d.attribute({ number: 60, hash: hash(60) });
    expect(calls.at.every((h) => h === hash(60))).toBe(true);
    expect(result?.authorship.outcome).toBe('inconclusive');
    expect(result?.authorship.validatorId).toBeNull();
  });
});

describe('ValidatorDiscovery.finality', () => {
  it('records a setId transition and classifies a lag across it as expected', async () => {
    const { rt } = runtime({
      [hash(100)]: { grandpaSetId: async () => 1, blockNumber: async () => 100 },
      [hash(120)]: { grandpaSetId: async () => 2, blockNumber: async () => 120 },
    });
    const d = new ValidatorDiscovery({ runtime: rt, now: () => new Date('2026-10-24T00:00:00Z') });
    const first = await d.finality({ number: 100, hash: hash(100), finalized: { number: 99, hash: hash(99) } });
    expect(first).toMatchObject({ setId: 1, lagBlocks: 1, classification: 'normal' });
    const second = await d.finality({ number: 120, hash: hash(120), finalized: { number: 105, hash: hash(105) } });
    expect(second?.setId).toBe(2);
    expect(second?.classification).toBe('expected-transition');
    expect(d.transitions()).toEqual([expect.objectContaining({ fromSetId: 1, toSetId: 2, finalizedBlock: 105 })]);
  });

  it('reports an unknown classification when the set id is unreadable', async () => {
    const { rt } = runtime({ [hash(100)]: { grandpaSetId: async () => null } });
    const d = new ValidatorDiscovery({ runtime: rt, now: () => new Date('2026-10-24T00:00:00Z') });
    const f = await d.finality({ number: 200, hash: hash(100), finalized: { number: 100, hash: hash(100) } });
    expect(f?.classification).toBe('unknown');
    expect(f?.setId).toBeNull();
  });
});

describe('ValidatorDiscovery.context', () => {
  it('reports era points as context only, alongside session/epoch/set ids', async () => {
    const { rt } = runtime({});
    const d = new ValidatorDiscovery({ runtime: rt });
    const ctx = await d.context();
    expect(ctx).toMatchObject({
      eraId: 5,
      sessionId: 3,
      babeEpoch: 0,
      grandpaSetId: 1,
      validatorCount: 2,
    });
    expect(ctx?.eraPoints).toEqual({ total: 30, byValidator: [{ validatorId: 'alice', points: 30 }] });
    expect(ctx?.babeAuthoritySetId).toMatch(/^babe:0:/);
  });
});
