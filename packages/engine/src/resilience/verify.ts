/**
 * Certificate verification (T-9.1/T-9.2).
 *
 * Two independent checks, combined into one verdict:
 *  1. integrity (offline): fingerprint recomputed from the stored run +
 *     evidence, sr25519 signature valid, address ↔ key consistent
 *  2. chain binding (online): every observed block hash (best and
 *     finalized, every phase) re-fetched by number from the network RPC
 *     and compared; the genesis hash too when recorded
 *
 * Verdicts are never upgraded: an unreachable network yields
 * `unverifiable` ("network offline"), a missing block yields `unverifiable`
 * ("block not found"), and only a full, matching re-fetch plus a valid
 * signature yields `verified`. Any integrity failure or hash difference is
 * `mismatch`, which always wins over `unverifiable`.
 */

import type { ScenarioRunRecord } from '../scenario/run-types';
import { checkCertificateSignature, type ResilienceCertificate, type SignatureCheck } from './certificate';
import type { ChainConsensusEvidence } from './consensus';
import type { ChainEvidence } from './evidence';
import { assessDrill, type DrillAssessment } from './integrity';
import { ChainUnreachableError, type ChainReader } from './rpc';

export type ChainCheckStatus = 'verified' | 'mismatch' | 'unverifiable';

export interface BlockCheck {
  phase: string;
  kind: 'best' | 'finalized' | 'genesis';
  number: number;
  expected: string;
  actual: string | null;
  ok: boolean;
}

export interface ChainCheck {
  status: ChainCheckStatus;
  reason: string;
  checks: BlockCheck[];
}

/**
 * Certificate verdict. `mismatch` always wins (tamper/contradiction);
 * `unverifiable` means the network could not be reached; `inconclusive`
 * means the evidence itself cannot support the drill outcome (missing
 * phases/metrics, or incomplete consensus context) even though the binding
 * checks passed.
 */
export type CertificateVerdict = ChainCheckStatus | 'inconclusive';

export interface CertificateVerification {
  status: CertificateVerdict;
  reasons: string[];
  integrity: SignatureCheck;
  chain: ChainCheck;
  devKey: boolean;
  /** Consensus context captured with the evidence (null when absent). */
  consensus: ChainConsensusEvidence | null;
  /** Recomputed drill assessment (outcome + evidence checks). */
  evidence: DrillAssessment;
  /** Stored evidenceHash vs recomputation; null for legacy certificates. */
  evidenceHashMatches: boolean | null;
}

export async function verifyChainEvidence(evidence: ChainEvidence, reader: ChainReader | null): Promise<ChainCheck> {
  if (!reader) return { status: 'unverifiable', reason: 'network offline: no RPC endpoint for this network', checks: [] };
  const wanted: Array<Omit<BlockCheck, 'actual' | 'ok'>> = [];
  if (evidence.genesisHash) wanted.push({ phase: 'genesis', kind: 'genesis', number: 0, expected: evidence.genesisHash });
  for (const o of evidence.observations) {
    wanted.push({ phase: o.phase, kind: 'best', number: o.best.number, expected: o.best.hash });
    wanted.push({ phase: o.phase, kind: 'finalized', number: o.finalized.number, expected: o.finalized.hash });
  }
  if (wanted.length === 0) return { status: 'unverifiable', reason: 'no chain observations recorded', checks: [] };

  const cache = new Map<number, string | null>();
  const checks: BlockCheck[] = [];
  try {
    for (const w of wanted) {
      if (!cache.has(w.number)) cache.set(w.number, await reader.blockHashAt(w.number));
      const actual = cache.get(w.number) ?? null;
      checks.push({ ...w, actual, ok: actual !== null && actual.toLowerCase() === w.expected.toLowerCase() });
    }
  } catch (e) {
    if (e instanceof ChainUnreachableError) {
      return { status: 'unverifiable', reason: `network offline: ${e.message}`, checks };
    }
    return { status: 'unverifiable', reason: `RPC error: ${e instanceof Error ? e.message : String(e)}`, checks };
  }
  const differing = checks.filter((c) => c.actual !== null && !c.ok);
  if (differing.length) {
    return {
      status: 'mismatch',
      reason: `${differing.length} block hash(es) differ from the network (e.g. #${differing[0]!.number} ${differing[0]!.kind}); the chain was reset, forked, or the evidence was altered`,
      checks,
    };
  }
  const missing = checks.filter((c) => c.actual === null);
  if (missing.length) {
    return {
      status: 'unverifiable',
      reason: `block not found on the network (#${missing[0]!.number}); the chain may have been reset or pruned`,
      checks,
    };
  }
  return { status: 'verified', reason: `${checks.length} block hash(es) match the network`, checks };
}

export async function verifyCertificate(
  cert: ResilienceCertificate,
  run: ScenarioRunRecord,
  reader: ChainReader | null,
): Promise<CertificateVerification> {
  const integrity = await checkCertificateSignature(cert, run);
  const chain = await verifyChainEvidence(cert.chain, reader);
  const consensus = cert.chain.consensus ?? null;
  const evidence = assessDrill(cert.chain, run.state);
  const reasons: string[] = [];
  if (!integrity.fingerprintMatches) reasons.push('fingerprint does not match the stored run + evidence');
  if (!integrity.metadataMatches) reasons.push('certificate metadata does not match the signed run + evidence');
  if (!integrity.signatureValid) reasons.push('sr25519 signature is invalid');
  if (!integrity.addressMatchesKey) reasons.push('signer address does not match the public key');

  const evidenceHashMatches =
    typeof cert.evidenceHash === 'string' ? cert.evidenceHash === evidence.integrity.evidenceHash : null;
  if (evidenceHashMatches === false) {
    reasons.push('stored evidenceHash does not match the recomputed evidence document');
  }
  reasons.push(`drill outcome: ${evidence.outcome} (${evidence.reasons.join('; ')})`);
  if (!evidence.integrity.metricsMatch) reasons.push('evidence metrics do not match a recomputation from the observations');
  if (!evidence.integrity.observationsValid) reasons.push('evidence contains malformed block references');
  if (!evidence.integrity.timestampsConsistent) reasons.push('evidence timestamps are inconsistent');

  if (consensus === null) {
    reasons.push('no consensus context: chain-bound recovery evidence only (no BABE/GRANDPA claim)');
  } else if (consensus.incomplete) {
    reasons.push(
      `consensus context incomplete: ${consensus.incompleteReasons.join('; ') || 'BABE authorship / GRANDPA finality context was not fully established'}`,
    );
  }

  const integrityOk =
    integrity.fingerprintMatches &&
    integrity.signatureValid &&
    integrity.addressMatchesKey &&
    integrity.metadataMatches;
  reasons.push(`chain: ${chain.reason}`);
  if (cert.signature.dev) reasons.push('DEV KEY: signed with a public test key — proves integrity, not operator identity');

  const tampered =
    !integrityOk ||
    chain.status === 'mismatch' ||
    evidenceHashMatches === false ||
    !evidence.integrity.metricsMatch ||
    !evidence.integrity.observationsValid ||
    !evidence.integrity.timestampsConsistent;
  const status: CertificateVerdict = tampered
    ? 'mismatch'
    : chain.status === 'unverifiable'
      ? 'unverifiable'
      : evidence.outcome === 'inconclusive' || (consensus !== null && consensus.incomplete)
        ? 'inconclusive'
        : 'verified';
  return { status, reasons, integrity, chain, devKey: cert.signature.dev, consensus, evidence, evidenceHashMatches };
}
