/**
 * Third-party attestations (A2). Keys are well-known public DEV URIs
 * (`//Alice` signs the certificate, `//Bob` attests) - test material,
 * never secrets. Score weighting pins the A2 rule: a valid different-key
 * verdict=verified attestation counts like signed-chain-verified.
 */

import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_MAX_AGE_DAYS,
  attestationMessage,
  checkAttestation,
  classifyEvidence,
  computeResilienceScore,
  isKaizenError,
  issueAttestation,
  issueCertificate,
  loadAttestationSigner,
  loadResilienceSigner,
  type ChainReader,
  type ScoredRunInput,
} from '@kaizen/engine';
import { fixtureEvidence, fixtureRun, hashOf } from './resilience-fixtures';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

interface ScriptedReader extends ChainReader {
  calls: number[];
}

function reader(chain: (n: number) => string | null | Error): ScriptedReader {
  return {
    calls: [],
    async blockHashAt(n: number) {
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

async function signedCert() {
  const signer = await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: '//Alice' } });
  const run = fixtureRun();
  return { run, cert: await issueCertificate({ run, chain: fixtureEvidence(), signer }) };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isKaizenError(e) && e.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('attestation message + signer loading', () => {
  it('domain-separates the signed statement', () => {
    expect(attestationMessage('0xab', 'verified', '2026-10-28T00:00:00.000Z')).toBe(
      'kaizen:attestation:v1:0xab:verified:2026-10-28T00:00:00.000Z',
    );
  });

  it('refuses to attest without a configured attester key', async () => {
    await expectCode(loadAttestationSigner({}), 'ATTESTATION_SIGNER_NOT_CONFIGURED');
  });

  it('loads the attester from the environment (no dev fallback exists)', async () => {
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: '//Bob' });
    expect(attester).toMatchObject({ address: BOB, source: 'env', dev: false });
  });
});

describe('issueAttestation + checkAttestation', () => {
  it('issues verdict=verified after a full chain match and verifies offline', async () => {
    const { run, cert } = await signedCert();
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: '//Bob' });
    const att = await issueAttestation({
      certificate: cert,
      run,
      attester,
      reader: reader(hashOf),
      now: () => new Date('2026-10-28T00:00:00Z'),
    });
    expect(att.verdict).toBe('verified');
    expect(att.certificateFingerprint).toBe(cert.fingerprint);
    expect(att.attester).toMatchObject({ address: BOB, scheme: 'sr25519' });
    expect(JSON.stringify(att)).not.toContain("//Bob");
    await expect(checkAttestation(att, cert, { now: new Date("2026-10-28T00:00:00Z") })).resolves.toMatchObject({
      valid: true,
      reason: null,
      verdict: 'verified',
    });
  });

  it('issues verdict=mismatch when the chain disagrees, and the check still holds', async () => {
    const { run, cert } = await signedCert();
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: '//Bob' });
    const att = await issueAttestation({
      certificate: cert,
      run,
      attester,
      reader: reader((n) => (n >= 104 ? hashOf(n + 1_000) : hashOf(n))),
    });
    expect(att.verdict).toBe('mismatch');
    await expect(checkAttestation(att, cert)).resolves.toMatchObject({ valid: true, verdict: "mismatch" });
  });

  it('refuses a self-attestation by the certificate signer', async () => {
    const { run, cert } = await signedCert();
    const same = await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: '//Alice' } });
    await expectCode(issueAttestation({ certificate: cert, run, attester: same, reader: reader(hashOf) }), 'ATTESTATION_SAME_KEY');
    // and a forged same-key record never passes the check
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: "//Bob" });
    const att = await issueAttestation({ certificate: cert, run, attester, reader: reader(hashOf) });
    const forged = { ...att, attester: { ...att.attester, publicKey: cert.signature.publicKey, address: ALICE } };
    await expect(checkAttestation(forged, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining("self-attestation") });
  });

  it('detects a tampered verdict, a forged signature and a wrong fingerprint', async () => {
    const { run, cert } = await signedCert();
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: "//Bob" });
    const att = await issueAttestation({ certificate: cert, run, attester, reader: reader(hashOf) });
    const flipped = { ...att, verdict: 'mismatch' as const };
    await expect(checkAttestation(flipped, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining('signature') });
    const otherFp = { ...att, certificateFingerprint: '0x' + '0'.repeat(64) };
    await expect(checkAttestation(otherFp, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining('fingerprint') });
    await expect(checkAttestation({ ...att, checkedAt: 'not-a-date' }, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining('ISO-8601') });
  });

  it('expires old attestations and rejects future ones (replay rules)', async () => {
    const { cert } = await signedCert();
    const attester = await loadAttestationSigner({ KAIZEN_ATTESTER_SURI: "//Bob" });
    const old = new Date(Date.now() - (ATTESTATION_MAX_AGE_DAYS + 1) * 86_400_000);
    const att = await issueAttestation({ certificate: cert, run: fixtureRun(), attester, reader: reader(hashOf), now: () => old });
    await expect(checkAttestation(att, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining("expired") });
    const future = { ...att, checkedAt: new Date(Date.now() + 3_600_000).toISOString() };
    await expect(checkAttestation(future, cert)).resolves.toMatchObject({ valid: false, reason: expect.stringContaining("future") });
  });
});

describe('score v2 weighting with attestations (A2)', () => {
  const run = (o: Partial<ScoredRunInput> = {}): ScoredRunInput => ({
    runId: 'r1',
    runState: 'completed',
    recovered: true,
    timeToRecoverMs: 12_000,
    finalityGapBlocks: 6,
    blocksMissed: 6,
    certifiedAt: '2026-10-24T00:00:00Z',
    ...o,
  });
  const asOf = new Date("2026-10-24T00:00:00Z");

  it('an attested run weighs 1.0, the same as signed-chain-verified, not 0.7', () => {
    const local = computeResilienceScore("v", [run({ evidenceClass: "signed-local" })], asOf);
    const attested = computeResilienceScore("v", [run({ evidenceClass: "signed-chain-verified" })], asOf);
    expect(attested.effectiveRuns / local.effectiveRuns).toBeCloseTo(1 / 0.7, 3);
  });

  it('classifyEvidence promotes signed-local to signed-chain-verified only for a valid different-key attestation', () => {
    expect(classifyEvidence({ signatureValid: true, chainVerified: false })).toBe('signed-local');
    expect(classifyEvidence({ signatureValid: true, chainVerified: false, independentlyAttested: true })).toBe('signed-chain-verified');
    expect(classifyEvidence({ signatureValid: false, chainVerified: false, independentlyAttested: true })).toBe('unsigned');
  });
});
