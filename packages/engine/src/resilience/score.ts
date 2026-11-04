/**
 * Resilience score v2 (T-9.7C) — a pure, deterministic 0–100 score for one
 * validator from its certified runs. The normative definition is
 * docs/RESILIENCE_SCORE.md; this file implements it and
 * resilience-score.test.ts pins the worked examples.
 *
 * v2 changes (v1 scores remain recomputable from v1 inputs):
 *  - a metric that could not be derived is *missing*, not "worst": the
 *    quality average renormalises over the metrics that were measured and
 *    reports `coverage`;
 *  - confidence = volume/freshness term × coverage, so missing measurements
 *    reduce confidence rather than pretending the worst outcome happened;
 *  - `evidenceOutcome: 'inconclusive'` is never counted as survived;
 *  - the caller supplies a finality gap that already excludes expected
 *    GRANDPA set transitions (`scoringFinalityGap`), so protocol behaviour is
 *    not penalised.
 *
 * Per run i:
 *   survived_i = recovered AND state ∈ {completed, completed-with-warnings}
 *                AND evidenceOutcome ≠ inconclusive
 *   components = available metrics among
 *     R = 1 / (1 + ttr_ms / 60 000)
 *     F = 1 / (1 + gap_blocks / 10)
 *     M = 1 / (1 + missed_blocks / 10)
 *   q_i = survived_i ? Σ(weight·value) / Σ(weight) over available metrics : 0
 *   c_i = Σ(weight) over available metrics / Σ(all weights)
 *   w_i = 0.5 ^ (age_days_i / 30)        (recency decay, 30-day half-life)
 * Aggregate:
 *   quality    = Σ w_i·q_i / Σ w_i
 *   confidence = (1 − e^(−Σ w_i / 2)) × coverage
 *   coverage   = Σ w_i·c_i / Σ w_i
 *   score      = round(100 · quality · confidence), clamped to [0, 100]
 */

import { KaizenError } from '../errors';
import type { DrillOutcome } from './integrity';

export const RESILIENCE_SCORE_VERSION = 2 as const;

export const RESILIENCE_SCORE_PARAMS = {
  recoveryRefMs: 60_000,
  finalityGapRefBlocks: 10,
  blocksMissedRefBlocks: 10,
  weights: { recovery: 0.5, finality: 0.3, liveness: 0.2 },
  halfLifeDays: 30,
  confidenceScale: 2,
} as const;

export interface ScoredRunInput {
  runId: string;
  /** Terminal run state of the certified run. */
  runState: string;
  recovered: boolean;
  timeToRecoverMs: number | null;
  finalityGapBlocks: number | null;
  blocksMissed: number | null;
  /** When the evidence was certified (ISO-8601). */
  certifiedAt: string;
  /** Recomputed drill outcome; `inconclusive` never counts as survived. */
  evidenceOutcome?: DrillOutcome;
  /** Consensus context complete (reported; v2 does not reweight by class). */
  consensusComplete?: boolean;
}

export interface ScoredRun {
  runId: string;
  survived: boolean;
  quality: number;
  weight: number;
  ageDays: number;
  /** Fraction of the metric weight that was measured (0–1). */
  coverage: number;
  /** False when the certificate's evidence is inconclusive. */
  eligible: boolean;
}

export interface ResilienceScore {
  version: typeof RESILIENCE_SCORE_VERSION;
  validatorId: string;
  score: number;
  quality: number;
  confidence: number;
  /** Weighted metric coverage across runs (0–1). */
  coverage: number;
  effectiveRuns: number;
  runs: number;
  faultsSurvived: number;
  latestCertifiedAt: string | null;
  asOf: string;
  perRun: ScoredRun[];
}

const SURVIVING_STATES = new Set(['completed', 'completed-with-warnings']);
const DAY_MS = 86_400_000;

function inverse(value: number | null, ref: number): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return 1 / (1 + value / ref);
}

export function scoreRun(run: ScoredRunInput, asOf: Date): ScoredRun {
  const p = RESILIENCE_SCORE_PARAMS;
  const t = Date.parse(run.certifiedAt);
  if (Number.isNaN(t)) throw new KaizenError('INVALID_INPUT', `invalid certifiedAt for run ${run.runId}`);
  const ageDays = Math.max(0, (asOf.getTime() - t) / DAY_MS);
  const eligible = run.evidenceOutcome !== 'inconclusive';
  const survived =
    eligible && run.evidenceOutcome !== 'failed' && run.recovered && SURVIVING_STATES.has(run.runState);

  const components: Array<{ weight: number; value: number | null }> = [
    { weight: p.weights.recovery, value: inverse(run.timeToRecoverMs, p.recoveryRefMs) },
    { weight: p.weights.finality, value: inverse(run.finalityGapBlocks, p.finalityGapRefBlocks) },
    { weight: p.weights.liveness, value: inverse(run.blocksMissed, p.blocksMissedRefBlocks) },
  ];
  const available = components.filter((c): c is { weight: number; value: number } => c.value !== null);
  const totalWeight = components.reduce((s, c) => s + c.weight, 0);
  const availableWeight = available.reduce((s, c) => s + c.weight, 0);
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0;
  const quality = survived && availableWeight > 0 ? available.reduce((s, c) => s + c.weight * c.value, 0) / availableWeight : 0;

  return {
    runId: run.runId,
    survived,
    quality,
    weight: Math.pow(0.5, ageDays / p.halfLifeDays),
    ageDays,
    coverage,
    eligible,
  };
}

export function computeResilienceScore(
  validatorId: string,
  runs: readonly ScoredRunInput[],
  asOf: Date = new Date(),
): ResilienceScore {
  const perRun = runs.map((r) => scoreRun(r, asOf));
  const weightSum = perRun.reduce((s, r) => s + r.weight, 0);
  const quality = weightSum > 0 ? perRun.reduce((s, r) => s + r.weight * r.quality, 0) / weightSum : 0;
  const coverage = weightSum > 0 ? perRun.reduce((s, r) => s + r.weight * r.coverage, 0) / weightSum : 0;
  const confidence = (1 - Math.exp(-weightSum / RESILIENCE_SCORE_PARAMS.confidenceScale)) * coverage;
  const score = Math.min(100, Math.max(0, Math.round(100 * quality * confidence)));
  const latest = runs.reduce<string | null>(
    (m, r) => (m === null || Date.parse(r.certifiedAt) > Date.parse(m) ? r.certifiedAt : m),
    null,
  );
  return {
    version: RESILIENCE_SCORE_VERSION,
    validatorId,
    score,
    quality,
    confidence,
    coverage,
    effectiveRuns: weightSum,
    runs: runs.length,
    faultsSurvived: perRun.filter((r) => r.survived).length,
    latestCertifiedAt: latest,
    asOf: asOf.toISOString(),
    perRun,
  };
}
