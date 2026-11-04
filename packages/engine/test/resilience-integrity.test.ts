/**
 * Evidence integrity and drill outcome (T-9.7C): recomputed metrics,
 * timestamp consistency, phase coverage, tamper detection, and the
 * passed / failed / inconclusive distinction. Offline only.
 */

import { describe, expect, it } from 'vitest';
import {
  assessDrill,
  buildConsensusEvidence,
  checkEvidenceIntegrity,
  scoringFinalityGap,
  type BabeAuthorship,
  type ChainConsensusEvidence,
  type ConsensusContext,
  type GrandpaFinalityObservation,
} from '@kaizen/engine';
import { fixtureEvidence, hashOf } from './resilience-fixtures';

const context: ConsensusContext = {
  eraId: 1,
  sessionId: 1,
  babeEpoch: 0,
  babeAuthoritySetId: 'babe:0:x',
  grandpaSetId: 1,
  validatorCount: 2,
  eraPoints: null,
  transitionsObserved: [],
};

const authorship: BabeAuthorship = {
  blockNumber: 104,
  blockHash: hashOf(104),
  slot: 104,
  kind: 'primary',
  authorityIndex: 0,
  authoritySetId: 'babe:0:x',
  authorityKey: `0x${'aa'.repeat(32)}`,
  validatorId: 'bob',
  epoch: 0,
  sessionId: 1,
  outcome: 'authored',
  verification: 'digest',
  reasons: [],
};

function finality(block: number, finalized: number, classification: GrandpaFinalityObservation['classification']): GrandpaFinalityObservation {
  return {
    blockNumber: block,
    blockHash: hashOf(block),
    finalized: true,
    finalizedNumber: finalized,
    finalizedHash: hashOf(finalized),
    setId: 1,
    epoch: 0,
    authorityCount: 2,
    lagBlocks: block - finalized,
    classification,
    reasons: [],
    at: '2026-10-24T00:01:00.000Z',
  };
}

function completeConsensus(overrides: Partial<GrandpaFinalityObservation>[] = []): ChainConsensusEvidence {
  const finalityObs = [finality(104, 103, 'normal'), ...overrides.map((o) => ({ ...finality(106, 103, 'normal'), ...o }))];
  return buildConsensusEvidence({
    authorings: [authorship],
    finality: finalityObs,
    transitions: [],
    context,
  });
}

describe('checkEvidenceIntegrity', () => {
  it('recomputes metrics and reports a complete, coherent document', () => {
    const integrity = checkEvidenceIntegrity(fixtureEvidence());
    expect(integrity.complete).toBe(true);
    expect(integrity.metricsMatch).toBe(true);
    expect(integrity.timestampsConsistent).toBe(true);
    expect(integrity.observationsValid).toBe(true);
    expect(integrity.reasons).toEqual([]);
    expect(integrity.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(integrity.consensus).toMatchObject({ present: false, complete: false });
  });

  it('detects tampered metrics (the fingerprint is not the only binding)', () => {
    const tampered = fixtureEvidence({ metrics: { ...fixtureEvidence().metrics, timeToRecoverMs: 1 } });
    const integrity = checkEvidenceIntegrity(tampered);
    expect(integrity.metricsMatch).toBe(false);
    expect(integrity.reasons.join('\n')).toMatch(/metrics-recomputation/);
  });

  it('detects a missing phase and inconsistent timestamps', () => {
    const missing = fixtureEvidence({
      observations: fixtureEvidence().observations.filter((o) => o.phase !== 'during-fault'),
    });
    expect(checkEvidenceIntegrity(missing).complete).toBe(false);
    expect(checkEvidenceIntegrity(missing).reasons.join('\n')).toMatch(/phase-coverage/);

    const ev = fixtureEvidence();
    ev.observations[0] = { ...ev.observations[0]!, at: '2026-10-24T00:00:30.000Z' };
    const integrity = checkEvidenceIntegrity(ev);
    expect(integrity.timestampsConsistent).toBe(false);
    expect(integrity.reasons.join('\n')).toMatch(/after the fault started/);
  });

  it('rejects finalized > best and malformed hashes', () => {
    const ev = fixtureEvidence();
    ev.observations[1] = { ...ev.observations[1]!, finalized: { number: 200, hash: hashOf(200) } };
    expect(checkEvidenceIntegrity(ev).observationsValid).toBe(false);
  });

  it('reports consensus completeness separately from chain-bound completeness', () => {
    const integrity = checkEvidenceIntegrity(fixtureEvidence({ consensus: completeConsensus() }));
    expect(integrity.consensus).toMatchObject({ present: true, complete: true });
    expect(integrity.complete).toBe(true);
  });

  it('produces a stable evidence hash that changes on any evidence change', () => {
    const a = checkEvidenceIntegrity(fixtureEvidence()).evidenceHash;
    expect(checkEvidenceIntegrity(fixtureEvidence()).evidenceHash).toBe(a);
    const ev = fixtureEvidence();
    ev.observations[2] = { ...ev.observations[2]!, best: { number: 107, hash: hashOf(107) } };
    expect(checkEvidenceIntegrity(ev).evidenceHash).not.toBe(a);
  });
});

describe('assessDrill', () => {
  it('classifies a recovered, complete drill as passed', () => {
    const a = assessDrill(fixtureEvidence(), 'completed');
    expect(a.outcome).toBe('passed');
    expect(a.reasons.join(' ')).toMatch(/advanced past the pre-fault maximum/);
  });

  it('classifies an observed no-recovery drill as failed, not inconclusive', () => {
    const ev = fixtureEvidence({
      observations: [
        { phase: 'before-fault', at: '2026-10-24T00:00:00.000Z', best: { number: 100, hash: hashOf(100) }, finalized: { number: 98, hash: hashOf(98) } },
        { phase: 'during-fault', at: '2026-10-24T00:01:00.000Z', best: { number: 104, hash: hashOf(104) }, finalized: { number: 98, hash: hashOf(98) } },
        { phase: 'after-recovery', at: '2026-10-24T00:01:12.000Z', best: { number: 106, hash: hashOf(106) }, finalized: { number: 98, hash: hashOf(98) } },
      ],
      recoveredAt: null,
      metrics: { recovered: false, timeToRecoverMs: null, finalityGapBlocks: 8, blocksMissed: 6, expectedBlockTimeMs: 6_000 },
    });
    const a = assessDrill(ev, 'completed');
    expect(a.outcome).toBe('failed');
    expect(a.reasons.join(' ')).toMatch(/finality did not advance/);
  });

  it('classifies a terminal failed run as failed even if finality recovered', () => {
    expect(assessDrill(fixtureEvidence(), 'failed').outcome).toBe('failed');
  });

  it('classifies tampered or incomplete evidence as inconclusive', () => {
    const tampered = fixtureEvidence({ metrics: { ...fixtureEvidence().metrics, recovered: false } });
    expect(assessDrill(tampered, 'completed').outcome).toBe('inconclusive');
    const incomplete = fixtureEvidence({ observations: fixtureEvidence().observations.filter((o) => o.phase !== 'after-recovery') });
    expect(assessDrill(incomplete, 'completed').outcome).toBe('inconclusive');
  });
});

describe('scoringFinalityGap', () => {
  it('excludes expected GRANDPA set transitions from the scoring signal', () => {
    const consensus = completeConsensus([
      { blockNumber: 106, finalizedNumber: 103, lagBlocks: 40, classification: 'expected-transition' },
    ]);
    const ev = fixtureEvidence({ consensus });
    // Stored max gap is 6 from the raw observations; consensus says the large
    // lag at the second observation is transition-time, so the max of the
    // remaining (normal) observations is 1.
    expect(scoringFinalityGap(ev)).toBe(1);
  });

  it('returns 0 when every measured gap is transition-time', () => {
    const consensus = buildConsensusEvidence({
      authorings: [authorship],
      finality: [finality(104, 60, 'expected-transition')],
      transitions: [],
      context,
    });
    expect(scoringFinalityGap(fixtureEvidence({ consensus }))).toBe(0);
  });

  it('falls back to the stored metric when no consensus finality data exists', () => {
    expect(scoringFinalityGap(fixtureEvidence())).toBe(6);
  });
});
