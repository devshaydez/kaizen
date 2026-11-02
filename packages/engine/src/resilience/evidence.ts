/**
 * Chain-bound run evidence (Proof-of-Resilience, T-9.1).
 *
 * A certified run binds the Failure Lab run record to the CHAIN it ran
 * against: the best and finalized heads (number + hash) observed by a
 * reference node before the fault, while it was active, and after recovery,
 * plus recovery metrics derived ONLY from those observations.
 *
 * Rules (DEC-009 / DEC-029):
 *  - every observation is a real RPC read; a failed read is recorded as a
 *    gap with its reason, never filled in
 *  - metrics are a pure function of the observations and the fault window
 *    (`computeRecoveryMetrics`), so anyone holding the evidence can
 *    recompute them; a metric that cannot be derived is `null`
 *  - recovery is declared only when FINALITY advances past the highest
 *    finalized block seen before/during the fault (a producing-but-not-
 *    finalizing chain has not recovered)
 */

import { KaizenError } from "../errors";

export const CHAIN_EVIDENCE_VERSION = 1 as const;

export const CHAIN_EVIDENCE_PHASES = [
  "before-fault",
  "during-fault",
  "after-recovery",
] as const;
export type ChainEvidencePhase = (typeof CHAIN_EVIDENCE_PHASES)[number];

/** Default slot duration used to derive `blocksMissed` (Portaldot: 6 s). */
export const DEFAULT_EXPECTED_BLOCK_TIME_MS = 6_000;

export interface BlockRef {
  number: number;
  /** 0x-prefixed 32-byte block hash as returned by the node. */
  hash: string;
  author?: { kind: string; authorityIndex: number; slot: string; authorityId?: string };
  /** GRANDPA context queried at this exact block hash. */
  grandpaSetId?: string;
  grandpaAuthoritiesHash?: string;
}

export interface ChainObservation {
  phase: ChainEvidencePhase;
  /** ISO-8601 time the read completed. */
  at: string;
  best: BlockRef;
  finalized: BlockRef;
  /** GRANDPA context at each head, from state at its exact hash. */
  bestGrandpaSetId?: string;
  bestGrandpaAuthoritiesHash?: string;
  finalizedGrandpaSetId?: string;
  finalizedGrandpaAuthoritiesHash?: string;
}

export interface ChainEvidenceGap {
  phase: ChainEvidencePhase;
  at: string;
  reason: string;
}

export interface RecoveryMetrics {
  /** True when finality advanced past the pre/during-fault maximum. */
  recovered: boolean;
  /** ms from fault end (or start, if no end recorded) to the first recovered observation. */
  timeToRecoverMs: number | null;
  /** Max (best − finalized) observed during the fault and recovery. */
  finalityGapBlocks: number | null;
  /** Expected slots in the fault window minus blocks actually produced (≥ 0). */
  blocksMissed: number | null;
  /** Slot duration the `blocksMissed` derivation assumed. */
  expectedBlockTimeMs: number;
}

export interface ChainEvidence {
  version: typeof CHAIN_EVIDENCE_VERSION;
  networkId: string;
  /** Validator (fault target) the evidence is about. */
  validatorId: string;
  /** Node whose RPC produced the observations (the reference observer). */
  observerNodeId: string;
  genesisHash: string | null;
  faultStartedAt: string | null;
  faultEndedAt: string | null;
  recoveredAt: string | null;
  observations: ChainObservation[];
  gaps: ChainEvidenceGap[];
  metrics: RecoveryMetrics;
}

const HASH_RE = /^0x[0-9a-f]{64}$/;

export function isBlockRef(value: unknown): value is BlockRef {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.number === "number" &&
    Number.isInteger(v.number) &&
    v.number >= 0 &&
    typeof v.hash === "string" &&
    HASH_RE.test(v.hash)
  );
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t))
    throw new KaizenError("INVALID_INPUT", `invalid timestamp: ${iso}`);
  return t;
}

/**
 * Pure metric derivation. See docs/RESILIENCE_SCORE.md §2 for the exact
 * definitions; unit-tested in resilience-evidence.test.ts.
 */
export function computeRecoveryMetrics(input: {
  observations: readonly ChainObservation[];
  faultStartedAt: string | null;
  faultEndedAt: string | null;
  expectedBlockTimeMs?: number;
}): RecoveryMetrics & { recoveredAt: string | null } {
  const blockTime = input.expectedBlockTimeMs ?? DEFAULT_EXPECTED_BLOCK_TIME_MS;
  if (!Number.isFinite(blockTime) || blockTime <= 0) {
    throw new KaizenError(
      "INVALID_INPUT",
      "expectedBlockTimeMs must be a positive number",
    );
  }
  const obs = [...input.observations].sort((a, b) => ms(a.at) - ms(b.at));
  const pre = obs.filter((o) => o.phase === "before-fault");
  const during = obs.filter((o) => o.phase === "during-fault");
  const after = obs.filter((o) => o.phase === "after-recovery");

  // Recovery: first after-recovery observation whose finalized number is
  // strictly above every finalized number seen before/during the fault.
  const baseline = [...pre, ...during].reduce(
    (m, o) => Math.max(m, o.finalized.number),
    -1,
  );
  const recoveredObs =
    baseline >= 0
      ? after.find((o) => o.finalized.number > baseline)
      : undefined;
  const recoveredAt = recoveredObs?.at ?? null;
  const anchor = input.faultEndedAt ?? input.faultStartedAt;
  const timeToRecoverMs =
    recoveredAt !== null && anchor !== null
      ? Math.max(0, ms(recoveredAt) - ms(anchor))
      : null;

  const gapSamples = [...during, ...after].filter((o) => {
    const bestSet = o.bestGrandpaSetId;
    const finSet = o.finalizedGrandpaSetId;
    if (bestSet === undefined && finSet === undefined) return true;
    return bestSet === finSet &&
      o.bestGrandpaAuthoritiesHash === o.finalizedGrandpaAuthoritiesHash;
  });
  const finalityGapBlocks = gapSamples.length
    ? gapSamples.reduce(
        (m, o) => Math.max(m, o.best.number - o.finalized.number),
        0,
      )
    : null;

  // Blocks missed over the fault window: last pre-fault observation → last
  // during-fault observation (taken just before the fault is lifted).
  const start = pre[pre.length - 1];
  const end = during[during.length - 1];
  let blocksMissed: number | null = null;
  if (start && end) {
    const elapsed = ms(end.at) - ms(start.at);
    const expected = Math.floor(Math.max(0, elapsed) / blockTime);
    const produced = Math.max(0, end.best.number - start.best.number);
    blocksMissed = Math.max(0, expected - produced);
  }

  return {
    recovered: recoveredObs !== undefined,
    timeToRecoverMs,
    finalityGapBlocks,
    blocksMissed,
    expectedBlockTimeMs: blockTime,
    recoveredAt,
  };
}

// ---------------------------------------------------------------------------
// Recorder

/** One read of a node's heads. Throws when the node is unreachable. */
export interface HeadReader {
  readHeads(): Promise<{
    best: BlockRef;
    finalized: BlockRef;
    genesisHash: string | null;
  }>;
}

export interface ChainEvidenceRecorderOptions {
  networkId: string;
  validatorId: string;
  observerNodeId: string;
  reader: HeadReader;
  expectedBlockTimeMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Collects observations around a fault. Usage:
 *   await rec.observe('before-fault'); rec.markFaultStarted();
 *   await rec.observe('during-fault'); rec.markFaultEnded();
 *   await rec.awaitRecovery({ timeoutMs }); const evidence = rec.finish();
 */
export class ChainEvidenceRecorder {
  private readonly observations: ChainObservation[] = [];
  private readonly gaps: ChainEvidenceGap[] = [];
  private genesisHash: string | null = null;
  private faultStartedAt: string | null = null;
  private faultEndedAt: string | null = null;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ChainEvidenceRecorderOptions) {
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((t) => new Promise((r) => setTimeout(r, t)));
  }

  /** Read the heads once; a failed read becomes a gap (returns null). */
  async observe(phase: ChainEvidencePhase): Promise<ChainObservation | null> {
    try {
      const { best, finalized, genesisHash } =
        await this.opts.reader.readHeads();
      if (!isBlockRef(best) || !isBlockRef(finalized)) {
        throw new Error("node returned a malformed header");
      }
      if (genesisHash !== null) {
        if (this.genesisHash !== null && this.genesisHash !== genesisHash) {
          throw new Error("genesis hash changed between observations");
        }
        this.genesisHash = genesisHash;
      }
      const o: ChainObservation = {
        phase,
        at: this.now().toISOString(),
        best,
        finalized,
        ...(best.grandpaSetId !== undefined ? { bestGrandpaSetId: best.grandpaSetId } : {}),
        ...(best.grandpaAuthoritiesHash !== undefined ? { bestGrandpaAuthoritiesHash: best.grandpaAuthoritiesHash } : {}),
        ...(finalized.grandpaSetId !== undefined ? { finalizedGrandpaSetId: finalized.grandpaSetId } : {}),
        ...(finalized.grandpaAuthoritiesHash !== undefined ? { finalizedGrandpaAuthoritiesHash: finalized.grandpaAuthoritiesHash } : {}),
      };
      this.observations.push(o);
      return o;
    } catch (e) {
      this.gaps.push({
        phase,
        at: this.now().toISOString(),
        reason: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }

  markFaultStarted(at: Date = this.now()): void {
    this.faultStartedAt = at.toISOString();
  }

  markFaultEnded(at: Date = this.now()): void {
    this.faultEndedAt = at.toISOString();
  }

  /**
   * Poll 'after-recovery' observations until finality advances past the
   * pre/during-fault maximum or the timeout elapses. Returns whether it did.
   */
  async awaitRecovery(options: {
    timeoutMs: number;
    intervalMs?: number;
  }): Promise<boolean> {
    const interval = options.intervalMs ?? 2_000;
    const deadline = this.now().getTime() + options.timeoutMs;
    for (;;) {
      await this.observe("after-recovery");
      if (this.metrics().recovered) return true;
      if (this.now().getTime() + interval > deadline) return false;
      await this.sleep(interval);
    }
  }

  private metrics(): RecoveryMetrics & { recoveredAt: string | null } {
    return computeRecoveryMetrics({
      observations: this.observations,
      faultStartedAt: this.faultStartedAt,
      faultEndedAt: this.faultEndedAt,
      expectedBlockTimeMs: this.opts.expectedBlockTimeMs,
    });
  }

  finish(): ChainEvidence {
    const { recoveredAt, ...metrics } = this.metrics();
    return {
      version: CHAIN_EVIDENCE_VERSION,
      networkId: this.opts.networkId,
      validatorId: this.opts.validatorId,
      observerNodeId: this.opts.observerNodeId,
      genesisHash: this.genesisHash,
      faultStartedAt: this.faultStartedAt,
      faultEndedAt: this.faultEndedAt,
      recoveredAt,
      observations: [...this.observations],
      gaps: [...this.gaps],
      metrics,
    };
  }
}
