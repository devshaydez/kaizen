/**
 * Evidence integrity and drill-outcome classification (T-9.7C).
 *
 * Verification must not stop at "the signature is valid". This module
 * recomputes every derived metric from the observations, checks that the
 * recorded event order is internally consistent, classifies the drill
 * (`passed` / `failed` / `inconclusive`), and produces a hash over the
 * canonical evidence so a stored evidence document can be compared with the
 * one that was certified.
 *
 * Distinctions that matter:
 *  - a **failed** drill is an observed outcome (no finality recovery, or a
 *    failed run) and is still certifiable;
 *  - **inconclusive** means the evidence cannot support either claim
 *    (integrity mismatch, missing phases, missing derivable metrics);
 *  - missing consensus context is reported separately; it does not turn a
 *    chain-bound recovery claim into a failure, but it does make
 *    consensus-level claims inconclusive.
 */

import { canonicalJson, sha256Hex } from '../v3/anchor/canonical';
import type { ChainConsensusEvidence } from './consensus';
import {
  computeRecoveryMetrics,
  isBlockRef,
  type ChainEvidence,
  type ChainEvidencePhase,
  type RecoveryMetrics,
} from './evidence';

export type DrillOutcome = 'passed' | 'failed' | 'inconclusive';

export interface EvidenceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConsensusIntegrity {
  present: boolean;
  complete: boolean;
  reasons: string[];
}

export interface EvidenceIntegrity {
  /** Observations cover every phase and all metrics are derivable. */
  complete: boolean;
  /** Stored metrics equal a fresh recomputation. */
  metricsMatch: boolean;
  /** Observation/fault timestamps are ordered consistently. */
  timestampsConsistent: boolean;
  /** Every block reference is well formed and finalized ≤ best. */
  observationsValid: boolean;
  consensus: ConsensusIntegrity;
  checks: EvidenceCheck[];
  /** All failing checks, in a stable order. */
  reasons: string[];
  recomputedMetrics: RecoveryMetrics;
  /** SHA-256 over the canonical evidence document. */
  evidenceHash: string;
}

const PHASES: readonly ChainEvidencePhase[] = ['before-fault', 'during-fault', 'after-recovery'];
const EPSILON_MS = 1_000;

function parseAt(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function phaseCounts(evidence: ChainEvidence): Record<ChainEvidencePhase, number> {
  const counts: Record<ChainEvidencePhase, number> = { 'before-fault': 0, 'during-fault': 0, 'after-recovery': 0 };
  for (const o of evidence.observations) counts[o.phase] += 1;
  return counts;
}

/**
 * Recompute and check one evidence document. Pure: no I/O and no clock. The
 * caller supplies the document; every result is derived from it.
 */
export function checkEvidenceIntegrity(evidence: ChainEvidence): EvidenceIntegrity {
  const checks: EvidenceCheck[] = [];

  const observationsValid = evidence.observations.every(
    (o) => isBlockRef(o.best) && isBlockRef(o.finalized) && o.finalized.number <= o.best.number && parseAt(o.at) !== null,
  );
  checks.push({
    name: 'observations',
    ok: observationsValid,
    detail: observationsValid
      ? `${evidence.observations.length} observation(s) have valid block references and finalized ≤ best`
      : 'an observation has a malformed block reference, invalid time, or finalized > best',
  });

  const ordered = [...evidence.observations].sort((a, b) => (parseAt(a.at) ?? 0) - (parseAt(b.at) ?? 0));
  const phaseOrder = ordered.every((o, i) => i === 0 || PHASES.indexOf(ordered[i - 1]!.phase) <= PHASES.indexOf(o.phase));
  const counts = phaseCounts(evidence);
  const phaseCoverage = PHASES.every((p) => counts[p] > 0);

  const faultStart = evidence.faultStartedAt === null ? null : parseAt(evidence.faultStartedAt);
  const faultEnd = evidence.faultEndedAt === null ? null : parseAt(evidence.faultEndedAt);
  const recovered = evidence.recoveredAt === null ? null : parseAt(evidence.recoveredAt);
  const clockReasons: string[] = [];
  if (faultStart === null && evidence.faultStartedAt !== null) clockReasons.push('faultStartedAt is not a valid timestamp');
  if (faultEnd === null && evidence.faultEndedAt !== null) clockReasons.push('faultEndedAt is not a valid timestamp');
  if (recovered === null && evidence.recoveredAt !== null) clockReasons.push('recoveredAt is not a valid timestamp');
  if (faultStart !== null && faultEnd !== null && faultEnd < faultStart) clockReasons.push('fault ends before it starts');
  if (recovered !== null && faultEnd !== null && recovered + EPSILON_MS < faultEnd) {
    clockReasons.push('recoveredAt precedes faultEndedAt');
  }
  for (const o of evidence.observations) {
    const t = parseAt(o.at);
    if (t === null) continue;
    if (o.phase === 'before-fault' && faultStart !== null && t > faultStart + EPSILON_MS) {
      clockReasons.push(`before-fault observation at ${o.at} is after the fault started`);
    }
    if (o.phase === 'after-recovery' && faultEnd !== null && t + EPSILON_MS < faultEnd) {
      clockReasons.push(`after-recovery observation at ${o.at} precedes the fault end`);
    }
  }
  const timestampsConsistent = phaseOrder && clockReasons.length === 0;
  checks.push({
    name: 'timestamps',
    ok: timestampsConsistent,
    detail: timestampsConsistent
      ? 'observations are phase-ordered and consistent with the fault window'
      : [...(phaseOrder ? [] : ['observations are not in before → during → after order']), ...clockReasons].join('; '),
  });

  checks.push({
    name: 'phase-coverage',
    ok: phaseCoverage,
    detail: phaseCoverage
      ? 'before-fault, during-fault and after-recovery observations are all present'
      : `missing phase(s): ${PHASES.filter((p) => counts[p] === 0).join(', ')}`,
  });

  let recomputedMetrics: RecoveryMetrics;
  try {
    recomputedMetrics = computeRecoveryMetrics({
      observations: evidence.observations,
      faultStartedAt: evidence.faultStartedAt,
      faultEndedAt: evidence.faultEndedAt,
      expectedBlockTimeMs: evidence.metrics.expectedBlockTimeMs,
    });
  } catch {
    recomputedMetrics = {
      recovered: false,
      timeToRecoverMs: null,
      finalityGapBlocks: null,
      blocksMissed: null,
      expectedBlockTimeMs: evidence.metrics.expectedBlockTimeMs,
    };
  }
  const metricsMatch =
    recomputedMetrics.recovered === evidence.metrics.recovered &&
    recomputedMetrics.timeToRecoverMs === evidence.metrics.timeToRecoverMs &&
    recomputedMetrics.finalityGapBlocks === evidence.metrics.finalityGapBlocks &&
    recomputedMetrics.blocksMissed === evidence.metrics.blocksMissed &&
    recomputedMetrics.expectedBlockTimeMs === evidence.metrics.expectedBlockTimeMs;
  checks.push({
    name: 'metrics-recomputation',
    ok: metricsMatch,
    detail: metricsMatch
      ? 'stored metrics equal a fresh recomputation from the observations'
      : `stored metrics differ from recomputation (stored recovered=${evidence.metrics.recovered}, recomputed=${recomputedMetrics.recovered}; stored ttr=${evidence.metrics.timeToRecoverMs}, recomputed=${recomputedMetrics.timeToRecoverMs})`,
  });

  // A drill that never recovered has no time-to-recover by definition (null),
  // and that is a `failed` outcome, not missing evidence. The other two
  // metrics must still be derivable.
  const metricsDerivable =
    recomputedMetrics.finalityGapBlocks !== null &&
    recomputedMetrics.blocksMissed !== null &&
    (!recomputedMetrics.recovered || recomputedMetrics.timeToRecoverMs !== null);
  checks.push({
    name: 'metric-derivability',
    ok: metricsDerivable,
    detail: metricsDerivable
      ? recomputedMetrics.recovered
        ? 'time-to-recover, finality gap and blocks missed are all derivable'
        : 'finality gap and blocks missed are derivable; time-to-recover is null because finality never advanced'
      : 'at least one required metric cannot be derived from the observations',
  });

  const consensus = consensusIntegrity(evidence.consensus ?? null);
  // Absence of consensus context is a capability gap, not an integrity
  // failure of a chain-bound document; present-but-incomplete is reported.
  checks.push({
    name: 'consensus-context',
    ok: !consensus.present || consensus.complete,
    detail: consensus.complete
      ? 'BABE authorship / GRANDPA finality / session-epoch context is complete'
      : consensus.present
        ? `consensus context incomplete: ${consensus.reasons.join('; ')}`
        : 'no consensus context was captured (chain-bound evidence only)',
  });

  const complete = observationsValid && timestampsConsistent && phaseCoverage && metricsDerivable;
  const reasons = checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  return {
    complete,
    metricsMatch,
    timestampsConsistent,
    observationsValid,
    consensus,
    checks,
    reasons,
    recomputedMetrics,
    evidenceHash: sha256Hex(canonicalJson(evidence)),
  };
}

function consensusIntegrity(consensus: ChainConsensusEvidence | null): ConsensusIntegrity {
  if (!consensus) return { present: false, complete: false, reasons: ['consensus evidence absent'] };
  const reasons = [...consensus.incompleteReasons];
  if (consensus.incomplete && reasons.length === 0) reasons.push('consensus evidence is marked incomplete');
  return { present: true, complete: !consensus.incomplete, reasons };
}

export interface DrillAssessment {
  outcome: DrillOutcome;
  reasons: string[];
  integrity: EvidenceIntegrity;
}

/**
 * Classify a drill from its evidence and terminal run state.
 *
 * `failed` is an observed negative outcome; `inconclusive` means the evidence
 * cannot establish either outcome (or contradicts itself). A signature does
 * not upgrade either verdict.
 */
export function assessDrill(evidence: ChainEvidence, runState: string): DrillAssessment {
  const integrity = checkEvidenceIntegrity(evidence);
  const reasons: string[] = [];
  const failedRunStates = new Set(['failed', 'cancelled', 'cleanup-failed']);

  if (!integrity.metricsMatch) {
    reasons.push('evidence metrics do not match a recomputation from the observations');
    return { outcome: 'inconclusive', reasons, integrity };
  }
  if (!integrity.observationsValid || !integrity.timestampsConsistent) {
    reasons.push('evidence observations are malformed or inconsistent');
    return { outcome: 'inconclusive', reasons, integrity };
  }
  if (!integrity.complete) {
    reasons.push(`evidence is incomplete: ${integrity.reasons.join('; ')}`);
    return { outcome: 'inconclusive', reasons, integrity };
  }
  if (failedRunStates.has(runState)) {
    reasons.push(`run finished '${runState}'`);
    return { outcome: 'failed', reasons, integrity };
  }
  if (!evidence.metrics.recovered) {
    reasons.push('finality did not advance past the pre-fault maximum');
    return { outcome: 'failed', reasons, integrity };
  }
  reasons.push('finality advanced past the pre-fault maximum and all metrics are derivable');
  return { outcome: 'passed', reasons, integrity };
}

/**
 * Finality gap used for scoring, excluding observations classified as an
 * expected GRANDPA set transition. When every measured gap is transition-time
 * the signal is 0 (there is no failure to penalise), not the raw maximum.
 * Returns the stored metric when no consensus finality data exists.
 */
export function scoringFinalityGap(evidence: ChainEvidence): number | null {
  const finality = evidence.consensus?.finality;
  if (!finality || finality.length === 0) return evidence.metrics.finalityGapBlocks;
  const nonTransition = finality.filter((f) => f.classification !== 'expected-transition');
  if (nonTransition.length === 0) return 0;
  return nonTransition.reduce((m, f) => Math.max(m, f.lagBlocks), 0);
}
