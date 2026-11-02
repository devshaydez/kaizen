/**
 * Signed, chain-bound certificates (T-9.2). Keys are well-known public DEV
 * URIs (`//Alice`, `//Bob`) — test material, never secrets.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  certificateMessage,
  checkCertificateSignature,
  computeCertificateFingerprint,
  computeRunHash,
  isKaizenError,
  issueCertificate,
  loadResilienceSigner,
  resilienceSignerConfigured,
} from '@kaizen/engine';
import { blockRef, fixtureEvidence, fixtureRun, hashOf } from './resilience-fixtures';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(isKaizenError(e) && e.code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('certificate fingerprint', () => {
  it('is deterministic and binds every observed block hash and metric', () => {
    const run = fixtureRun();
    const ev = fixtureEvidence();
    const fp = computeCertificateFingerprint(run, ev);
    expect(fp).toMatch(/^0x[0-9a-f]{64}$/);
    expect(computeCertificateFingerprint(fixtureRun(), fixtureEvidence())).toBe(fp);

    const tamperedHash = fixtureEvidence();
    tamperedHash.observations[1] = { ...tamperedHash.observations[1]!, finalized: { number: 98, hash: hashOf(98, 1) } };
    expect(computeCertificateFingerprint(run, tamperedHash)).not.toBe(fp);

    const tamperedMetric = fixtureEvidence({ metrics: { ...ev.metrics, timeToRecoverMs: 11_999 } });
    expect(computeCertificateFingerprint(run, tamperedMetric)).not.toBe(fp);

    expect(computeCertificateFingerprint(fixtureRun({ warnings: ['x'] } as never), ev)).not.toBe(fp);
  });

  it('domain-separates the signed message', () => {
    expect(certificateMessage('0xab')).toBe('kaizen:certificate:v1:0xab');
  });
});

describe('issueCertificate + checkCertificateSignature', () => {
  it('signs with sr25519 and verifies offline; links to the T-8.2 run hash', async () => {
    const signer = await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: '//Bob' } });
    expect(signer).toMatchObject({ address: BOB, source: 'env', dev: false });
    const run = fixtureRun();
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer, now: () => new Date(0) });
    expect(cert.runHash).toBe(computeRunHash(run));
    expect(cert.signature).toMatchObject({ address: BOB, scheme: 'sr25519', source: 'env', dev: false });
    expect(cert.signature.signature).toMatch(/^0x[0-9a-f]{128}$/);
    expect(JSON.stringify(cert)).not.toContain('//Bob');
    await expect(checkCertificateSignature(cert, run)).resolves.toMatchObject({
      fingerprintMatches: true,
      signatureValid: true,
      addressMatchesKey: true,
      metadataMatches: true,
      dev: false,
    });
  });

  it('detects a tampered record, a forged signature, and a swapped key', async () => {
    const signer = await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: '//Bob' } });
    const run = fixtureRun();
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });

    const tamperedChain = { ...cert, chain: { ...cert.chain, observations: [...cert.chain.observations] } };
    tamperedChain.chain.observations[0] = { ...tamperedChain.chain.observations[0]!, best: blockRef(99) };
    expect((await checkCertificateSignature(tamperedChain, run)).fingerprintMatches).toBe(false);

    const forged = { ...cert, signature: { ...cert.signature, signature: `0x${'00'.repeat(64)}` } };
    expect((await checkCertificateSignature(forged, run)).signatureValid).toBe(false);

    const alice = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    const swapped = { ...cert, signature: { ...cert.signature, publicKey: `0x${Buffer.from(alice.pair.publicKey).toString('hex')}` } };
    const check = await checkCertificateSignature(swapped, run);
    expect(check.signatureValid).toBe(false);
    expect(check.addressMatchesKey).toBe(false);

    expect((await checkCertificateSignature(cert, fixtureRun({ id: 'other' }))).fingerprintMatches).toBe(false);
  });

  it.each([
    ['validatorId', { validatorId: 'alice' }],
    ['networkId', { networkId: 'net_2' }],
    ['runHash', { runHash: `0x${'00'.repeat(32)}` }],
    ['run id', { runId: 'other-run' }],
  ] as const)('rejects a certificate with tampered top-level %s metadata', async (_field, tampering) => {
    const signer = await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: '//Bob' } });
    const run = fixtureRun();
    const cert = await issueCertificate({ run, chain: fixtureEvidence(), signer });
    const check = await checkCertificateSignature({ ...cert, ...tampering }, run);
    expect(check.metadataMatches).toBe(false);
    expect(check.fingerprintMatches).toBe(false);
  });

  it('refuses unfinished or rejected runs and evidence from another network', async () => {
    const signer = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    await expectCode(issueCertificate({ run: fixtureRun({ state: 'running' }), chain: fixtureEvidence(), signer }), 'RESILIENCE_NOT_CERTIFIABLE');
    await expectCode(issueCertificate({ run: fixtureRun({ state: 'rejected' }), chain: fixtureEvidence(), signer }), 'RESILIENCE_NOT_CERTIFIABLE');
    await expectCode(
      issueCertificate({ run: fixtureRun(), chain: fixtureEvidence({ networkId: 'net_2' }), signer }),
      'RESILIENCE_NOT_CERTIFIABLE',
    );
  });
});

describe('loadResilienceSigner', () => {
  it('uses the public dev key only when allowed AND the network is local, and labels it', async () => {
    const dev = await loadResilienceSigner({ allowDevKey: true, localTestNetwork: true, env: {} });
    expect(dev).toMatchObject({ address: ALICE, source: 'dev', dev: true });
    await expectCode(loadResilienceSigner({ allowDevKey: true, localTestNetwork: false, env: {} }), 'RESILIENCE_SIGNER_NOT_CONFIGURED');
    await expectCode(loadResilienceSigner({ env: {} }), 'RESILIENCE_SIGNER_NOT_CONFIGURED');
    expect(resilienceSignerConfigured({})).toBe(false);
  });

  it('loads a key file outside the working tree and refuses one inside it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-key-'));
    const file = path.join(dir, 'signer.suri');
    fs.writeFileSync(file, '//Bob\n', { mode: 0o600 });
    const env = { KAIZEN_RESILIENCE_SIGNER_FILE: file };
    expect(resilienceSignerConfigured(env)).toBe(true);
    await expect(loadResilienceSigner({ env, forbiddenRoots: [process.cwd()] })).resolves.toMatchObject({
      address: BOB,
      source: 'file',
      dev: false,
    });
    await expectCode(loadResilienceSigner({ env, forbiddenRoots: [dir] }), 'RESILIENCE_SIGNER_INVALID');
    await expectCode(
      loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_FILE: path.join(dir, 'missing') }, forbiddenRoots: [] }),
      'RESILIENCE_SIGNER_INVALID',
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('never echoes an invalid secret', async () => {
    try {
      await loadResilienceSigner({ env: { KAIZEN_RESILIENCE_SIGNER_SURI: 'not a valid uri at all zzz !!!' } });
      throw new Error('expected failure');
    } catch (e) {
      expect(isKaizenError(e) && e.code).toBe('RESILIENCE_SIGNER_INVALID');
      expect(String((e as Error).message)).not.toContain('zzz');
    }
  });
});
