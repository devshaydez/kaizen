//
// Independent third-party attestations (A2).
//
// An attestation is an sr25519-signed statement by a verifier key that is
// NOT the certificate signer, saying the verifier re-verified the
// certificate against chain data. Signed message (domain-separated):
//
//   kaizen:attestation:v1:<certificateFingerprint>:<verdict>:<checkedAtISO>
//
// with verdict in {verified, mismatch}. The attestation record is a JSON
// object:
//
//   { kaizenAttestation: 1, certificateFingerprint, verdict, checkedAt,
//     attester: { address, publicKey, scheme, source, dev }, signature }
//
// Replay and expiry rules (checkAttestation): checkedAt must parse as
// ISO-8601, must not be in the future at check time, and must not be
// older than the maximum age (default 30 days); an expired or replayed
// statement is invalid, never upgraded. As with every Kaizen signer
// surface, the secret URI is only ever read from the environment or a
// file outside the repository and never logged, persisted or returned.

import fs from 'node:fs';
import path from 'node:path';
import { Keyring } from '@polkadot/keyring';
import type { KeyringPair } from '@polkadot/keyring/types';
import { cryptoWaitReady, decodeAddress, signatureVerify } from '@polkadot/util-crypto';
import { KaizenError } from '../errors';
import type { ScenarioRunRecord } from '../scenario/run-types';
import type { ResilienceCertificate } from './certificate';
import type { ChainReader } from './rpc';
import { verifyCertificate } from './verify';

export const KAIZEN_ATTESTATION_VERSION = 1 as const;

// Environment variable holding the attester's secret URI.
export const ATTESTATION_SIGNER_ENV_KEY = 'KAIZEN_ATTESTER_SURI';
// Path to a file holding the attester's secret URI (must be outside the repo).
export const ATTESTATION_SIGNER_FILE_ENV_KEY = 'KAIZEN_ATTESTER_SURI_FILE';

export const ATTESTATION_VERDICTS = ['verified', 'mismatch'] as const;
export type AttestationVerdict = (typeof ATTESTATION_VERDICTS)[number];

// Default replay window: an attestation older than this is not counted.
export const ATTESTATION_MAX_AGE_DAYS = 30;

const DAY_MS = 86_400_000;

export interface AttestationSignature {
  // SS58 (prefix 42) address of the attesting key (display only).
  address: string;
  // 0x-prefixed 32-byte sr25519 public key.
  publicKey: string;
  scheme: 'sr25519';
  source: 'env' | 'file' | 'dev';
  dev: boolean;
  // 0x-prefixed 64-byte signature over attestationMessage(...).
  signature: string;
}

export interface KaizenAttestation {
  version: typeof KAIZEN_ATTESTATION_VERSION;
  certificateFingerprint: string;
  verdict: AttestationVerdict;
  // When the verifier re-checked the certificate (ISO-8601).
  checkedAt: string;
  attester: AttestationSignature;
}

export interface AttestationSigner {
  address: string;
  pair: KeyringPair;
  source: 'env' | 'file' | 'dev';
  dev: boolean;
}

export function attestationMessage(fingerprint: string, verdict: AttestationVerdict, checkedAt: string): string {
  return `kaizen:attestation:v${KAIZEN_ATTESTATION_VERSION}:${fingerprint}:${verdict}:${checkedAt}`;
}

function u8aToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

// Attester signer loading: KAIZEN_ATTESTER_SURI (or KAIZEN_ATTESTER_SURI_FILE,
// outside the repository). Unlike the certificate signer there is NO dev
// fallback: a third-party attestation only means something from a configured
// key. The secret is never logged, persisted or returned.
export async function loadAttestationSigner(env: NodeJS.ProcessEnv = process.env): Promise<AttestationSigner> {
  await cryptoWaitReady();
  const file = env[ATTESTATION_SIGNER_FILE_ENV_KEY];
  let uri = env[ATTESTATION_SIGNER_ENV_KEY]?.trim();
  let source: 'env' | 'file' = 'env';
  if (!uri && file) {
    const resolved = path.resolve(file);
    const rel = path.relative(process.cwd(), resolved);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      throw new KaizenError('ATTESTATION_SIGNER_NOT_CONFIGURED', `${ATTESTATION_SIGNER_FILE_ENV_KEY} must point outside the working directory (key withheld).`, { envKey: ATTESTATION_SIGNER_FILE_ENV_KEY });
    }
    try {
      uri = fs.readFileSync(resolved, 'utf8').trim();
    } catch {
      throw new KaizenError('ATTESTATION_SIGNER_NOT_CONFIGURED', `cannot read ${ATTESTATION_SIGNER_FILE_ENV_KEY} (contents withheld).`, { envKey: ATTESTATION_SIGNER_FILE_ENV_KEY });
    }
    source = 'file';
  }
  if (!uri) {
    throw new KaizenError('ATTESTATION_SIGNER_NOT_CONFIGURED', `no attester key: set ${ATTESTATION_SIGNER_ENV_KEY} (or ${ATTESTATION_SIGNER_FILE_ENV_KEY})`, { envKey: ATTESTATION_SIGNER_ENV_KEY });
  }
  let pair: KeyringPair;
  try {
    pair = new Keyring({ type: 'sr25519', ss58Format: 42 }).addFromUri(uri);
  } catch {
    throw new KaizenError('RESILIENCE_SIGNER_INVALID', 'attester key URI is not valid (value withheld).', { envKey: source === 'file' ? ATTESTATION_SIGNER_FILE_ENV_KEY : ATTESTATION_SIGNER_ENV_KEY });
  }
  return { address: pair.address, pair, source, dev: false };
}

// Re-verify a certificate against chain (when a reader is available) and
// sign the result with the attester key. The attester key must differ from
// the certificate signer: a self-attestation is refused outright.
export async function issueAttestation(input: {
  certificate: ResilienceCertificate;
  run: ScenarioRunRecord;
  attester: AttestationSigner;
  reader: ChainReader | null;
  now?: () => Date;
}): Promise<KaizenAttestation> {
  const { certificate, run, attester, reader } = input;
  if (u8aToHex(attester.pair.publicKey) === certificate.signature.publicKey) {
    throw new KaizenError('ATTESTATION_SAME_KEY', 'an attestation must come from a key other than the certificate signer');
  }
  const v = await verifyCertificate(certificate, run, reader);
  const verdict: AttestationVerdict = v.status === 'verified' ? 'verified' : 'mismatch';
  await cryptoWaitReady();
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const signature = u8aToHex(attester.pair.sign(attestationMessage(certificate.fingerprint, verdict, checkedAt)));
  return {
    version: KAIZEN_ATTESTATION_VERSION,
    certificateFingerprint: certificate.fingerprint,
    verdict,
    checkedAt,
    attester: {
      address: attester.address,
      publicKey: u8aToHex(attester.pair.publicKey),
      scheme: 'sr25519',
      source: attester.source,
      dev: attester.dev,
      signature,
    },
  };
}

export interface AttestationCheck {
  valid: boolean;
  // Null when valid; otherwise why it was rejected.
  reason: string | null;
  verdict: AttestationVerdict | null;
  expired: boolean;
  sameKey: boolean;
  addressMatchesKey: boolean;
  signatureValid: boolean;
}

// Full check of one attestation against its certificate: shape, fingerprint
// binding, freshness (replay and expiry), key consistency, sr25519 signature,
// and that the attester key differs from the certificate signer. Invalid
// attestations are never upgraded to valid and never counted.
export async function checkAttestation(
  attestation: KaizenAttestation,
  certificate: ResilienceCertificate,
  options: { now?: Date; maxAgeDays?: number } = {},
): Promise<AttestationCheck> {
  const reject = (reason: string): AttestationCheck => ({
    valid: false,
    reason,
    verdict: null,
    expired: false,
    sameKey: false,
    addressMatchesKey: false,
    signatureValid: false,
  });
  if (attestation.version !== KAIZEN_ATTESTATION_VERSION) return reject('unsupported attestation version');
  if (!ATTESTATION_VERDICTS.includes(attestation.verdict)) return reject('unknown verdict');
  if (attestation.certificateFingerprint !== certificate.fingerprint) return reject('fingerprint does not match the certificate');
  const t = Date.parse(attestation.checkedAt);
  if (Number.isNaN(t) || !/^\d{4}-\d{2}-\d{2}T/.test(attestation.checkedAt)) return reject('checkedAt is not ISO-8601');
  const now = options.now ?? new Date();
  if (t > now.getTime() + 60_000) return reject('checkedAt is in the future');
  const maxAgeDays = options.maxAgeDays ?? ATTESTATION_MAX_AGE_DAYS;
  if (now.getTime() - t > maxAgeDays * DAY_MS) return reject(`attestation expired (older than ${maxAgeDays} days)`);
  const sameKey = attestation.attester.publicKey === certificate.signature.publicKey;
  if (sameKey) return reject('attester key is the certificate signer (self-attestation is not independent)');
  let signatureValid = false;
  try {
    signatureValid = signatureVerify(
      attestationMessage(attestation.certificateFingerprint, attestation.verdict, attestation.checkedAt),
      attestation.attester.signature,
      attestation.attester.publicKey,
    ).isValid;
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return reject('attester signature is not valid');
  let addressMatchesKey = false;
  try {
    addressMatchesKey = u8aToHex(decodeAddress(attestation.attester.address)) === attestation.attester.publicKey;
  } catch {
    addressMatchesKey = false;
  }
  if (!addressMatchesKey) return reject('attester address does not match its public key');
  return { valid: true, reason: null, verdict: attestation.verdict, expired: false, sameKey, addressMatchesKey, signatureValid };
}
