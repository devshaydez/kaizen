/**
 * Certificate verification (T-9.1/T-9.2): block hashes re-fetched from a
 * scripted ChainReader; offline → unverifiable, never a fake success.
 */

import { describe, expect, it } from 'vitest';
import {
  ChainUnreachableError,
  buildConsensusEvidence,
  issueCertificate,
  loadResilienceSigner,
  verifyCertificate,
  verifyChainEvidence,
  type BabeAuthorship,
  type ChainConsensusEvidence,
  type ChainReader,
  type ConsensusContext,
  type GrandpaFinalityObservation,
} from '@kaizen/engine';
import { fixtureEvidence, fixtureRun, hashOf } from './resilience-fixtures';

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

function authorship(block: number): BabeAuthorship {
  return {
    blockNumber: block,
    blockHash: hashOf(block),
    slot: block,
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
}

function finality(block: number, finalized: number): GrandpaFinalityObservation {
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
    classification: 'normal',
    reasons: [],
    at: '2026-10-24T00:00:00.000Z',
  };
}

function consensus(completeData = true): ChainConsensusEvidence {
  return buildConsensusEvidence({
    authorings: completeData ? [authorship(104)] : [],
    finality: completeData ? [finality(104, 103)] : [],
    transitions: [],
    context: completeData ? context : null,
  });
}

function reader(chain: (n: number) => string | null | Error): ChainReader & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async blockHashAt(n: number) {
      calls.push(n);
      const r = chain(n);
      if (r instanceof Error) throw r;
      return r;
    },
    async genesisHash() {
      return hashOf(0);
    },
    async readHeads() {
      throw new Error('unused');
    },
  };
}

const honest = (n: number): string => hashOf(n);

describe('verifyChainEvidence', () => {
  it('verifies when every observed hash matches, fetching each block number once', async () => {
    const r = reader(honest);
    const res = await verifyChainEvidence(fixtureEvidence(), r);
    expect(res.status).toBe('verified');
    expect(res.checks).toHaveLength(7); // genesis + 3 phases × (best, finalized)
    expect(res.checks.every((c) => c.ok)).toBe(true);
    expect(new Set(r.calls).size).toBe(r.calls.length);
  });

  it('fails on any differing hash (forked/reset chain or altered evidence)', async () => {
    const res = await verifyChainEvidence(fixtureEvidence(), reader((n) => (n === 98 ? hashOf(98, 1) : hashOf(n))));
    expect(res.status).toBe('mismatch');
    expect(res.reason).toMatch(/#98 finalized/);
    expect(res.checks.filter((c) => !c.ok).map((c) => c.phase)).toEqual(['before-fault', 'during-fault']);
  });

  it('reports unverifiable (network offline) when the RPC is unreachable or absent', async () => {
    const off = await verifyChainEvidence(fixtureEvidence(), reader(() => new ChainUnreachableError('ECONNREFUSED')));
    expect(off).toMatchObject({ status: 'unverifiable' });
    expect(off.reason).toMatch(/^network offline/);
    const none = await verifyChainEvidence(fixtureEvidence(), null);
    expect(none.status).toBe('unverifiable');
    expect(none.reason).toMatch(/^network offline/);
  });

  it('reports unverifiable when blocks are missing, but mismatch wins over missing', async () => {
    const missing = await verifyChainEvidence(fixtureEvidence(), reader((n) => (n >= 104 ? null : hashOf(n))));
    expect(missing.status).toBe('unverifiable');
    expect(missing.reason).toMatch(/block not found/);
    const both = await verifyChainEvidence(
      fixtureEvidence(),
      reader((n) => (n >= 104 ? null : n === 0 ? hashOf(0, 2) : hashOf(n))),
    );
    expect(both.status).toBe('mismatch');
  });

  it('treats RPC-level errors and empty evidence as unverifiable', async () => {
    expect((await verifyChainEvidence(fixtureEvidence(), reader(() => new Error('method not found')))).reason).toMatch(/^RPC error/);
    expect((await verifyChainEvidence(fixtureEvidence({ observations: [], genesisHash: null }), reader(honest))).status).toBe(
      'unverifiable',
    );
  });
});

describe('verifyCertificate', () => {
  it('combines integrity and chain binding; labels dev keys', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });

    const ok = await verifyCertificate(cert, run, reader(honest));
    expect(ok.status).toBe('verified');
    expect(ok.devKey).toBe(true);
    expect(ok.evidence.outcome).toBe('passed');
    expect(ok.evidenceHashMatches).toBe(true);
    expect(ok.reasons.join('\n')).toMatch(/DEV KEY/);
    expect(ok.reasons.join('\n')).toMatch(/no consensus context/);

    const offline = await verifyCertificate(cert, run, null);
    expect(offline.status).toBe('unverifiable');

    const forged = { ...cert, signature: { ...cert.signature, signature: `0x${'11'.repeat(64)}` } };
    const bad = await verifyCertificate(forged, run, null);
    expect(bad.status).toBe('mismatch');
    expect(bad.reasons).toContain('sr25519 signature is invalid');

    const forkedChain = await verifyCertificate(cert, run, reader((n) => hashOf(n, 3)));
    expect(forkedChain.status).toBe('mismatch');
  });

  it('reports a valid signature with incomplete consensus context as inconclusive', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence({ consensus: consensus(false) }), signer });
    const res = await verifyCertificate(cert, run, reader(honest));
    expect(res.integrity.signatureValid).toBe(true);
    expect(res.chain.status).toBe('verified');
    expect(res.status).toBe('inconclusive');
    expect(res.reasons.join('\n')).toMatch(/consensus context incomplete/);
    expect(res.consensus?.incomplete).toBe(true);
  });

  it('stays verified with a complete consensus context', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence({ consensus: consensus(true) }), signer });
    const res = await verifyCertificate(cert, run, reader(honest));
    expect(res.status).toBe('verified');
    expect(res.consensus?.incomplete).toBe(false);
    expect(res.evidence.integrity.consensus.complete).toBe(true);
  });

  it('detects a tampered evidenceHash independently of the fingerprint', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });
    const tampered = { ...cert, evidenceHash: `0x${'00'.repeat(32)}` };
    const res = await verifyCertificate(tampered, run, reader(honest));
    expect(res.evidenceHashMatches).toBe(false);
    expect(res.status).toBe('mismatch');
    expect(res.reasons.join('\n')).toMatch(/evidenceHash/);
  });

  it('treats certificates issued before the evidenceHash field as legacy, not invalid', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });
    const legacy = { ...cert };
    delete legacy.evidenceHash;
    delete legacy.outcome;
    const res = await verifyCertificate(legacy, run, reader(honest));
    expect(res.evidenceHashMatches).toBeNull();
    expect(res.status).toBe('verified');
  });

  it('flags a certificate whose evidence metrics do not recompute as mismatch', async () => {
    const run = fixtureRun();
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const evidence = fixtureEvidence();
    evidence.metrics = { ...evidence.metrics, timeToRecoverMs: 1 };
    const cert = await issueCertificate({ run, chain: evidence, signer });
    const res = await verifyCertificate(cert, run, reader(honest));
    expect(res.evidence.integrity.metricsMatch).toBe(false);
    expect(res.status).toBe('mismatch');
  });
});
