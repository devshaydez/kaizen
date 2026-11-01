/**
 * Resilience certificates (T-9.2): a canonical, chain-bound, operator-signed
 * record of one finished Failure Lab run.
 *
 * Fingerprint = `0x` + SHA-256 over the canonical JSON (same encoder as the
 * T-8.2 run hash: sorted keys, no whitespace) of the versioned document
 *
 *   { kaizenCertificate: 1, runHash, run, chain }
 *
 * where `run` is the persisted ScenarioRunRecord, `runHash` its T-8.2
 * anchor hash (links certificates to existing anchors), and `chain` the
 * ChainEvidence (observed block hashes + recovery metrics). Changing any
 * observed hash or metric changes the fingerprint.
 *
 * The operator signs the domain-separated message
 * `kaizen:certificate:v1:<fingerprint>` with an sr25519 key. Verification
 * recomputes the fingerprint and checks the signature against the recorded
 * public key; certificates signed with a well-known DEV key are labelled
 * (`signer.dev = true`) — they prove integrity, not operator identity.
 */

import {
  cryptoWaitReady,
  decodeAddress,
  signatureVerify,
} from "@polkadot/util-crypto";
import { KaizenError } from "../errors";
import type { ScenarioRunRecord } from "../scenario/run-types";
import { isTerminalScenarioRunState } from "../scenario/run-types";
import {
  canonicalJson,
  computeRunHash,
  sha256Hex,
} from "../v3/anchor/canonical";
import type { DrillRecord } from "./drill-record";
import type { ChainEvidence } from "./evidence";
import type { ResilienceSigner, ResilienceSignerSource } from "./signer";

export const KAIZEN_CERTIFICATE_VERSION = 1 as const;

function u8aToHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export interface CertificateSignature {
  /** SS58 (prefix 42) address of the signing key. */
  address: string;
  /** 0x-prefixed 32-byte sr25519 public key. */
  publicKey: string;
  scheme: "sr25519";
  /** Where the key came from; `dev` = well-known public test key. */
  source: ResilienceSignerSource;
  dev: boolean;
  /** 0x-prefixed 64-byte signature over certificateMessage(fingerprint). */
  signature: string;
}

export interface ResilienceCertificate {
  version: typeof KAIZEN_CERTIFICATE_VERSION;
  fingerprint: string;
  runId: string;
  runHash: string;
  validatorId: string;
  networkId: string;
  chain: ChainEvidence;
  /** Optional commit-reveal drill record; when present it is part of the fingerprint. */
  drill?: DrillRecord;
  signature: CertificateSignature;
  /** When the certificate was signed (not part of the fingerprint). */
  signedAt: string;
}

export function certificateDocument(
  run: ScenarioRunRecord,
  chain: ChainEvidence,
  drill?: DrillRecord,
): string {
  return canonicalJson({
    kaizenCertificate: KAIZEN_CERTIFICATE_VERSION,
    runHash: computeRunHash(run),
    run,
    chain,
    ...(drill ? { drill } : {}),
  });
}

export function computeCertificateFingerprint(
  run: ScenarioRunRecord,
  chain: ChainEvidence,
  drill?: DrillRecord,
): string {
  return sha256Hex(certificateDocument(run, chain, drill));
}

export function certificateMessage(fingerprint: string): string {
  return `kaizen:certificate:v${KAIZEN_CERTIFICATE_VERSION}:${fingerprint}`;
}

/** Build and sign a certificate for a TERMINAL run. */
export async function issueCertificate(input: {
  run: ScenarioRunRecord;
  chain: ChainEvidence;
  drill?: DrillRecord;
  signer: ResilienceSigner;
  now?: () => Date;
}): Promise<ResilienceCertificate> {
  const { run, chain, signer, drill } = input;
  if (!isTerminalScenarioRunState(run.state) || run.state === "rejected") {
    throw new KaizenError(
      "RESILIENCE_NOT_CERTIFIABLE",
      `run ${run.id} is ${run.state}; only finished, executed runs can be certified`,
    );
  }
  if (chain.networkId !== run.networkId) {
    throw new KaizenError(
      "RESILIENCE_NOT_CERTIFIABLE",
      "chain evidence belongs to a different network than the run",
    );
  }
  await cryptoWaitReady();
  const fingerprint = computeCertificateFingerprint(run, chain, drill);
  const signature = u8aToHex(signer.pair.sign(certificateMessage(fingerprint)));
  return {
    version: KAIZEN_CERTIFICATE_VERSION,
    fingerprint,
    runId: run.id,
    runHash: computeRunHash(run),
    validatorId: chain.validatorId,
    networkId: chain.networkId,
    chain,
    ...(drill ? { drill } : {}),
    signature: {
      address: signer.address,
      publicKey: u8aToHex(signer.pair.publicKey),
      scheme: "sr25519",
      source: signer.source,
      dev: signer.dev,
      signature,
    },
    signedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

export interface SignatureCheck {
  fingerprintMatches: boolean;
  recomputedFingerprint: string;
  signatureValid: boolean;
  /** Address ↔ public key consistency (the address is display-only). */
  addressMatchesKey: boolean;
  /** Top-level metadata agrees with the supplied run and chain evidence. */
  metadataMatches: boolean;
  dev: boolean;
}

/**
 * Offline integrity check: recompute the fingerprint from the stored run +
 * chain evidence and verify the sr25519 signature. Chain re-fetch is
 * separate (`verifyChainEvidence`).
 */
export async function checkCertificateSignature(
  cert: ResilienceCertificate,
  run: ScenarioRunRecord,
): Promise<SignatureCheck> {
  await cryptoWaitReady();
  const recomputed = computeCertificateFingerprint(run, cert.chain, cert.drill);
  const metadataMatches =
    cert.runId === run.id &&
    cert.runHash === computeRunHash(run) &&
    cert.validatorId === cert.chain.validatorId &&
    cert.networkId === run.networkId &&
    cert.networkId === cert.chain.networkId;
  let signatureValid = false;
  try {
    signatureValid = signatureVerify(
      certificateMessage(cert.fingerprint),
      cert.signature.signature,
      cert.signature.publicKey,
    ).isValid;
  } catch {
    signatureValid = false;
  }
  let addressMatchesKey = false;
  try {
    addressMatchesKey =
      u8aToHex(decodeAddress(cert.signature.address)) ===
      cert.signature.publicKey;
  } catch {
    addressMatchesKey = false;
  }
  return {
    fingerprintMatches: recomputed === cert.fingerprint && metadataMatches,
    recomputedFingerprint: recomputed,
    signatureValid,
    addressMatchesKey,
    metadataMatches,
    dev: cert.signature.dev,
  };
}
