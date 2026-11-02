/**
 * Read-only Substrate JSON-RPC reader for chain-bound evidence (T-9.1).
 *
 * Uses only `chain_getHeader`, `chain_getFinalizedHead`, and
 * `chain_getBlockHash` over HTTP. Transport failures are surfaced as
 * `ChainUnreachableError` so verification can say "unverifiable: network
 * offline" instead of mistaking an outage for a mismatch.
 */

import { createHash } from "node:crypto";
import { xxhashAsU8a } from "@polkadot/util-crypto";
import { babeAuthorshipFromLogs } from "./babe";
import type { BlockRef, HeadReader } from "./evidence";

export class ChainUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainUnreachableError";
  }
}

export interface ChainReader extends HeadReader {
  /** Canonical hash at `number`, or null when the node has no such block. */
  blockHashAt(number: number): Promise<string | null>;
  genesisHash(): Promise<string | null>;
  /** Consensus authorities active at the supplied block hash. */
  babeAuthoritiesAt(hash: string): Promise<string[]>;
  /** GRANDPA set id and authority fingerprint at the supplied block hash. */
  grandpaContextAt(hash: string): Promise<{ setId: string; authoritiesHash: string }>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpChainReaderOptions {
  timeoutMs?: number;
  fetch?: FetchLike;
}

interface HeaderJson {
  number: string | number;
  parentHash?: string;
  digest?: { logs?: string[] };
}

export function createHttpChainReader(
  url: string,
  options: HttpChainReaderOptions = {},
): ChainReader {
  const timeoutMs = options.timeoutMs ?? 4_000;
  const doFetch: FetchLike = options.fetch ?? ((u, init) => fetch(u, init));
  let genesis: string | null | undefined;

  async function call(
    method: string,
    params: unknown[] = [],
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ChainUnreachableError(
        `${method}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!res.ok)
      throw new ChainUnreachableError(`${method}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: unknown;
      error?: { message?: string };
    };
    if (body.error)
      throw new Error(`${method}: ${body.error.message ?? "RPC error"}`);
    return body.result;
  }

  async function hashAt(n: number): Promise<string | null> {
    const r = await call("chain_getBlockHash", [n]);
    return typeof r === "string" ? r.toLowerCase() : null;
  }

  async function headerOf(hash?: string): Promise<BlockRef> {
    const header = (await call(
      "chain_getHeader",
      hash ? [hash] : [],
    )) as HeaderJson | null;
    if (!header) throw new Error("chain_getHeader returned no header");
    const number =
      typeof header.number === "number"
        ? header.number
        : parseInt(header.number, 16);
    // A header does not carry its own hash; resolve it canonically by number
    // for the best block, and keep the caller-supplied hash otherwise.
    const resolved = hash ?? (await hashAt(number));
    if (!resolved) throw new Error(`no hash for block #${number}`);
    const ref: BlockRef = { number, hash: resolved.toLowerCase() };
    const a = babeAuthorshipFromLogs(header.digest?.logs ?? []);
    if (a) {
      const authorities = await reader.babeAuthoritiesAt(ref.hash);
      ref.author = {
        kind: a.kind,
        authorityIndex: a.authorityIndex,
        slot: a.slot,
        ...(authorities[a.authorityIndex] ? { authorityId: authorities[a.authorityIndex] } : {}),
      };
    }
    const grandpa = await reader.grandpaContextAt(ref.hash);
    ref.grandpaSetId = grandpa.setId;
    ref.grandpaAuthoritiesHash = grandpa.authoritiesHash;
    return ref;
  }

  async function storageAt(key: string, hash: string, label: string): Promise<Uint8Array> {
    const value = await call("state_getStorage", [key, hash]);
    if (typeof value !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(value))
      throw new Error(`${label}: state_getStorage returned no valid SCALE value at ${hash}`);
    return Buffer.from(value.slice(2), "hex");
  }

  function storageKey(pallet: string, item: string): string {
    const palletHash = xxhashAsU8a(Buffer.from(pallet), 128);
    const itemHash = xxhashAsU8a(Buffer.from(item), 128);
    return `0x${Buffer.from(palletHash).toString("hex")}${Buffer.from(itemHash).toString("hex")}`;
  }

  function vectorCount(bytes: Uint8Array, label: string): { count: number; offset: number } {
    const first = bytes[0];
    if (first === undefined) throw new Error(`${label}: empty SCALE vector`);
    const mode = first & 3;
    if (mode === 0) return { count: first >>> 2, offset: 1 };
    if (mode === 1 && bytes.length >= 2)
      return { count: (first | (bytes[1]! << 8)) >>> 2, offset: 2 };
    if (mode === 2 && bytes.length >= 4)
      return { count: (first | (bytes[1]! << 8) | (bytes[2]! << 16) | (bytes[3]! << 24)) >>> 2, offset: 4 };
    throw new Error(`${label}: unsupported or truncated SCALE vector length`);
  }

  function authorityHash(authorities: string[]): string {
    return createHash("sha256").update(JSON.stringify(authorities)).digest("hex");
  }

  async function babeAuthoritiesAt(hash: string): Promise<string[]> {
    const bytes = await storageAt(storageKey("Babe", "Authorities"), hash, "babe.authorities");
    const { count, offset: start } = vectorCount(bytes, "babe.authorities");
    if (count > 10_000) throw new Error("babe.authorities: unreasonable authority count");
    // Babe.Authorities stores Vec<(AuthorityId, BabeAuthorityWeight)> where
    // AuthorityId is 32 bytes and BabeAuthorityWeight is a SCALE u64 (8 bytes).
    const authoritySize = 40;
    if (start + count * authoritySize !== bytes.length)
      throw new Error("babe.authorities: malformed SCALE vector");
    const authorities: string[] = [];
    let offset = start;
    for (let i = 0; i < count; i++) {
      if (offset + authoritySize > bytes.length) throw new Error("babe.authorities: truncated authority");
      authorities.push(`0x${Buffer.from(bytes.subarray(offset, offset + 32)).toString("hex")}`);
      offset += 32;
      offset += 8;
      if (offset > bytes.length) throw new Error("babe.authorities: truncated weight");
    }
    return authorities;
  }

  async function grandpaContextAt(hash: string): Promise<{ setId: string; authoritiesHash: string }> {
    const [idBytes, authorityBytes] = await Promise.all([
      storageAt(storageKey("Grandpa", "CurrentSetId"), hash, "grandpa.currentSetId"),
      storageAt(storageKey("Grandpa", "Authorities"), hash, "grandpa.authorities"),
    ]);
    if (idBytes.length !== 8) throw new Error("grandpa.currentSetId: expected SCALE u64");
    const { count, offset: start } = vectorCount(authorityBytes, "grandpa.authorities");
    if (count > 10_000 || start + count * 40 !== authorityBytes.length)
      throw new Error("grandpa.authorities: malformed SCALE vector");
    const authorities: string[] = [];
    for (let i = 0; i < count; i++) {
      const offset = start + i * 40;
      authorities.push(`0x${Buffer.from(authorityBytes.subarray(offset, offset + 32)).toString("hex")}`);
    }
    const setId = BigInt(`0x${Buffer.from(idBytes).reverse().toString("hex")}`).toString();
    return { setId, authoritiesHash: authorityHash(authorities) };
  }

  const reader: ChainReader = {
    async genesisHash() {
      if (genesis === undefined) genesis = await hashAt(0);
      return genesis;
    },
    blockHashAt: hashAt,
    babeAuthoritiesAt,
    grandpaContextAt,
    async readHeads() {
      const finalizedHash = (await call("chain_getFinalizedHead")) as string;
      const [best, finalized] = await Promise.all([
        headerOf(),
        headerOf(finalizedHash),
      ]);
      return { best, finalized, genesisHash: await reader.genesisHash() };
    },
  };
  return reader;
}
