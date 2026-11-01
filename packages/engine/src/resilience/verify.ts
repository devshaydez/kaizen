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

import type { ScenarioRunRecord } from "../scenario/run-types";
import {
  checkCertificateSignature,
  type ResilienceCertificate,
  type SignatureCheck,
} from "./certificate";
import { checkDrillRecord } from "./drill-record";
import type { ChainEvidence } from "./evidence";
import { ChainUnreachableError, type ChainReader } from "./rpc";

export type ChainCheckStatus = "verified" | "mismatch" | "unverifiable";

export interface BlockCheck {
  phase: string;
  kind: "best" | "finalized" | "genesis";
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

export interface CertificateVerification {
  status: ChainCheckStatus;
  reasons: string[];
  integrity: SignatureCheck;
  chain: ChainCheck;
  devKey: boolean;
}

export async function verifyChainEvidence(
  evidence: ChainEvidence,
  reader: ChainReader | null,
): Promise<ChainCheck> {
  if (!reader)
    return {
      status: "unverifiable",
      reason: "network offline: no RPC endpoint for this network",
      checks: [],
    };
  const wanted: Array<Omit<BlockCheck, "actual" | "ok">> = [];
  if (evidence.genesisHash)
    wanted.push({
      phase: "genesis",
      kind: "genesis",
      number: 0,
      expected: evidence.genesisHash,
    });
  for (const o of evidence.observations) {
    wanted.push({
      phase: o.phase,
      kind: "best",
      number: o.best.number,
      expected: o.best.hash,
    });
    wanted.push({
      phase: o.phase,
      kind: "finalized",
      number: o.finalized.number,
      expected: o.finalized.hash,
    });
  }
  if (wanted.length === 0)
    return {
      status: "unverifiable",
      reason: "no chain observations recorded",
      checks: [],
    };

  const cache = new Map<number, string | null>();
  const checks: BlockCheck[] = [];
  try {
    for (const w of wanted) {
      if (!cache.has(w.number))
        cache.set(w.number, await reader.blockHashAt(w.number));
      const actual = cache.get(w.number) ?? null;
      checks.push({
        ...w,
        actual,
        ok:
          actual !== null && actual.toLowerCase() === w.expected.toLowerCase(),
      });
    }
  } catch (e) {
    if (e instanceof ChainUnreachableError) {
      return {
        status: "unverifiable",
        reason: `network offline: ${e.message}`,
        checks,
      };
    }
    return {
      status: "unverifiable",
      reason: `RPC error: ${e instanceof Error ? e.message : String(e)}`,
      checks,
    };
  }
  const differing = checks.filter((c) => c.actual !== null && !c.ok);
  if (differing.length) {
    return {
      status: "mismatch",
      reason: `${differing.length} block hash(es) differ from the network (e.g. #${differing[0]!.number} ${differing[0]!.kind}); the chain was reset, forked, or the evidence was altered`,
      checks,
    };
  }
  const missing = checks.filter((c) => c.actual === null);
  if (missing.length) {
    return {
      status: "unverifiable",
      reason: `block not found on the network (#${missing[0]!.number}); the chain may have been reset or pruned`,
      checks,
    };
  }
  return {
    status: "verified",
    reason: `${checks.length} block hash(es) match the network`,
    checks,
  };
}

export async function verifyCertificate(
  cert: ResilienceCertificate,
  run: ScenarioRunRecord,
  reader: ChainReader | null,
): Promise<CertificateVerification> {
  const integrity = await checkCertificateSignature(cert, run);
  const chain = await verifyChainEvidence(cert.chain, reader);
  const reasons: string[] = [];
  if (!integrity.fingerprintMatches)
    reasons.push("fingerprint does not match the stored run + evidence");
  if (!integrity.metadataMatches)
    reasons.push(
      "certificate metadata does not match the signed run + evidence",
    );
  if (!integrity.signatureValid) reasons.push("sr25519 signature is invalid");
  if (!integrity.addressMatchesKey)
    reasons.push("signer address does not match the public key");
  let drillOk = true;
  if (cert.drill) {
    drillOk =
      checkDrillRecord(cert.drill).ok &&
      cert.drill.validatorId === cert.validatorId;
    if (!drillOk)
      reasons.push(
        "drill record is inconsistent (ordering, seed derivation or validator)",
      );
  }
  const integrityOk =
    integrity.fingerprintMatches &&
    integrity.signatureValid &&
    integrity.addressMatchesKey &&
    integrity.metadataMatches &&
    drillOk;
  reasons.push(`chain: ${chain.reason}`);
  if (cert.signature.dev)
    reasons.push(
      "DEV KEY: signed with a public test key — proves integrity, not operator identity",
    );
  const status: ChainCheckStatus =
    !integrityOk || chain.status === "mismatch" ? "mismatch" : chain.status;
  return { status, reasons, integrity, chain, devKey: cert.signature.dev };
}
