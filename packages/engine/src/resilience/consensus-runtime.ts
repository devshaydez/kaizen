/**
 * Real read-only consensus runtime for Portaldot (T-9.7B).
 *
 * `PolkadotConsensusRuntime` implements the `ConsensusRuntime` facade over
 * `@polkadot/api` using an HTTP provider: every query is a bounded read, no
 * subscription is opened, and no mutating extrinsic exists in this module.
 *
 * Decoding is defensive by design. Portaldot's runtime is not augmented in
 * @polkadot/api's bundled types, and storage shapes can differ between
 * runtimes; each value is coerced through explicit helpers that return `null`
 * on an unexpected shape. A malformed read is therefore reported as
 * unavailable (`ValidatorDiscovery` records it) instead of being guessed.
 */

import { ApiPromise, HttpProvider } from '@polkadot/api';
import { decodeAddress } from '@polkadot/util-crypto';
import { KaizenError } from '../errors';
import {
  decodeBabePreDigest,
  stripCompactLengthPrefix,
  type BabeEpochContext,
  type BabePreDigest,
} from './consensus';
import {
  ValidatorDiscovery,
  type AuthorityEntry,
  type ConsensusRuntime,
  type ConsensusRuntimeView,
  type SessionKeySet,
} from './discovery';
import type { ChainConsensusCapture } from './evidence';

export interface ConsensusRuntimeOptions {
  rpcUrl: string;
  initTimeoutMs?: number;
}

const BABE_ENGINE_ID = '0x42414245';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function codec(value: unknown): {
  toU8a?: () => Uint8Array;
  toString(): string;
  toJSON?: () => unknown;
  toNumber?: () => number;
  toBigInt?: () => bigint;
  isSome?: boolean;
  unwrap?: () => unknown;
} | null {
  if (!isRecord(value)) return null;
  return value as unknown as {
    toU8a?: () => Uint8Array;
    toString(): string;
    toJSON?: () => unknown;
    toNumber?: () => number;
    toBigInt?: () => bigint;
    isSome?: boolean;
    unwrap?: () => unknown;
  };
}

/** Unwrap an Option/Value codec to its inner value when applicable. */
function unwrap(value: unknown): unknown {
  const c = codec(value);
  if (c && typeof c.isSome === 'boolean') return c.isSome && c.unwrap ? c.unwrap() : null;
  return value;
}

function numberFrom(value: unknown): number | null {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (typeof v === 'bigint') return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
  const c = codec(v);
  if (!c) return null;
  try {
    if (typeof c.toBigInt === 'function') {
      const b = c.toBigInt();
      return b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : null;
    }
    if (typeof c.toNumber === 'function') {
      const n = c.toNumber();
      return Number.isSafeInteger(n) ? n : null;
    }
    const n = Number(c.toString());
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function bigintFrom(value: unknown): bigint | null {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v;
  const c = codec(v);
  try {
    if (c && typeof c.toBigInt === 'function') return c.toBigInt();
    return BigInt(String(v));
  } catch {
    return null;
  }
}

/** Raw 32-byte consensus key hex, tolerating SCALE-Bytes length prefixes. */
function rawKeyHex(value: unknown): string | null {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  const c = codec(v);
  if (!c || typeof c.toU8a !== 'function') return null;
  try {
    const bytes = Buffer.from(c.toU8a());
    if (bytes.length === 32) return `0x${bytes.toString('hex')}`;
    // SCALE compact length prefix for 32 bytes is 0x80.
    if (bytes.length === 33 && bytes[0] === 0x80) return `0x${bytes.subarray(1).toString('hex')}`;
    return null;
  } catch {
    return null;
  }
}

function accountIdOf(value: unknown): string | null {
  const v = unwrap(value);
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
    try {
      decodeAddress(v);
      return v;
    } catch {
      return null;
    }
  }
  const c = codec(v);
  if (!c) return null;
  try {
    const text = c.toString();
    if (/^0x[0-9a-fA-F]{64}$/.test(text)) return text.toLowerCase();
    decodeAddress(text);
    return text;
  } catch {
    return null;
  }
}

/** Convert a JSON-ish session-key field (hex or SS58) to raw key hex. */
function jsonKeyHex(value: unknown): string | null {
  if (typeof value === 'string') {
    if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
    try {
      return `0x${Buffer.from(decodeAddress(value)).toString('hex')}`;
    } catch {
      return null;
    }
  }
  return rawKeyHex(value);
}

function sessionKeysFrom(value: unknown): SessionKeySet {
  const raw: Record<string, string> = {};
  const c = codec(value);
  let json: unknown = null;
  try {
    json = c && typeof c.toJSON === 'function' ? c.toJSON() : null;
  } catch {
    json = null;
  }
  if (isRecord(json) && !Array.isArray(json)) {
    for (const [field, fieldValue] of Object.entries(json)) {
      const hex = jsonKeyHex(fieldValue);
      if (hex) raw[field] = hex;
    }
  } else if (Array.isArray(json)) {
    // Unnamed struct: field order is runtime-defined, so no identity claim is
    // made. The values are kept for diagnostics only.
    json.forEach((fieldValue, i) => {
      const hex = jsonKeyHex(fieldValue);
      if (hex) raw[`field${i}`] = hex;
    });
  }
  const pick = (name: string): string | null => {
    const exact = Object.keys(raw).find((k) => k.toLowerCase() === name);
    if (exact) return raw[exact]!;
    const partial = Object.keys(raw).find((k) => k.toLowerCase().includes(name));
    return partial ? raw[partial]! : null;
  };
  return { babe: pick('babe'), grandpa: pick('grandpa'), raw };
}

/** Normalize a Vec-of-pairs codec to an array of `[unknown, unknown]`. */
function pairs(value: unknown): Array<[unknown, unknown]> {
  const v = unwrap(value);
  if (v === null || v === undefined) return [];
  const out: Array<[unknown, unknown]> = [];
  const iterable = v as unknown as Iterable<unknown>;
  try {
    for (const item of iterable) {
      if (Array.isArray(item) && item.length >= 2) out.push([item[0], item[1]]);
      else {
        const c = codec(item);
        const json = c && typeof c.toJSON === 'function' ? c.toJSON() : null;
        if (Array.isArray(json) && json.length >= 2) out.push([json[0], json[1]]);
      }
    }
  } catch {
    return [];
  }
  return out;
}

function list(value: unknown): unknown[] {
  const v = unwrap(value);
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v;
  try {
    return [...(v as Iterable<unknown>)];
  } catch {
    return [];
  }
}

function mapAuthorities(value: unknown): AuthorityEntry[] | null {
  if (unwrap(value) === null || unwrap(value) === undefined) return null;
  const items = list(value);
  if (items.length === 0) return [];
  const out: AuthorityEntry[] = [];
  for (const item of items) {
    const pair = Array.isArray(item) ? item : null;
    const key = rawKeyHex(pair ? pair[0] : (item as { key?: unknown })?.key);
    if (!key) return null;
    const weight = bigintFrom(pair ? pair[1] : (item as { weight?: unknown })?.weight);
    out.push({ key, weight: weight === null ? null : weight.toString() });
  }
  return out;
}

function tupleNumbers(value: unknown): number[] | null {
  const v = unwrap(value);
  const items = Array.isArray(v) ? v : list(v);
  if (items.length === 0) return null;
  const numbers = items.map(numberFrom);
  return numbers.every((n): n is number => n !== null) ? numbers : null;
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new KaizenError('RPC_TIMEOUT', `${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

type QueryMap = Record<string, ((...args: unknown[]) => Promise<unknown>) & { entries?: () => Promise<unknown> }>;

function queryGroup(at: unknown, name: string): QueryMap | null {
  const query = (at as { query?: Record<string, unknown> }).query;
  const group = query?.[name];
  return isRecord(group) ? (group as QueryMap) : null;
}

function constGroup(api: unknown, name: string): Record<string, unknown> | null {
  const consts = (api as { consts?: Record<string, unknown> }).consts;
  const group = consts?.[name];
  return isRecord(group) ? group : null;
}

class PolkadotView implements ConsensusRuntimeView {
  constructor(
    private readonly at: unknown,
    private readonly api: unknown,
    private readonly hash: string,
  ) {}

  private call<T>(group: string, method: string, args: unknown[] = []): Promise<T> {
    const g = queryGroup(this.at, group);
    const fn = g?.[method];
    if (!fn) return Promise.reject(new Error(`${group}.${method} is not present in this runtime`));
    return fn(...args) as Promise<T>;
  }

  async blockNumber(): Promise<number | null> {
    try {
      const header = await (this.api as { rpc: { chain: { getHeader(hash: string): Promise<unknown> } } }).rpc.chain.getHeader(
        this.hash,
      );
      return numberFrom((header as { number?: unknown }).number);
    } catch {
      return null;
    }
  }

  async babePreDigest(): Promise<BabePreDigest | null> {
    const header = (await (this.api as { rpc: { chain: { getHeader(hash: string): Promise<unknown> } } }).rpc.chain.getHeader(
      this.hash,
    )) as { digest?: { logs?: unknown[] } };
    for (const log of header.digest?.logs ?? []) {
      const item = log as {
        isPreRuntime?: boolean;
        asPreRuntime?: [unknown, unknown];
      };
      if (!item.isPreRuntime || !item.asPreRuntime) continue;
      const engine = item.asPreRuntime[0];
      const engineHex = codec(engine)?.toString().toLowerCase();
      const engineName = codec(engine)?.toString();
      if (engineHex !== BABE_ENGINE_ID && engineName !== 'BABE') continue;
      const data = item.asPreRuntime[1];
      const c = codec(data);
      if (!c || typeof c.toU8a !== 'function') return null;
      try {
        // @polkadot/types exposes the Vec<u8> encoding (compact length
        // included) for PreRuntime data, so strip the verified prefix before
        // decoding the pre-digest (found by the live drill on 2026-11-04).
        return decodeBabePreDigest(stripCompactLengthPrefix(c.toU8a()));
      } catch {
        return null;
      }
    }
    return null;
  }

  async babeEpoch(): Promise<BabeEpochContext | null> {
    const epochRaw = await this.call<unknown>('babe', 'epochIndex').catch(() => null);
    const [startRaw, randomnessRaw, genesisRaw] = await Promise.all([
      this.call<unknown>('babe', 'epochStart').catch(() => null),
      this.call<unknown>('babe', 'randomness').catch(() => null),
      this.call<unknown>('babe', 'genesisSlot').catch(() => null),
    ]);
    const epoch = numberFrom(epochRaw);
    const startTuple = tupleNumbers(startRaw);
    const randomness = rawKeyHex(randomnessRaw);
    const durationRaw = constGroup(this.api, 'babe')?.['epochDuration'];
    const durationSlots = numberFrom(durationRaw);
    if (epoch === null && startTuple === null && randomness === null) return null;
    return {
      epoch,
      startSlot: startTuple?.[1] ?? null,
      durationSlots,
      genesisSlot: numberFrom(genesisRaw),
      randomness,
    };
  }

  async babeAuthorities(): Promise<AuthorityEntry[] | null> {
    return mapAuthorities(await this.call<unknown>('babe', 'authorities'));
  }

  async grandpaAuthorities(): Promise<AuthorityEntry[] | null> {
    return mapAuthorities(await this.call<unknown>('grandpa', 'authorities'));
  }

  async grandpaSetId(): Promise<number | null> {
    const direct = await this.call<unknown>('grandpa', 'currentSetId').catch(() => null);
    if (direct !== null) {
      const n = numberFrom(direct);
      if (n !== null) return n;
    }
    const state = await this.call<unknown>('grandpa', 'state').catch(() => null);
    const json = codec(state)?.toJSON?.();
    if (isRecord(json)) return numberFrom(json['setId'] ?? json['set_id']);
    return null;
  }

  async sessionIndex(): Promise<number | null> {
    return numberFrom(await this.call<unknown>('session', 'currentIndex'));
  }

  async sessionValidators(): Promise<string[] | null> {
    const items = list(await this.call<unknown>('session', 'validators'));
    const accounts = items.map(accountIdOf).filter((a): a is string => a !== null);
    return accounts.length === items.length ? accounts : null;
  }

  async sessionQueuedKeys(): Promise<Array<{ accountId: string; keys: SessionKeySet }> | null> {
    const entries = pairs(await this.call<unknown>('session', 'queuedKeys'));
    const out: Array<{ accountId: string; keys: SessionKeySet }> = [];
    for (const [account, keys] of entries) {
      const accountId = accountIdOf(account);
      if (!accountId) return null;
      out.push({ accountId, keys: sessionKeysFrom(keys) });
    }
    return out;
  }

  async keyOwner(key: string): Promise<string | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
    // session.keyOwner is a map keyed by the tuple (KeyTypeId, Bytes), so the
    // pair is one argument and the type id must be its four bytes, not a hex
    // string (which would be encoded as ten text bytes). This facade resolves
    // BABE authority keys, so the id is fixed.
    const keyType = new Uint8Array([0x62, 0x61, 0x62, 0x65]); // 'babe'
    const value = await this.call<unknown>('session', 'keyOwner', [[keyType, key]]);
    return accountIdOf(value);
  }

  async sessionNextKeys(): Promise<Array<{ accountId: string; keys: SessionKeySet }> | null> {
    const group = queryGroup(this.at, 'session');
    const nextKeys = group?.['nextKeys'] as QueryMap[string] | undefined;
    const entriesFn = nextKeys?.entries;
    if (!entriesFn) return null;
    const raw = await entriesFn.call(nextKeys);
    if (!Array.isArray(raw)) return null;
    const out: Array<{ accountId: string; keys: SessionKeySet }> = [];
    for (const entry of raw) {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const storageKey = entry[0] as { args?: unknown[] };
      const accountArg = storageKey.args?.[0];
      const accountId = accountIdOf(accountArg);
      if (!accountId) return null;
      out.push({ accountId, keys: sessionKeysFrom(entry[1]) });
    }
    return out;
  }

  async activeEra(): Promise<number | null> {
    const value = await this.call<unknown>('staking', 'activeEra');
    const inner = unwrap(value);
    if (isRecord(inner)) return numberFrom(inner['index'] ?? inner['era']);
    return numberFrom(inner);
  }

  async eraRewardPoints(
    era: number,
  ): Promise<{ total: number; byValidator: Array<{ validatorId: string; points: number }> } | null> {
    const value = await this.call<unknown>('staking', 'erasRewardPoints', [era]);
    const json = codec(value)?.toJSON?.();
    if (!isRecord(json)) return null;
    const total = numberFrom(json['total']);
    const individual = json['individual'];
    const byValidator: Array<{ validatorId: string; points: number }> = [];
    if (isRecord(individual)) {
      for (const [validatorId, points] of Object.entries(individual)) {
        const n = numberFrom(points);
        if (n !== null) byValidator.push({ validatorId, points: n });
      }
    } else if (Array.isArray(individual)) {
      for (const entry of individual) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const validatorId = accountIdOf(entry[0]);
        const n = numberFrom(entry[1]);
        if (validatorId && n !== null) byValidator.push({ validatorId, points: n });
      }
    }
    if (total === null && byValidator.length === 0) return null;
    byValidator.sort((a, b) => a.validatorId.localeCompare(b.validatorId));
    return { total: total ?? byValidator.reduce((s, v) => s + v.points, 0), byValidator };
  }
}

export class PolkadotConsensusRuntime implements ConsensusRuntime {
  private apiPromise: Promise<ApiPromise> | null = null;

  constructor(private readonly options: ConsensusRuntimeOptions) {}

  private api(): Promise<ApiPromise> {
    if (!this.apiPromise) {
      const provider = new HttpProvider(this.options.rpcUrl);
      this.apiPromise = withDeadline(
        ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
        this.options.initTimeoutMs ?? 20_000,
        'consensus RPC init',
      );
      // A failed init must be retried on the next call, not cached forever.
      void this.apiPromise.catch(() => {
        this.apiPromise = null;
      });
    }
    return this.apiPromise;
  }

  async bestBlock(): Promise<{ number: number; hash: string }> {
    const api = await this.api();
    const header = await api.rpc.chain.getHeader();
    const number = header.number.toNumber();
    const hash = header.hash.toHex();
    return { number, hash };
  }

  async at(blockHash: string): Promise<ConsensusRuntimeView> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) {
      throw new KaizenError('INVALID_INPUT', 'blockHash must be 0x-prefixed 32-byte hex');
    }
    const api = await this.api();
    const at = await api.at(blockHash);
    return new PolkadotView(at, api, blockHash);
  }

  async close(): Promise<void> {
    const pending = this.apiPromise;
    this.apiPromise = null;
    if (!pending) return;
    const api = await pending.catch(() => null);
    await api?.disconnect().catch(() => undefined);
  }
}

/**
 * Production consensus capture for one observer node: discovery + attribution
 * over the node's own HTTP RPC endpoint. No writes, no subscriptions.
 */
export class NodeConsensusCapture implements ChainConsensusCapture {
  readonly discovery: ValidatorDiscovery;

  constructor(options: { rpcUrl: string; runtime?: ConsensusRuntime; now?: () => Date; initTimeoutMs?: number }) {
    const runtime = options.runtime ?? new PolkadotConsensusRuntime({ rpcUrl: options.rpcUrl, initTimeoutMs: options.initTimeoutMs });
    this.discovery = new ValidatorDiscovery({ runtime, now: options.now });
  }

  readAuthoring(block: { number: number; hash: string }) {
    return this.discovery.attribute(block);
  }

  readFinality(block: { number: number; hash: string; finalized: { number: number; hash: string } }) {
    return this.discovery.finality(block);
  }

  readContext() {
    return this.discovery.context();
  }

  transitions() {
    return this.discovery.transitions();
  }

  close(): Promise<void> {
    return this.discovery.close();
  }
}

export function createNodeConsensusCapture(
  rpcUrl: string,
  options: { now?: () => Date; runtime?: ConsensusRuntime; initTimeoutMs?: number } = {},
): NodeConsensusCapture {
  return new NodeConsensusCapture({ rpcUrl, ...options });
}
