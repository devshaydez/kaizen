/**
 * Portable certificate bundle (A1).
 *
 * A certificate's fingerprint covers the whole scenario run, but the
 * certificate JSON alone does not carry that run. The bundle pairs the two so
 * anyone can verify a certificate from a single file, without Kaizen's state
 * store: `kaizen verify-certificate --bundle <file> [--rpc <url>]`.
 *
 * Verification reuses `verifyCertificate`, so verdicts are never upgraded:
 * without an RPC endpoint the chain binding is `unverifiable`, never verified.
 */

import { KaizenError } from '../errors';
import type { ScenarioRunRecord } from '../scenario/run-types';
import type { KaizenAttestation } from './attestation';
import type { ResilienceCertificate } from './certificate';
import type { ChainReader } from './rpc';
import { verifyCertificate, type CertificateVerification } from './verify';

export const KAIZEN_BUNDLE_VERSION = 1;

export interface CertificateBundle {
  kaizenCertificateBundle: typeof KAIZEN_BUNDLE_VERSION;
  certificate: ResilienceCertificate;
  run: ScenarioRunRecord;
  // A2: optional third-party attestations; verifiable with checkAttestation.
  attestations?: KaizenAttestation[];
}

export function buildCertificateBundle(
  certificate: ResilienceCertificate,
  run: ScenarioRunRecord,
  attestations?: KaizenAttestation[],
): CertificateBundle {
  return {
    kaizenCertificateBundle: KAIZEN_BUNDLE_VERSION,
    certificate,
    run,
    ...(attestations && attestations.length > 0 ? { attestations } : {}),
  };
}

/** Parse and shape-check bundle JSON; throws KaizenError('INVALID_INPUT') on anything malformed. */
export function parseCertificateBundle(text: string): CertificateBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new KaizenError('INVALID_INPUT', 'bundle is not valid JSON');
  }
  const b = raw as Partial<CertificateBundle> | null;
  if (
    !b ||
    typeof b !== 'object' ||
    b.kaizenCertificateBundle !== KAIZEN_BUNDLE_VERSION
  ) {
    throw new KaizenError(
      'INVALID_INPUT',
      `not a Kaizen certificate bundle (expected kaizenCertificateBundle: ${KAIZEN_BUNDLE_VERSION})`,
    );
  }
  const c = b.certificate;
  if (
    !c ||
    typeof c.fingerprint !== 'string' ||
    typeof c.runId !== 'string' ||
    !c.chain ||
    !c.signature
  ) {
    throw new KaizenError(
      'INVALID_INPUT',
      'bundle.certificate is missing required fields',
    );
  }
  if (!b.run || typeof b.run !== 'object' || b.run.id !== c.runId) {
    throw new KaizenError(
      'INVALID_INPUT',
      'bundle.run is missing or does not match certificate.runId',
    );
  }
  if (
    b.attestations !== undefined &&
    (!Array.isArray(b.attestations) ||
      b.attestations.some(
        (a) =>
          !a ||
          typeof a !== 'object' ||
          typeof (a as KaizenAttestation).certificateFingerprint !== 'string' ||
          !a.attester,
      ))
  ) {
    throw new KaizenError('INVALID_INPUT', 'bundle.attestations is malformed');
  }
  return b as CertificateBundle;
}

export function verifyCertificateBundle(
  bundle: CertificateBundle,
  reader: ChainReader | null,
): Promise<CertificateVerification> {
  return verifyCertificate(bundle.certificate, bundle.run, reader);
}
