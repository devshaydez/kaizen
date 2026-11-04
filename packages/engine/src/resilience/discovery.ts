/**
 * Read-only validator & consensus discovery for Portaldot (T-9.7B).
 *
 * Queries only public runtime state, in the priority order given by the
 * Portaldot team:
 *   session.validators, session.queuedKeys, session.nextKeys,
 *   session.currentIndex, babe.authorities, grandpa.authorities
 * plus epoch context (`babe.epochIndex`, `babe.epochStart`,
 * `babe.epochDuration`, `babe.randomness`), the GRANDPA set id, and staking
 * era context (`staking.activeEra`, `staking.erasRewardPoints`).
 *
 * Design rules:
 *  - no hardcoded validator list and no current-state substitution for
 *    historical state: a historical block is always read at that block's
 *    hash, and `unknown` is reported when the node cannot answer;
 *  - all reads are cached per block hash, and a no-argument snapshot reuses
 *    the cached snapshot while the best block has not moved, so monitoring
 *    stays at roughly one snapshot per block;
 *  - a failed or malformed query degrades that field to null and records it
 *    in `unavailable` — it never throws a fabricated value or crashes the
 *    capture;
 *  - era data is staking context only. It is never used to decide BABE
 *    authorship.
 *
 * The runtime is an injected facade so unit tests run offline against
 * scripted responses; `createPolkadotConsensusRuntime` is the real
 * `@polkadot/api` implementation.
 */

import { createHash } from 'node:crypto';
import {
  attributeBabeAuthorship,
  classifyFinalityGap,
  type BabeAuthority,
  type BabeAuthoritySet,
  type BabeAuthorship,
  type BabeEpochContext,
  type BabePreDigest,
  type ConsensusContext,
  type GrandpaFinalityObservation,
  type GrandpaSetTransition,
} from './consensus';

export interface SessionKeySet {
  /** Raw sr25519 BABE key as hex, when present. */
  babe: string | null;
  /** Raw GRANDPA key as hex, when present. */
  grandpa: string | null;
  /** Every session key field as raw hex (other keys are informational). */
  raw: Record<string, string>;
}

export interface DiscoveredValidator {
  /** SS58 (or hex) validator account id. */
  accountId: string;
  sessionKeys: SessionKeySet;
  /** Keys registered for the next session, when discoverable. */
  nextSessionKeys: SessionKeySet | null;
  source: 'queued-keys' | 'next-keys' | 'validators-only';
}

export interface AuthorityEntry {
  /** Raw consensus key hex. */
  key: string;
  /** Weight as a decimal string when published. */
  weight: string | null;
}

export interface EraContext {
  index: number | null;
  points: { total: number; byValidator: Array<{ validatorId: string; points: number }> } | null;
}

export interface ValidatorDiscoverySnapshot {
  at: { number: number; hash: string };
  sessionIndex: number | null;
  babeEpoch: BabeEpochContext | null;
  babeAuthorities: AuthorityEntry[] | null;
  grandpaAuthorities: AuthorityEntry[] | null;
  grandpaSetId: number | null;
  era: EraContext | null;
  validators: DiscoveredValidator[];
  nextValidators: DiscoveredValidator[];
  /** Names of queries that failed or were absent on this runtime. */
  unavailable: string[];
}

/** Queries bound to one block's state. */
export interface ConsensusRuntimeView {
  /** Number of the block this view is bound to (null when unreadable). */
  blockNumber(): Promise<number | null>;
  babePreDigest(): Promise<BabePreDigest | null>;
  babeEpoch(): Promise<BabeEpochContext | null>;
  babeAuthorities(): Promise<AuthorityEntry[] | null>;
  grandpaAuthorities(): Promise<AuthorityEntry[] | null>;
  grandpaSetId(): Promise<number | null>;
  sessionIndex(): Promise<number | null>;
  sessionValidators(): Promise<string[] | null>;
  sessionQueuedKeys(): Promise<Array<{ accountId: string; keys: SessionKeySet }> | null>;
  sessionNextKeys(): Promise<Array<{ accountId: string; keys: SessionKeySet }> | null>;
  activeEra(): Promise<number | null>;
  eraRewardPoints(era: number): Promise<{ total: number; byValidator: Array<{ validatorId: string; points: number }> } | null>;
}

export interface ConsensusRuntime {
  bestBlock(): Promise<{ number: number; hash: string }>;
  at(blockHash: string): Promise<ConsensusRuntimeView>;
  close(): Promise<void>;
}

export interface ValidatorDiscoveryOptions {
  runtime: ConsensusRuntime;
  now?: () => Date;
}

const ZERO_HASH = /^0x0+$/;

/**
 * Discovery over an injected runtime. One instance is scoped to one observer
 * node / chain, so its set-id history is meaningful.
 */
export class ValidatorDiscovery {
  private readonly runtime: ConsensusRuntime;
  private readonly now: () => Date;
  private readonly snapshots = new Map<string, Promise<ValidatorDiscoverySnapshot>>();
  private bestHash: string | null = null;
  private lastSetId: number | null = null;
  private readonly setHistory: GrandpaSetTransition[] = [];

  constructor(options: ValidatorDiscoveryOptions) {
    this.runtime = options.runtime;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Current-state snapshot. Reuses the cached snapshot while the best block is
   * unchanged (one snapshot per block). With an explicit hash, reads that
   * historical block and caches by hash.
   */
  async snapshot(blockHash?: string): Promise<ValidatorDiscoverySnapshot> {
    let hash = blockHash;
    if (!hash) {
      const best = await this.runtime.bestBlock();
      hash = best.hash;
      if (this.bestHash === hash && this.snapshots.has(hash)) {
        return await this.snapshots.get(hash)!;
      }
      this.bestHash = hash;
    }
    const cached = this.snapshots.get(hash);
    if (cached) return await cached;
    const pending = this.readSnapshot(hash);
    this.snapshots.set(hash, pending);
    try {
      return await pending;
    } catch (e) {
      this.snapshots.delete(hash);
      throw e;
    }
  }

  private async readSnapshot(hash: string): Promise<ValidatorDiscoverySnapshot> {
    const view = await this.runtime.at(hash);
    const header = (await view.blockNumber().catch(() => null)) ?? 0;
    const unavailable: string[] = [];
    const read = async <T>(name: string, fn: () => Promise<T | null>): Promise<T | null> => {
      try {
        return await fn();
      } catch {
        unavailable.push(name);
        return null;
      }
    };
    const epoch = await read('babe.epoch', () => view.babeEpoch());
    const [sessionIndex, babeAuthorities, grandpaAuthorities, grandpaSetId, validators, queuedKeys, nextKeys, activeEra] =
      await Promise.all([
        read('session.currentIndex', () => view.sessionIndex()),
        read('babe.authorities', () => view.babeAuthorities()),
        read('grandpa.authorities', () => view.grandpaAuthorities()),
        read('grandpa.currentSetId', () => view.grandpaSetId()),
        read('session.validators', () => view.sessionValidators()),
        read('session.queuedKeys', () => view.sessionQueuedKeys()),
        read('session.nextKeys', () => view.sessionNextKeys()),
        read('staking.activeEra', () => view.activeEra()),
      ]);
    const eraPoints = activeEra === null ? null : await read('staking.erasRewardPoints', () => view.eraRewardPoints(activeEra));
    const current = this.mergeValidators(validators, queuedKeys, nextKeys, false);
    const next = this.mergeValidators(null, null, nextKeys, true);
    return {
      at: { number: header, hash },
      sessionIndex,
      babeEpoch: epoch,
      babeAuthorities,
      grandpaAuthorities,
      grandpaSetId,
      era: activeEra === null && eraPoints === null ? null : { index: activeEra, points: eraPoints },
      validators: current,
      nextValidators: next,
      unavailable,
    };
  }

  /**
   * Merge validator accounts with their session keys. `queuedKeys` is the
   * current mapping; `nextKeys` supplies next-session keys and, with
   * `nextOnly`, the accounts registered for the next session.
   */
  private mergeValidators(
    validators: string[] | null,
    queuedKeys: Array<{ accountId: string; keys: SessionKeySet }> | null,
    nextKeys: Array<{ accountId: string; keys: SessionKeySet }> | null,
    nextOnly: boolean,
  ): DiscoveredValidator[] {
    const byAccount = new Map<string, DiscoveredValidator>();
    for (const accountId of validators ?? []) {
      if (nextOnly) continue;
      byAccount.set(accountId, {
        accountId,
        sessionKeys: { babe: null, grandpa: null, raw: {} },
        nextSessionKeys: null,
        source: 'validators-only',
      });
    }
    for (const entry of queuedKeys ?? []) {
      if (nextOnly) continue;
      const existing = byAccount.get(entry.accountId);
      byAccount.set(entry.accountId, {
        accountId: entry.accountId,
        sessionKeys: entry.keys,
        nextSessionKeys: existing?.nextSessionKeys ?? null,
        source: 'queued-keys',
      });
    }
    for (const entry of nextKeys ?? []) {
      const existing = byAccount.get(entry.accountId);
      if (existing) {
        byAccount.set(entry.accountId, { ...existing, nextSessionKeys: entry.keys });
      } else if (nextOnly) {
        byAccount.set(entry.accountId, {
          accountId: entry.accountId,
          sessionKeys: { babe: null, grandpa: null, raw: {} },
          nextSessionKeys: entry.keys,
          source: 'next-keys',
        });
      }
    }
    return [...byAccount.values()].sort((a, b) => a.accountId.localeCompare(b.accountId));
  }

  /** Current key → validator map (current session first, then next session). */
  keyMap(snapshot: ValidatorDiscoverySnapshot): Map<string, string> {
    const map = new Map<string, string>();
    for (const v of snapshot.validators) {
      if (v.sessionKeys.babe) map.set(v.sessionKeys.babe, v.accountId);
    }
    for (const v of snapshot.nextValidators) {
      if (v.nextSessionKeys?.babe && !map.has(v.nextSessionKeys.babe)) {
        map.set(v.nextSessionKeys.babe, v.accountId);
      }
    }
    return map;
  }

  /**
   * Read the authority set and pre-digest for one block and attribute it.
   * The set is read at the block's own state, which is the epoch set that
   * produced it. No current-state substitution is made.
   */
  async attribute(block: { number: number; hash: string }): Promise<{ authorship: BabeAuthorship; authoritySet: BabeAuthoritySet } | null> {
    const view = await this.runtime.at(block.hash);
    const digest = await view.babePreDigest();
    if (!digest) return null;
    const [snapshot, epoch, authorities] = await Promise.all([
      this.snapshot(block.hash),
      view.babeEpoch().catch(() => null),
      view.babeAuthorities().catch(() => null),
    ]);
    const keyMap = this.keyMap(snapshot);
    const set: BabeAuthoritySet = {
      authoritySetId: authoritySetId(epoch, authorities),
      epoch: epoch?.epoch ?? null,
      startSlot: epoch?.startSlot ?? null,
      durationSlots: epoch?.durationSlots ?? null,
      genesisSlot: epoch?.genesisSlot ?? null,
      randomness: epoch?.randomness ?? null,
      authorities:
        authorities?.map((a, index): BabeAuthority => ({
          index,
          key: a.key,
          validatorId: keyMap.get(a.key) ?? null,
          weight: a.weight,
        })) ?? null,
    };
    const authorship = attributeBabeAuthorship({
      block,
      authoritySet: set,
      digest,
      sessionId: snapshot.sessionIndex,
      validatorIdForKey: (key) => keyMap.get(key) ?? null,
    });
    return { authorship, authoritySet: set };
  }

  /**
   * Read GRANDPA context for one observation. Classification is provisional
   * (`unknown`) unless this discovery has already seen a set change; the
   * recorder re-classifies with the run's full transition history.
   */
  async finality(block: { number: number; hash: string; finalized: { number: number; hash: string } }): Promise<GrandpaFinalityObservation | null> {
    const view = await this.runtime.at(block.hash);
    const [setId, authorities, epoch] = await Promise.all([
      view.grandpaSetId().catch(() => null),
      view.grandpaAuthorities().catch(() => null),
      view.babeEpoch().catch(() => null),
    ]);
    const at = this.now().toISOString();
    if (setId !== null && this.lastSetId !== null && this.lastSetId !== setId) {
      this.setHistory.push({
        fromSetId: this.lastSetId,
        toSetId: setId,
        epoch: epoch?.epoch ?? null,
        finalizedBlock: block.finalized.number,
        at,
      });
    }
    const provisional = classifyFinalityGap({
      observation: { blockNumber: block.number, finalizedNumber: block.finalized.number, setId, at },
      transitions: this.setHistory,
      previousSetId: this.lastSetId,
    });
    if (setId !== null) this.lastSetId = setId;
    return {
      blockNumber: block.number,
      blockHash: block.hash,
      finalized: true,
      finalizedNumber: block.finalized.number,
      finalizedHash: block.finalized.hash,
      setId,
      epoch: epoch?.epoch ?? null,
      authorityCount: authorities?.length ?? null,
      lagBlocks: provisional.lagBlocks,
      classification: provisional.classification,
      reasons: provisional.reasons,
      at,
    };
  }

  /** Set-id transitions observed by this discovery (may predate the drill). */
  transitions(): GrandpaSetTransition[] {
    return [...this.setHistory];
  }

  /** Session / era / authority context for the current state. */
  async context(): Promise<ConsensusContext | null> {
    const snapshot = await this.snapshot();
    const validators = snapshot.validators;
    const babeSet = authoritySetId(snapshot.babeEpoch, snapshot.babeAuthorities);
    return {
      eraId: snapshot.era?.index ?? null,
      sessionId: snapshot.sessionIndex,
      babeEpoch: snapshot.babeEpoch?.epoch ?? null,
      babeAuthoritySetId: babeSet,
      grandpaSetId: snapshot.grandpaSetId,
      validatorCount: validators.length > 0 ? validators.length : null,
      eraPoints: snapshot.era?.points ?? null,
      transitionsObserved: snapshot.unavailable.length ? [`unavailable reads: ${snapshot.unavailable.join(', ')}`] : [],
    };
  }

  /** Drop cached snapshots (tests / long-running monitoring). */
  clear(): void {
    this.snapshots.clear();
    this.bestHash = null;
  }

  async close(): Promise<void> {
    this.snapshots.clear();
    await this.runtime.close();
  }
}

/** Stable id for an observed BABE authority set (epoch + authority keys). */
export function authoritySetId(epoch: BabeEpochContext | null, authorities: AuthorityEntry[] | null): string {
  const e = epoch?.epoch ?? '?';
  if (!authorities || authorities.length === 0) return `babe:${e}:unavailable`;
  const digest = createHash('sha256').update(authorities.map((a) => `${a.key}:${a.weight ?? ''}`).join('|')).digest('hex');
  return `babe:${e}:${digest.slice(0, 16)}`;
}

/** True when a block hash is the all-zero "unknown" hash. */
export function isZeroHash(hash: string): boolean {
  return ZERO_HASH.test(hash);
}
