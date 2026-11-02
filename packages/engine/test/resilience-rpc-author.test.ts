import { describe, expect, it } from "vitest";
import { xxhashAsU8a } from "@polkadot/util-crypto";
import { createHttpChainReader } from "@kaizen/engine";

const H = "0x" + "ab".repeat(32);
const payload = "01" + "02000000" + "2a00000000000000";
const log = "0x06" + "42414245" + "34" + payload;
const authorities = ["11", "22", "33"].map((byte) => `0x${byte.repeat(32)}`);
const storageKey = (pallet: string, item: string) =>
  `0x${Buffer.from(xxhashAsU8a(Buffer.from(pallet), 128)).toString("hex")}${Buffer.from(xxhashAsU8a(Buffer.from(item), 128)).toString("hex")}`;
const babeBytes = `0x0c${authorities.map((key) => `${key.slice(2)}${"04".repeat(8)}`).join("")}`;
const grandpaAuthorities = `0x04${"44".repeat(32)}${"0100000000000000"}`;

 describe("HTTP chain reader BABE author evidence", () => {
  it("maps the digest index through authorities at the exact block hash and reads GRANDPA context there", async () => {
    const stateHashes: string[] = [];
    const fetchFn = async (_u: string, init?: { body?: unknown }) => {
      const { method, params } = JSON.parse(String(init?.body));
      let result: unknown;
      if (method === "chain_getFinalizedHead" || method === "chain_getBlockHash") result = H;
      else if (method === "state_getStorage") {
        stateHashes.push(params[1]);
        if (params[0] === storageKey("Babe", "Authorities")) result = babeBytes;
        else if (params[0] === storageKey("Grandpa", "CurrentSetId")) result = `0x${"07"}${"00".repeat(7)}`;
        else if (params[0] === storageKey("Grandpa", "Authorities")) result = grandpaAuthorities;
        else result = null;
      } else if (method === "chain_getHeader") result = { number: "0x10", digest: { logs: [log] } };
      else result = H;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    };
    const reader = createHttpChainReader("http://x", { fetch: fetchFn as never });
    const heads = await reader.readHeads();
    expect(heads.best.number).toBe(16);
    expect(heads.best.author).toEqual({
      kind: "primary",
      authorityIndex: 2,
      slot: "42",
      authorityId: authorities[2],
    });
    expect(heads.finalized.author?.slot).toBe("42");
    expect(heads.best.grandpaSetId).toBe("7");
    expect(heads.best.grandpaAuthoritiesHash).toEqual(expect.any(String));
    expect(stateHashes).toHaveLength(6);
    expect(stateHashes.every((hash) => hash === H)).toBe(true);
  });
});
