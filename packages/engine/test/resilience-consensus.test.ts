/**
 * Consensus-aware attribution (T-9.7B): BABE digest decoding, authority-set
 * attribution across epochs, the secondary-slot cross-check, GRANDPA setId
 * transitions, era context, and recorder wiring. Offline: scripted inputs
 * only, never described as a live-network test.
 */

import { describe, expect, it } from 'vitest';
import {
  BABE_AUTHORSHIP_VERSION,
  GRANDPA_FINALITY_VERSION,
  attributeBabeAuthorship,
  babeSecondaryAuthorIndex,
  buildConsensusEvidence,
  checkGrandpaTransitionHistory,
  classifyFinalityGap,
  classifyFinalityObservations,
  decodeBabePreDigest,
  stripCompactLengthPrefix,
  type BabeAuthority,
  type BabeAuthoritySet,
  type BabeAuthorship,
  type BabePreDigest,
  type ConsensusContext,
  type GrandpaFinalityObservation,
  type GrandpaSetTransition,
} from '@kaizen/engine';
import { ChainEvidenceRecorder, type ChainConsensusCapture } from '@kaizen/engine';

const hash = (n: number): string => `0x${(n * 16).toString(16).padStart(64, '0')}`;
const randomness = `0x${'11'.repeat(32)}`;

function preDigest(variant: number, authorityIndex: number, slot: number, signature = true): Uint8Array {
  const bytes = Buffer.alloc(13 + (signature ? 96 : 0));
  bytes[0] = variant;
  bytes.writeUInt32LE(authorityIndex, 1);
  bytes.writeBigUInt64LE(BigInt(slot), 5);
  return bytes;
}

function authority(index: number, validatorId: string | null, key = `0x${(index + 1).toString(16).padStart(64, '0')}`): BabeAuthority {
  return { index, key, validatorId, weight: '1' };
}

function set(overrides: Partial<BabeAuthoritySet> = {}): BabeAuthoritySet {
  return {
    authoritySetId: 'babe:0:test',
    epoch: 0,
    startSlot: 0,
    durationSlots: 600,
    randomness,
    authorities: [authority(0, 'alice'), authority(1, 'bob')],
    ...overrides,
  };
}

const digest = (overrides: Partial<BabePreDigest> = {}): BabePreDigest => ({
  kind: 'secondary-plain',
  slot: 10,
  authorityIndex: 0,
  ...overrides,
});

describe('decodeBabePreDigest', () => {
  it('decodes the SCALE variant, authority index and slot from a primary digest', () => {
    expect(decodeBabePreDigest(preDigest(1, 2, 42))).toEqual({ kind: 'primary', authorityIndex: 2, slot: 42 });
  });

  it('decodes secondary-plain and secondary-VRF digests (codec indices 2 and 3)', () => {
    expect(decodeBabePreDigest(preDigest(2, 0, 7, false))).toEqual({ kind: 'secondary-plain', authorityIndex: 0, slot: 7 });
    expect(decodeBabePreDigest(preDigest(3, 1, 9))).toEqual({ kind: 'secondary-vrf', authorityIndex: 1, slot: 9 });
  });

  it('rejects unknown variants, short data and a missing VRF signature', () => {
    expect(() => decodeBabePreDigest(preDigest(0, 0, 1))).toThrow(/unknown BABE pre-digest variant/);
    expect(() => decodeBabePreDigest(new Uint8Array(4))).toThrow(/at least 13/);
    expect(() => decodeBabePreDigest(preDigest(1, 0, 1, false))).toThrow(/missing its VRF signature/);
  });

  it('strips the SCALE Vec length that @polkadot/types includes in pre-runtime data', () => {
    // Real log seen on portaldot_dev (2026-11-04): 13-byte SecondaryPlain
    // payload behind compact length 0x34 (13 << 2).
    const log = '0x0642414245340201000000b8f0d11100000000';
    const data = Uint8Array.from(Buffer.from(log.slice(12), 'hex'));
    expect(data.length).toBe(14);
    const bare = stripCompactLengthPrefix(data);
    expect(bare.length).toBe(13);
    expect(decodeBabePreDigest(bare)).toEqual({
      kind: 'secondary-plain',
      authorityIndex: 1,
      slot: 0x11d1f0b8,
    });
  });

  it('leaves bare payloads and mismatched lengths untouched', () => {
    const bare = preDigest(2, 0, 7, false);
    expect(stripCompactLengthPrefix(bare)).toEqual(bare);
    // 0x08 declares 2 bytes, which is not the remaining 13 → not a prefix.
    const mismatched = Uint8Array.from([0x08, ...bare]);
    expect(stripCompactLengthPrefix(mismatched)).toEqual(mismatched);
    expect(() => decodeBabePreDigest(mismatched)).toThrow(/unknown BABE pre-digest variant 8/);
  });
});

describe('babeSecondaryAuthorIndex', () => {
  it('is deterministic, in range, and depends on both randomness and slot', () => {
    const a = babeSecondaryAuthorIndex(randomness, 10, 4);
    expect(a).toBe(babeSecondaryAuthorIndex(randomness, 10, 4));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(4);
    const values = new Set([0, 1, 2, 3, 4, 5].map((s) => babeSecondaryAuthorIndex(randomness, s, 4)));
    expect(values.size).toBeGreaterThan(1);
    expect(babeSecondaryAuthorIndex(`0x${'22'.repeat(32)}`, 10, 4)).not.toBe(a);
  });

  it('rejects malformed randomness and non-positive authority counts', () => {
    expect(() => babeSecondaryAuthorIndex('0x11', 1, 4)).toThrow(/32 bytes/);
    expect(() => babeSecondaryAuthorIndex(randomness, 1, 0)).toThrow(/positive/);
  });
});

describe('attributeBabeAuthorship', () => {
  it('attributes through the authority index in the block digest', () => {
    const a = attributeBabeAuthorship({
      block: { number: 3, hash: hash(3) },
      authoritySet: set(),
      digest: digest({ kind: 'primary', authorityIndex: 1, slot: 3 }),
    });
    expect(a).toMatchObject({ outcome: 'authored', validatorId: 'bob', authorityIndex: 1, epoch: 0, verification: 'digest' });
    expect(a.blockNumber).toBe(3);
    expect(a.blockHash).toBe(hash(3));
    expect(a.reasons).toEqual([]);
  });

  it('cross-checks secondary slots against the epoch randomness', () => {
    const index = babeSecondaryAuthorIndex(randomness, 10, 2);
    const a = attributeBabeAuthorship({
      block: { number: 10, hash: hash(10) },
      authoritySet: set(),
      digest: digest({ kind: 'secondary-plain', authorityIndex: index, slot: 10 }),
    });
    expect(a.outcome).toBe('authored');
    expect(a.verification).toBe('digest+secondary-rule');
  });

  it('refuses attribution when the secondary rule disagrees (wrong authority set)', () => {
    const index = babeSecondaryAuthorIndex(randomness, 10, 2);
    const wrong = index === 0 ? 1 : 0;
    const a = attributeBabeAuthorship({
      block: { number: 10, hash: hash(10) },
      authoritySet: set(),
      digest: digest({ kind: 'secondary-plain', authorityIndex: wrong, slot: 10 }),
    });
    expect(a.outcome).toBe('inconclusive');
    expect(a.validatorId).toBeNull();
    expect(a.reasons.join(' ')).toMatch(/secondary-slot rule .* observed authority set is not the block's epoch set/);
  });

  it('refuses attribution when the authority index is outside the observed set', () => {
    const a = attributeBabeAuthorship({
      block: { number: 3, hash: hash(3) },
      authoritySet: set(),
      digest: digest({ kind: 'primary', authorityIndex: 7, slot: 3 }),
    });
    expect(a.outcome).toBe('inconclusive');
    expect(a.reasons.join(' ')).toMatch(/outside the 2-authority set/);
  });

  it('refuses attribution when the slot is outside the epoch bounds', () => {
    const a = attributeBabeAuthorship({
      block: { number: 3, hash: hash(3) },
      authoritySet: set({ startSlot: 100, durationSlots: 600 }),
      digest: digest({ kind: 'primary', authorityIndex: 0, slot: 3 }),
    });
    expect(a.outcome).toBe('inconclusive');
    expect(a.reasons.join(' ')).toMatch(/outside epoch 0 bounds/);
  });

  it('marks an unmapped authority as authored-but-unattributed', () => {
    const a = attributeBabeAuthorship({
      block: { number: 3, hash: hash(3) },
      authoritySet: set({ authorities: [authority(0, null), authority(1, 'bob')] }),
      digest: digest({ kind: 'primary', authorityIndex: 0, slot: 3 }),
    });
    expect(a.outcome).toBe('authored');
    expect(a.validatorId).toBeNull();
    expect(a.reasons.join(' ')).toMatch(/not mapped to a validator account/);
  });

  it('does not attribute at all without an authority list', () => {
    const a = attributeBabeAuthorship({
      block: { number: 3, hash: hash(3) },
      authoritySet: set({ authorities: null }),
      digest: digest({ kind: 'primary', authorityIndex: 0, slot: 3 }),
    });
    expect(a.outcome).toBe('inconclusive');
    expect(a.reasons.join(' ')).toMatch(/not readable/);
  });
});

describe('classifyFinalityGap', () => {
  const transition = (from: number | null, to: number, finalizedBlock: number): GrandpaSetTransition => ({
    fromSetId: from,
    toSetId: to,
    epoch: 1,
    finalizedBlock,
    at: '2026-10-24T00:05:00.000Z',
  });

  it('treats a small lag as normal even during a transition', () => {
    const c = classifyFinalityGap({
      observation: { blockNumber: 104, finalizedNumber: 103, setId: 2, at: '2026-10-24T00:05:00.000Z' },
      transitions: [transition(1, 2, 103)],
      previousSetId: 1,
    });
    expect(c.classification).toBe('normal');
  });

  it('treats a lag while the set id changes as expected protocol behaviour', () => {
    const c = classifyFinalityGap({
      observation: { blockNumber: 120, finalizedNumber: 110, setId: 2, at: '2026-10-24T00:05:00.000Z' },
      transitions: [transition(1, 2, 118)],
      previousSetId: 1,
    });
    expect(c.classification).toBe('expected-transition');
    expect(c.reasons.join(' ')).toMatch(/not a validator failure/);
  });

  it('treats a transition inside the unfinalized window as expected', () => {
    const c = classifyFinalityGap({
      observation: { blockNumber: 120, finalizedNumber: 100, setId: 2, at: '2026-10-24T00:09:00.000Z' },
      transitions: [transition(1, 2, 105)],
    });
    expect(c.classification).toBe('expected-transition');
  });

  it('flags a large lag with no transition as stalled', () => {
    const c = classifyFinalityGap({
      observation: { blockNumber: 120, finalizedNumber: 100, setId: 1, at: '2026-10-24T00:30:00.000Z' },
      transitions: [],
    });
    expect(c.classification).toBe('stalled');
    expect(c.lagBlocks).toBe(20);
  });

  it('never blames a validator when the set id is unreadable', () => {
    const c = classifyFinalityGap({
      observation: { blockNumber: 120, finalizedNumber: 100, setId: null, at: '2026-10-24T00:30:00.000Z' },
      transitions: [],
    });
    expect(c.classification).toBe('unknown');
  });
});

describe('classifyFinalityObservations', () => {
  it('re-classifies in order with the run transition history and previous set id', () => {
    const obs: GrandpaFinalityObservation[] = [
      {
        blockNumber: 100,
        blockHash: hash(100),
        finalized: true,
        finalizedNumber: 99,
        finalizedHash: hash(99),
        setId: 1,
        epoch: 0,
        authorityCount: 2,
        lagBlocks: 1,
        classification: 'normal',
        reasons: [],
        at: '2026-10-24T00:00:00.000Z',
      },
      {
        blockNumber: 120,
        blockHash: hash(120),
        finalized: true,
        finalizedNumber: 105,
        finalizedHash: hash(105),
        setId: 2,
        epoch: 1,
        authorityCount: 2,
        lagBlocks: 15,
        classification: 'unknown',
        reasons: [],
        at: '2026-10-24T00:05:00.000Z',
      },
    ];
    const out = classifyFinalityObservations(obs, [
      { fromSetId: 1, toSetId: 2, epoch: 1, finalizedBlock: 106, at: '2026-10-24T00:05:00.000Z' },
    ]);
    expect(out[0]!.classification).toBe('normal');
    expect(out[1]!.classification).toBe('expected-transition');
  });
});

describe('checkGrandpaTransitionHistory', () => {
  it('reports duplicates, non-increasing ids, and missing previous ids', () => {
    const reasons = checkGrandpaTransitionHistory([
      { fromSetId: null, toSetId: 2, epoch: null, finalizedBlock: 1, at: '2026-10-24T00:00:00Z' },
      { fromSetId: 2, toSetId: 2, epoch: null, finalizedBlock: 2, at: '2026-10-24T00:01:00Z' },
      { fromSetId: 3, toSetId: 2, epoch: null, finalizedBlock: 3, at: '2026-10-24T00:02:00Z' },
    ]);
    expect(reasons.join('\n')).toMatch(/no established previous set id/);
    expect(reasons.join('\n')).toMatch(/did not increase/);
    expect(reasons.join('\n')).toMatch(/more than once/);
  });

  it('accepts a strictly increasing history', () => {
    expect(
      checkGrandpaTransitionHistory([
        { fromSetId: 1, toSetId: 2, epoch: 0, finalizedBlock: 10, at: '2026-10-24T00:00:00Z' },
        { fromSetId: 2, toSetId: 3, epoch: 1, finalizedBlock: 20, at: '2026-10-24T00:01:00Z' },
      ]),
    ).toEqual([]);
  });
});

describe('buildConsensusEvidence', () => {
  const context: ConsensusContext = {
    eraId: 3,
    sessionId: 1,
    babeEpoch: 0,
    babeAuthoritySetId: 'babe:0:test',
    grandpaSetId: 4,
    validatorCount: 2,
    eraPoints: { total: 20, byValidator: [{ validatorId: 'alice', points: 20 }] },
    transitionsObserved: [],
  };
  const authorship: BabeAuthorship = {
    blockNumber: 104,
    blockHash: hash(104),
    slot: 104,
    kind: 'primary',
    authorityIndex: 1,
    authoritySetId: 'babe:0:test',
    authorityKey: authority(1, 'bob').key,
    validatorId: 'bob',
    epoch: 0,
    sessionId: 1,
    outcome: 'authored',
    verification: 'digest',
    reasons: [],
  };
  const finality: GrandpaFinalityObservation = {
    blockNumber: 104,
    blockHash: hash(104),
    finalized: true,
    finalizedNumber: 103,
    finalizedHash: hash(103),
    setId: 4,
    epoch: 0,
    authorityCount: 2,
    lagBlocks: 1,
    classification: 'normal',
    reasons: [],
    at: '2026-10-24T00:04:00.000Z',
  };

  it('is complete when authorship, finality and context are all established', () => {
    const evidence = buildConsensusEvidence({
      authorings: [authorship],
      authoritySets: [set()],
      finality: [finality],
      transitions: [],
      context,
    });
    expect(evidence.consensusVersion).toBe(2);
    expect(evidence.babeAuthorshipVersion).toBe(BABE_AUTHORSHIP_VERSION);
    expect(evidence.finalityVersion).toBe(GRANDPA_FINALITY_VERSION);
    expect(evidence.incomplete).toBe(false);
    expect(evidence.incompleteReasons).toEqual([]);
  });

  it('lists explicit reasons for every missing or inconclusive part', () => {
    const incomplete = buildConsensusEvidence({
      authorings: [{ ...authorship, outcome: 'inconclusive', validatorId: null, reasons: ['slot outside epoch'] }],
      finality: [{ ...finality, setId: null, classification: 'unknown' }],
      transitions: [{ fromSetId: null, toSetId: 1, epoch: null, finalizedBlock: 1, at: '2026-10-24T00:00:00Z' }],
      context: { ...context, validatorCount: null, sessionId: null },
    });
    expect(incomplete.incomplete).toBe(true);
    const text = incomplete.incompleteReasons.join('\n');
    expect(text).toMatch(/BABE authorship inconclusive \(slot outside epoch\)/);
    expect(text).toMatch(/GRANDPA set id unavailable/);
    expect(text).toMatch(/validator count was not readable/);
    expect(text).toMatch(/no established previous set id/);
  });

  it('distinguishes "no source" from "source captured nothing" in the reasons', () => {
    const e = buildConsensusEvidence({ authorings: [], finality: [], transitions: [], context: null, captureFailed: true });
    const text = e.incompleteReasons.join('\n');
    expect(text).toMatch(/consensus read failed/);
    expect(text).toMatch(/no BABE authorship observation/);
    expect(text).toMatch(/context was not captured/);
  });
});

describe('ChainEvidenceRecorder consensus capture', () => {
  const ref = (n: number) => ({ number: n, hash: hash(n) });
  const baseAuthorship = (block: number, epoch: number): BabeAuthorship => ({
    blockNumber: block,
    blockHash: hash(block),
    slot: block,
    kind: 'primary',
    authorityIndex: 0,
    authoritySetId: `babe:${epoch}:test`,
    authorityKey: authority(0, 'alice').key,
    validatorId: 'alice',
    epoch,
    sessionId: epoch,
    outcome: 'authored',
    verification: 'digest',
    reasons: [],
  });
  const observation = (block: number, finalized: number, setId: number, epoch: number): GrandpaFinalityObservation => ({
    blockNumber: block,
    blockHash: hash(block),
    finalized: true,
    finalizedNumber: finalized,
    finalizedHash: hash(finalized),
    setId,
    epoch,
    authorityCount: 2,
    lagBlocks: block - finalized,
    classification: 'unknown',
    reasons: [],
    at: new Date(Date.UTC(2026, 9, 24, 0, block, 0)).toISOString(),
  });

  it('records authorship, authority sets, set transitions, epoch transitions and context', async () => {
    let call = 0;
    const capture: ChainConsensusCapture = {
      readAuthoring: async () => {
        call += 1;
        const block = call === 1 ? 100 : 130;
        const epoch = call === 1 ? 0 : 1;
        return {
          authorship: baseAuthorship(block, epoch),
          authoritySet: set({
            authoritySetId: `babe:${epoch}:test`,
            epoch,
            startSlot: epoch * 600,
            durationSlots: 600,
          }),
        };
      },
      readFinality: async () => {
        const block = call === 1 ? 100 : 130;
        return observation(block, block - (call === 1 ? 1 : 25), call, call === 1 ? 0 : 1);
      },
      readContext: async () => ({
        eraId: 3,
        sessionId: 1,
        babeEpoch: 1,
        babeAuthoritySetId: 'babe:1:test',
        grandpaSetId: 2,
        validatorCount: 2,
        eraPoints: null,
        transitionsObserved: [],
      }),
    };
    const rec = new ChainEvidenceRecorder({
      networkId: 'net_1',
      validatorId: 'bob',
      observerNodeId: 'alice',
      reader: { readHeads: async () => ({ best: ref(100), finalized: ref(99), genesisHash: hash(0) }) },
      consensus: capture,
    });
    await rec.observe('during-fault');
    call = 1;
    await rec.observe('after-recovery');
    const evidence = rec.finish();
    expect(evidence.consensus).not.toBeNull();
    expect(evidence.consensus?.authorings).toHaveLength(2);
    expect(evidence.consensus?.authoritySets).toHaveLength(2);
    expect(evidence.consensus?.grandpaTransitions).toEqual([
      expect.objectContaining({ fromSetId: 1, toSetId: 2, finalizedBlock: 105 }),
    ]);
    expect(evidence.consensus?.babeEpochTransitions).toHaveLength(1);
    expect(evidence.consensus?.babeEpochTransitions[0]).toMatchObject({ fromEpoch: 0, toEpoch: 1 });
    expect(evidence.consensus?.finality[1]?.classification).toBe('expected-transition');
    expect(evidence.consensus?.context?.eraId).toBe(3);
  });

  it('marks consensus evidence incomplete when a read fails, never fabricating a set', async () => {
    const failing: ChainConsensusCapture = {
      readAuthoring: async () => {
        throw new Error('babe.authorities unavailable');
      },
      readFinality: async () => null,
    };
    const rec = new ChainEvidenceRecorder({
      networkId: 'net_1',
      validatorId: 'bob',
      observerNodeId: 'alice',
      reader: { readHeads: async () => ({ best: ref(104), finalized: ref(102), genesisHash: null }) },
      consensus: failing,
    });
    await rec.observe('during-fault');
    const consensus = rec.finish().consensus;
    expect(consensus?.incomplete).toBe(true);
    expect(consensus?.incompleteReasons.join('\n')).toMatch(/consensus read failed/);
    expect(consensus?.authorings).toEqual([]);
  });

  it('leaves consensus unset when no capture was wired', async () => {
    const rec = new ChainEvidenceRecorder({
      networkId: 'net_1',
      validatorId: 'bob',
      observerNodeId: 'alice',
      reader: { readHeads: async () => ({ best: ref(104), finalized: ref(102), genesisHash: null }) },
    });
    await rec.observe('during-fault');
    expect(rec.finish().consensus).toBeNull();
  });
});
