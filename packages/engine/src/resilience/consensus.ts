/**
 * Consensus-aware attribution for Proof-of-Resilience evidence (T-9.7B).
 *
 * Pure functions only — no I/O, no clocks, no randomness — so the decision
 * logic is unit-tested offline and the capture layer merely supplies observed
 * runtime values.
 *
 * Grounding (Substrate `polkadot-sdk`, read 2026-11-04):
 *  - `sp_consensus_babe::PreDigest` is a SCALE enum with codec indices
 *    1 = Primary, 2 = SecondaryPlain, 3 = SecondaryVRF; every variant encodes
 *    `authority_index: u32` then `slot: u64` (`digests.rs`).
 *  - The secondary-slot rule is
 *    `U256::from_big_endian(blake2_256((epoch_randomness, slot).encode())) % authorities_len`
 *    (`sc-consensus-babe/src/authorship.rs`).
 *
 * Therefore Kaizen never guesses an author from a slot rotation: the authority
 * index comes from the block's own pre-runtime digest, and for secondary slots
 * it is cross-checked with the epoch randomness and the authority set observed
 * at the block. If any of that context is missing or disagrees, the
 * attribution is `inconclusive` and the evidence says why.
 */

import { blake2AsU8a } from '@polkadot/util-crypto';
import { KaizenError } from '../errors';

/** Version of the BABE authorship attribution record. */
export const BABE_AUTHORSHIP_VERSION = 2 as const;

/** Version of the GRANDPA finality observation record. */
export const GRANDPA_FINALITY_VERSION = 2 as const;

/** Default unfinalized-window size treated as a normal finality lag (blocks). */
export const DEFAULT_EXPECTED_FINALITY_LAG_BLOCKS = 5;

/** Window around a GRANDPA set transition where delay is expected (ms). */
export const DEFAULT_TRANSITION_TOLERANCE_MS = 60_000;

export type BabePreDigestKind = 'primary' | 'secondary-plain' | 'secondary-vrf';

export interface BabePreDigest {
  kind: BabePreDigestKind;
  /** Slot from the pre-runtime digest. */
  slot: number;
  /** Authority index from the pre-runtime digest (never derived from a slot). */
  authorityIndex: number;
}

const PRE_DIGEST_KINDS: Record<number, BabePreDigestKind> = {
  1: 'primary',
  2: 'secondary-plain',
  3: 'secondary-vrf',
};

/**
 * Decode the SCALE-encoded BABE pre-runtime digest.
 * Layout: variant byte, authority_index (u32 LE), slot (u64 LE), then the
 * VRF signature for primary/secondary-VRF variants.
 */
export function decodeBabePreDigest(data: Uint8Array | string): BabePreDigest {
  const bytes = typeof data === 'string' ? Uint8Array.from(Buffer.from(strip0x(data), 'hex')) : data;
  if (bytes.length < 13) {
    throw new KaizenError('INVALID_INPUT', `BABE pre-digest is ${bytes.length} bytes; need at least 13`);
  }
  const variant = bytes[0]!;
  const kind = PRE_DIGEST_KINDS[variant];
  if (!kind) {
    throw new KaizenError('INVALID_INPUT', `unknown BABE pre-digest variant ${variant}`);
  }
  const authorityIndex = Buffer.from(bytes.subarray(1, 5)).readUInt32LE(0);
  const slot = Number(Buffer.from(bytes.subarray(5, 13)).readBigUInt64LE(0));
  if (!Number.isSafeInteger(slot)) {
    throw new KaizenError('INVALID_INPUT', 'BABE slot is outside the safe integer range');
  }
  const needsSignature = kind !== 'secondary-plain';
  if (needsSignature && bytes.length < 13 + 96) {
    throw new KaizenError('INVALID_INPUT', `BABE ${kind} pre-digest is missing its VRF signature`);
  }
  return { kind, slot, authorityIndex };
}

export interface BabeAuthority {
  /** Authority index within the set (0-based, ordered as published). */
  index: number;
  /** Raw consensus key bytes as hex (sr25519 BABE key). */
  key: string;
  /** Resolved validator account id (SS58) for this authority, when mapped. */
  validatorId: string | null;
  /** Authority weight as a decimal string, when published. */
  weight: string | null;
}

/** Epoch context an authority set answers for. */
export interface BabeEpochContext {
  epoch: number | null;
  /** First slot of the epoch (BABE `EpochStart`), when readable. */
  startSlot: number | null;
  /** Epoch duration in slots (`babe.epochDuration`), when readable. */
  durationSlots: number | null;
  /** Epoch randomness, 0x-prefixed 32 bytes, when readable. */
  randomness: string | null;
}

export interface BabeAuthoritySet extends BabeEpochContext {
  /** Stable identifier derived from epoch + authority keys. */
  authoritySetId: string;
  /** Ordered authorities; null when the read failed. */
  authorities: BabeAuthority[] | null;
}

export type BabeAttributionOutcome = 'authored' | 'inconclusive';

export interface BabeAuthorship {
  blockNumber: number;
  blockHash: string;
  slot: number;
  kind: BabePreDigestKind;
  authorityIndex: number | null;
  authoritySetId: string | null;
  /** Raw BABE key of the authority that authored the block, when resolved. */
  authorityKey: string | null;
  /** Validator account for that authority, when the key mapping is known. */
  validatorId: string | null;
  epoch: number | null;
  sessionId: number | null;
  outcome: BabeAttributionOutcome;
  /**
   * `digest`: authority index came from the block header alone.
   * `digest+secondary-rule`: digest index agreed with the epoch-randomness
   * rule (secondary slots).
   * `none`: no usable observation.
   */
  verification: 'digest' | 'digest+secondary-rule' | 'none';
  /** Human-readable notes; fatal notes make the outcome inconclusive. */
  reasons: string[];
}

/**
 * The exact secondary-slot authority index from Substrate:
 * big-endian U256 of blake2_256(randomness ++ slot_le_u64), modulo the
 * authority count.
 */
export function babeSecondaryAuthorIndex(randomness: string, slot: number, authoritiesLen: number): number {
  if (!Number.isInteger(authoritiesLen) || authoritiesLen <= 0) {
    throw new KaizenError('INVALID_INPUT', 'authoritiesLen must be a positive integer');
  }
  if (!Number.isSafeInteger(slot) || slot < 0) {
    throw new KaizenError('INVALID_INPUT', 'slot must be a non-negative safe integer');
  }
  const raw = Buffer.from(strip0x(randomness), 'hex');
  if (raw.length !== 32) {
    throw new KaizenError('INVALID_INPUT', 'epoch randomness must be 32 bytes');
  }
  const slotBytes = Buffer.alloc(8);
  slotBytes.writeBigUInt64LE(BigInt(slot));
  const hash = blake2AsU8a(Buffer.concat([raw, slotBytes]), 256);
  const big = BigInt(`0x${Buffer.from(hash).toString('hex')}`);
  return Number(big % BigInt(authoritiesLen));
}

export interface AttributeBabeInput {
  /** The block being attributed (number + hash). */
  block: { number: number; hash: string };
  /** Authority set read in the state of the block being attributed. */
  authoritySet: BabeAuthoritySet;
  /** Pre-runtime digest decoded from that block's header. */
  digest: BabePreDigest;
  sessionId?: number | null;
  /** Validator account for an authority key, when known. */
  validatorIdForKey?: (key: string) => string | null;
}

/**
 * Attribute one block to a BABE validator.
 *
 * Fatal conditions (outcome `inconclusive`) are deliberately conservative:
 * missing authority set, an authority index outside the set, a slot outside
 * the recorded epoch bounds, or a secondary-slot rule that disagrees with the
 * digest. Each implies the block was authored by a set Kaizen did not observe
 * — exactly the case where attributing a failure would be wrong.
 */
export function attributeBabeAuthorship(input: AttributeBabeInput): BabeAuthorship {
  const { digest, authoritySet } = input;
  const reasons: string[] = [];
  const base: BabeAuthorship = {
    blockNumber: input.block.number,
    blockHash: input.block.hash,
    slot: digest.slot,
    kind: digest.kind,
    authorityIndex: digest.authorityIndex,
    authoritySetId: authoritySet.authoritySetId,
    authorityKey: null,
    validatorId: null,
    epoch: authoritySet.epoch,
    sessionId: input.sessionId ?? null,
    outcome: 'inconclusive',
    verification: 'none',
    reasons,
  };
  const authorities = authoritySet.authorities;
  if (!authorities || authorities.length === 0) {
    reasons.push('BABE authority set for the block was not readable');
    return base;
  }
  if (digest.authorityIndex >= authorities.length) {
    reasons.push(
      `authority index ${digest.authorityIndex} is outside the ${authorities.length}-authority set: the block belongs to a different epoch authority set`,
    );
    return base;
  }
  let fatal = false;

  if (authoritySet.startSlot !== null && authoritySet.durationSlots !== null) {
    const end = authoritySet.startSlot + authoritySet.durationSlots;
    if (digest.slot < authoritySet.startSlot || digest.slot >= end) {
      reasons.push(
        `slot ${digest.slot} is outside epoch ${authoritySet.epoch ?? '?'} bounds [${authoritySet.startSlot}, ${end}): the epoch authority set does not match the block`,
      );
      fatal = true;
    }
  } else {
    reasons.push('epoch start slot / duration unavailable: slot membership in the observed epoch was not checked');
  }

  if (digest.kind === 'primary') {
    base.verification = 'digest';
  } else if (authoritySet.randomness === null) {
    reasons.push('epoch randomness unavailable: the secondary-slot rule could not be cross-checked');
    base.verification = 'digest';
  } else {
    const expected = babeSecondaryAuthorIndex(authoritySet.randomness, digest.slot, authorities.length);
    if (expected !== digest.authorityIndex) {
      reasons.push(
        `secondary-slot rule computes authority ${expected} but the digest records ${digest.authorityIndex}: the observed authority set is not the block's epoch set`,
      );
      fatal = true;
    } else {
      base.verification = 'digest+secondary-rule';
    }
  }

  if (fatal) {
    // The observed set is not the block's epoch set: naming an author from it
    // would be exactly the misattribution this check exists to prevent.
    reasons.push('the authority resolved from the observed set is not trustworthy for this block');
    return base;
  }

  const authority = authorities[digest.authorityIndex];
  if (!authority) {
    reasons.push(`authority ${digest.authorityIndex} is absent from the observed set`);
    return base;
  }
  base.authorityKey = authority.key;
  base.validatorId = authority.validatorId ?? input.validatorIdForKey?.(authority.key) ?? null;
  if (base.validatorId === null) {
    reasons.push(`authority key ${authority.key} is not mapped to a validator account in the observed session keys`);
  }
  if (!fatal) {
    base.outcome = 'authored';
  }
  return base;
}

// ---------------------------------------------------------------------------
// GRANDPA finality

export type FinalityClassification = 'normal' | 'expected-transition' | 'stalled' | 'unknown';

export interface GrandpaFinalityObservation {
  blockNumber: number;
  blockHash: string;
  finalized: boolean;
  finalizedNumber: number;
  finalizedHash: string;
  /** GRANDPA authority-set id at the observation, when readable. */
  setId: number | null;
  epoch: number | null;
  authorityCount: number | null;
  /** best − finalized, in blocks (never negative). */
  lagBlocks: number;
  classification: FinalityClassification;
  reasons: string[];
  /** ISO-8601 time the observation completed. */
  at: string;
}

/**
 * A GRANDPA authority-set change observed between two readings. `fromSetId`
 * is null when the previous set id was never established (the transition is
 * then recorded but flagged as unverifiable history).
 */
export interface GrandpaSetTransition {
  fromSetId: number | null;
  toSetId: number;
  epoch: number | null;
  /** Finalized block at the moment the new set was observed. */
  finalizedBlock: number;
  at: string;
}

export interface ClassifyFinalityInput {
  observation: {
    blockNumber: number;
    finalizedNumber: number;
    setId: number | null;
    at: string;
  };
  transitions: readonly GrandpaSetTransition[];
  /** Set id observed immediately before this observation, when known. */
  previousSetId?: number | null;
  stallThresholdBlocks?: number;
  transitionToleranceMs?: number;
  /** Transition window in blocks on either side of the finalized head. */
  transitionToleranceBlocks?: number;
}

/**
 * Classify a finality lag without blaming a validator for protocol behaviour.
 *
 * A lag above `stallThresholdBlocks` is `expected-transition` when the
 * observation is at/around a recorded set change or when a transition's
 * finalized point lies inside the current unfinalized window. Without a
 * readable set id the classification is `unknown` — never `stalled`.
 */
export function classifyFinalityGap(input: ClassifyFinalityInput): {
  classification: FinalityClassification;
  lagBlocks: number;
  reasons: string[];
} {
  const { observation } = input;
  const reasons: string[] = [];
  const lagBlocks = Math.max(0, observation.blockNumber - observation.finalizedNumber);
  const stall = input.stallThresholdBlocks ?? DEFAULT_EXPECTED_FINALITY_LAG_BLOCKS;
  const toleranceMs = input.transitionToleranceMs ?? DEFAULT_TRANSITION_TOLERANCE_MS;
  const toleranceBlocks = input.transitionToleranceBlocks ?? stall;

  if (observation.setId === null) {
    reasons.push('GRANDPA set id unavailable at the observation: a finality delay cannot be attributed to a set');
    return { classification: 'unknown', lagBlocks, reasons };
  }
  if (lagBlocks <= stall) {
    if (input.previousSetId != null && input.previousSetId !== observation.setId) {
      reasons.push(`set id changed ${input.previousSetId} → ${observation.setId}; lag ${lagBlocks} is within the normal window`);
    }
    return { classification: 'normal', lagBlocks, reasons };
  }

  // The observation itself spans a set change: the previous reading had a
  // different set id. That is a transition even if the record was not built.
  if (input.previousSetId != null && input.previousSetId !== observation.setId) {
    reasons.push(
      `finality lag ${lagBlocks} blocks spans a GRANDPA set change (${input.previousSetId} → ${observation.setId}); delay during a set change is protocol behaviour, not a validator failure`,
    );
    return { classification: 'expected-transition', lagBlocks, reasons };
  }

  const at = Date.parse(observation.at);
  const nearTransition = input.transitions.some((t) => {
    if (t.toSetId === observation.setId && input.previousSetId != null && input.previousSetId !== t.toSetId) {
      return true;
    }
    if (t.toSetId === observation.setId && input.previousSetId == null && t.fromSetId !== null) {
      return true;
    }
    if (t.finalizedBlock >= observation.finalizedNumber - toleranceBlocks && t.finalizedBlock <= observation.blockNumber) {
      return true;
    }
    const tAt = Date.parse(t.at);
    return !Number.isNaN(at) && !Number.isNaN(tAt) && Math.abs(tAt - at) <= toleranceMs;
  });
  if (nearTransition) {
    reasons.push(
      `finality lag ${lagBlocks} blocks coincides with a GRANDPA authority-set transition; delay during a set change is protocol behaviour, not a validator failure`,
    );
    return { classification: 'expected-transition', lagBlocks, reasons };
  }
  reasons.push(`finality lag ${lagBlocks} blocks exceeds the ${stall}-block threshold with no recorded set transition`);
  return { classification: 'stalled', lagBlocks, reasons };
}

/**
 * Re-classify every finality observation against the run's full transition
 * history. The capture layer cannot know future transitions, so this is the
 * authoritative classification stored in the evidence.
 */
export function classifyFinalityObservations(
  observations: readonly GrandpaFinalityObservation[],
  transitions: readonly GrandpaSetTransition[],
  options: { stallThresholdBlocks?: number; transitionToleranceMs?: number; transitionToleranceBlocks?: number } = {},
): GrandpaFinalityObservation[] {
  const out: GrandpaFinalityObservation[] = [];
  let previousSetId: number | null = null;
  for (const o of observations) {
    const c = classifyFinalityGap({
      observation: { blockNumber: o.blockNumber, finalizedNumber: o.finalizedNumber, setId: o.setId, at: o.at },
      transitions,
      previousSetId,
      ...options,
    });
    out.push({ ...o, lagBlocks: c.lagBlocks, classification: c.classification, reasons: c.reasons });
    if (o.setId !== null) previousSetId = o.setId;
  }
  return out;
}

/** Validate that recorded set-id transitions are strictly increasing. */
export function checkGrandpaTransitionHistory(transitions: readonly GrandpaSetTransition[]): string[] {
  const reasons: string[] = [];
  const seen = new Set<number>();
  let last: number | null = null;
  for (const t of transitions) {
    if (seen.has(t.toSetId)) reasons.push(`GRANDPA set id ${t.toSetId} was recorded more than once`);
    seen.add(t.toSetId);
    if (t.fromSetId === null) {
      reasons.push(`GRANDPA set ${t.toSetId} has no established previous set id (transition history incomplete)`);
    } else if (t.toSetId <= t.fromSetId) {
      reasons.push(`GRANDPA set id did not increase (${t.fromSetId} → ${t.toSetId})`);
    }
    if (last !== null && t.toSetId < last) {
      reasons.push(`GRANDPA set ids are out of order (${last} then ${t.toSetId})`);
    }
    last = t.toSetId;
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// Assembled evidence

/** Era / session / set context attached to a consensus observation. */
export interface ConsensusContext {
  eraId: number | null;
  sessionId: number | null;
  babeEpoch: number | null;
  babeAuthoritySetId: string | null;
  grandpaSetId: number | null;
  validatorCount: number | null;
  /**
   * Era points (staking era reward points) are staking context only: they are
   * never used to decide BABE authorship. Null when staking is unavailable or
   * the era is too old to read.
   */
  eraPoints: { total: number; byValidator: Array<{ validatorId: string; points: number }> } | null;
  /** Session/epoch/set transitions observed during capture (informational). */
  transitionsObserved: string[];
}

export interface BabeEpochTransition {
  fromEpoch: number | null;
  toEpoch: number;
  atBlock: number;
  at: string;
}

export interface ChainConsensusEvidence {
  consensusVersion: 2;
  babeAuthorshipVersion: typeof BABE_AUTHORSHIP_VERSION;
  finalityVersion: typeof GRANDPA_FINALITY_VERSION;
  authorings: readonly BabeAuthorship[];
  /** Authority sets used for attribution, so authorship can be re-checked. */
  authoritySets: readonly BabeAuthoritySet[];
  finality: readonly GrandpaFinalityObservation[];
  grandpaTransitions: readonly GrandpaSetTransition[];
  babeEpochTransitions: readonly BabeEpochTransition[];
  context: ConsensusContext | null;
  /** True when some part of the consensus context could not be established. */
  incomplete: boolean;
  incompleteReasons: string[];
}

export interface BuildConsensusEvidenceInput {
  authorings: readonly BabeAuthorship[];
  authoritySets?: readonly BabeAuthoritySet[];
  finality: readonly GrandpaFinalityObservation[];
  transitions: readonly GrandpaSetTransition[];
  babeEpochTransitions?: readonly BabeEpochTransition[];
  context: ConsensusContext | null;
  /**
   * True when a consensus read failed while capturing; the evidence is then
   * marked incomplete rather than silently optimistic.
   */
  captureFailed?: boolean;
}

export function buildConsensusEvidence(input: BuildConsensusEvidenceInput): ChainConsensusEvidence {
  const authorings = [...input.authorings];
  const finality = [...input.finality];
  const transitions = [...input.transitions];
  const authoritySets = dedupeSets(input.authoritySets ?? []);
  const reasons: string[] = [];

  if (input.captureFailed === true) reasons.push('at least one consensus read failed during capture');
  if (authorings.length === 0) reasons.push('no BABE authorship observation was captured');
  if (finality.length === 0) reasons.push('no GRANDPA finality observation was captured');
  if (input.context === null) reasons.push('session / era / authority-set context was not captured');
  else {
    if (input.context.validatorCount === null) reasons.push('validator count was not readable');
    if (input.context.sessionId === null) reasons.push('session index was not readable');
  }
  for (const a of authorings) {
    if (a.outcome === 'inconclusive') {
      reasons.push(`block #${a.blockNumber}: BABE authorship inconclusive (${a.reasons.join('; ') || 'no reason recorded'})`);
    } else if (a.validatorId === null) {
      reasons.push(`block #${a.blockNumber}: authority ${a.authorityKey ?? '?'} was not mapped to a validator account`);
    }
  }
  for (const f of finality) {
    if (f.setId === null) reasons.push(`finality observation at #${f.blockNumber}: GRANDPA set id unavailable`);
    if (f.classification === 'unknown') {
      reasons.push(`finality observation at #${f.blockNumber}: delay classification inconclusive`);
    }
  }
  for (const s of authoritySets) {
    if (s.authorities === null) reasons.push(`BABE authority set ${s.authoritySetId} has no authority list`);
  }
  reasons.push(...checkGrandpaTransitionHistory(transitions));

  return {
    consensusVersion: 2,
    babeAuthorshipVersion: BABE_AUTHORSHIP_VERSION,
    finalityVersion: GRANDPA_FINALITY_VERSION,
    authorings,
    authoritySets,
    finality,
    grandpaTransitions: transitions,
    babeEpochTransitions: [...(input.babeEpochTransitions ?? [])],
    context: input.context,
    incomplete: reasons.length > 0,
    incompleteReasons: dedupeStrings(reasons),
  };
}

/** Derive epoch transitions from the ordered authority sets we observed. */
export function epochTransitionsFrom(
  sets: readonly BabeAuthoritySet[],
  blockOf: (setId: string) => { blockNumber: number; at: string } | null,
): BabeEpochTransition[] {
  const out: BabeEpochTransition[] = [];
  let previous: BabeAuthoritySet | null = null;
  for (const s of sets) {
    if (previous && s.epoch !== null && s.epoch !== previous.epoch) {
      const where = blockOf(s.authoritySetId);
      out.push({
        fromEpoch: previous.epoch,
        toEpoch: s.epoch,
        atBlock: where?.blockNumber ?? 0,
        at: where?.at ?? '',
      });
    }
    previous = s;
  }
  return out;
}

function dedupeSets(sets: readonly BabeAuthoritySet[]): BabeAuthoritySet[] {
  const map = new Map<string, BabeAuthoritySet>();
  for (const s of sets) if (!map.has(s.authoritySetId)) map.set(s.authoritySetId, s);
  return [...map.values()];
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}
