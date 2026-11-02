/**
 * Replay-mode Portaldot V3 reads, made LIVE from the browser against the
 * public test network (HTTP JSON-RPC; the node and the EVM RPC both answer
 * CORS). Read-only: the browser never signs anything.
 *
 * Recorded on-chain facts used here (each re-checked against the chain by
 * "Verify"):
 *  - KaizenResilienceRegistry 0x8ec2b52a…764a, deployed by native extrinsic
 *    0x88bdae46…d9e9 in block #167466; anchor() extrinsic 0x905f964c…fee3 in
 *    block #167478 carrying the CI Proof-of-Resilience certificate
 *    (fingerprint 0x517b2ffb…2e33, run 40042905143).
 *  - docs/evidence/v3-anchors.json: KaizenRunRegistry deployment + anchors of
 *    the local evidence runs.
 *  - Drill bundles anchored with System.remarkWithEvent when the workflow's
 *    signer secret is set.
 */

import type {
  V3AnchorRecord,
  V3AnchorStatusReport,
  V3AnchorVerification,
  V3ConnectivityReport,
  V3ContractRecord,
  V3EndpointProbeResult,
} from '../types';
import { extrinsicHash } from '../../lib/blake2b';
import { runHashOf } from './map';
import type { ReplayData } from './data';

export const V3_RPC = 'https://test-node-v3.portaldot.dev';
export const V3_EVM_RPC = 'https://test-evm-rpc-v3.portaldot.dev';
export const V3_EXPLORER = 'https://node-console.portaldot.dev';
export const V3_EVM_CHAIN_ID = 420420777;
/** Same block-link format as the engine and Landing.consoleBlockUrl. */
export const V3_BLOCK_URL_TEMPLATE = `${V3_EXPLORER}/?rpc=${encodeURIComponent('wss://test-node-v3.portaldot.dev')}#/explorer/query/{block}`;

export const RESILIENCE_REGISTRY = {
  address: '0x8ec2b52a5e407926309f983f6e7d019d66da764a',
  deploy: { block: 167466, blockHash: '0x78c5ca8715d548a0e1d9a31381d117645fa65ce6d7affddebfe00364a8c5b859', tx: '0x88bdae46743bbf059150a16d705ebe955dd3b91a8b8b34eb91d7ecb9cc0dd9e9' },
  anchor: { block: 167478, blockHash: '0xfbe64ed2d727a54c1cf6cee6b512b2cf99795afa74707397d1350cd7f4bc73f6', tx: '0x905f964cb7ca45c9d1ed630084595b7b8b934c0288216fdc5252436e0d86fee3' },
};
const V3_GENESIS = '0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd';

type FetchLike = typeof fetch;

/** JSON-RPC over HTTP with two retries (the public node rate-limits bursts). */
async function rpc<T>(fetchImpl: FetchLike, url: string, method: string, params: unknown[], timeoutMs = 15_000): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt + Math.random() * 400));
    try {
      return await rpcOnce<T>(fetchImpl, url, method, params, timeoutMs);
    } catch (e) {
      last = e;
      if ((e as Error).name === 'AbortError' || /^RPC:/.test((e as Error).message)) break;
    }
  }
  throw last;
}

async function rpcOnce<T>(fetchImpl: FetchLike, url: string, method: string, params: unknown[], timeoutMs: number): Promise<T> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: c.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(`RPC: ${body.error.message}`);
    return body.result as T;
  } finally {
    clearTimeout(t);
  }
}

const now = () => new Date().toISOString();

// ---- probe ----------------------------------------------------------------

async function timed<T>(f: () => Promise<T>): Promise<{ v: T | null; err: Error | null; ms: number }> {
  const t0 = performance.now();
  try {
    return { v: await f(), err: null, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { v: null, err: e as Error, ms: Math.round(performance.now() - t0) };
  }
}

function failed(role: V3EndpointProbeResult['role'], endpoint: string, err: Error, ms: number): V3EndpointProbeResult {
  const timeout = err.name === 'AbortError';
  return {
    role,
    endpoint,
    status: timeout ? 'timeout' : 'unavailable',
    detail: timeout ? 'no answer within 15 s' : err.message,
    latencyMs: ms,
    at: now(),
    error: { kind: timeout ? 'timeout' : 'unavailable', message: err.message },
    warnings: [],
  };
}

export async function probeV3(fetchImpl: FetchLike): Promise<V3ConnectivityReport> {
  const [sub, evm, exp] = await Promise.all([
    timed(async () => {
      const [chainName, health, header] = await Promise.all([
        rpc<string>(fetchImpl, V3_RPC, 'system_chain', []),
        rpc<{ isSyncing: boolean; peers: number; shouldHavePeers: boolean }>(fetchImpl, V3_RPC, 'system_health', []),
        rpc<{ number: string }>(fetchImpl, V3_RPC, 'chain_getHeader', []),
      ]);
      const number = Number.parseInt(header.number, 16);
      const hash = await rpc<string>(fetchImpl, V3_RPC, 'chain_getBlockHash', [number]);
      return { chainName, health, best: { number, hash } };
    }),
    timed(async () => {
      const [cid, bn] = await Promise.all([rpc<string>(fetchImpl, V3_EVM_RPC, 'eth_chainId', []), rpc<string>(fetchImpl, V3_EVM_RPC, 'eth_blockNumber', [])]);
      const cv = await rpc<string>(fetchImpl, V3_EVM_RPC, 'web3_clientVersion', []).catch(() => null);
      return { chainId: Number.parseInt(cid, 16), blockNumber: Number.parseInt(bn, 16), clientVersion: cv };
    }),
    // The node console sends no CORS headers: the browser can only learn
    // that it answered (opaque response), not its status or title.
    timed(() => fetchImpl(V3_EXPLORER, { mode: 'no-cors' })),
  ]);
  const substrate: V3EndpointProbeResult = sub.v
    ? {
        role: 'substrate-ws',
        endpoint: V3_RPC,
        status: 'ok',
        detail: `${sub.v.chainName} · best #${sub.v.best.number}`,
        latencyMs: sub.ms,
        at: now(),
        substrate: sub.v,
        error: null,
        warnings: ['Probed from your browser over HTTP JSON-RPC (same node as wss://test-node-v3.portaldot.dev).'],
      }
    : failed('substrate-ws', V3_RPC, sub.err!, sub.ms);
  const evmRes: V3EndpointProbeResult = evm.v
    ? {
        role: 'evm-rpc',
        endpoint: V3_EVM_RPC,
        status: evm.v.chainId === V3_EVM_CHAIN_ID ? 'ok' : 'mismatch',
        detail: `chain id ${evm.v.chainId}`,
        latencyMs: evm.ms,
        at: now(),
        evm: { chainId: evm.v.chainId, expectedChainId: V3_EVM_CHAIN_ID, blockNumber: evm.v.blockNumber, clientVersion: evm.v.clientVersion },
        error: evm.v.chainId === V3_EVM_CHAIN_ID ? null : { kind: 'mismatch', message: `expected chain id ${V3_EVM_CHAIN_ID}` },
        warnings: [],
      }
    : failed('evm-rpc', V3_EVM_RPC, evm.err!, evm.ms);
  const explorer: V3EndpointProbeResult = exp.v
    ? {
        role: 'explorer',
        endpoint: V3_EXPLORER,
        status: 'ok',
        detail: 'answered (cross-origin: status and title not readable from a browser)',
        latencyMs: exp.ms,
        at: now(),
        explorer: { httpStatus: null, contentType: null, bodyBytes: 0, documentTitle: null },
        error: null,
        warnings: ['Opaque no-cors response: reachability only.'],
      }
    : failed('explorer', V3_EXPLORER, exp.err!, exp.ms);
  return {
    at: now(),
    config: { substrateWs: V3_RPC, evmRpc: V3_EVM_RPC, explorer: V3_EXPLORER, expectedEvmChainId: V3_EVM_CHAIN_ID, probeTimeoutMs: 15_000 },
    substrate,
    evm: evmRes,
    explorer,
    healthy: substrate.status === 'ok' && evmRes.status === 'ok' && explorer.status === 'ok',
  };
}

export async function statusV3(fetchImpl: FetchLike): Promise<V3AnchorStatusReport> {
  let chainName: string | null = null;
  let genesisHash: string | null = null;
  let error: string | null = null;
  try {
    [chainName, genesisHash] = await Promise.all([rpc<string>(fetchImpl, V3_RPC, 'system_chain', []), rpc<string>(fetchImpl, V3_RPC, 'chain_getBlockHash', [0])]);
  } catch (e) {
    error = `V3 node unreachable from the browser: ${(e as Error).message}`;
  }
  return {
    signer: { configured: false, address: null, evmAddress: null, freeBalance: null, tokenSymbol: null, tokenDecimals: null },
    registryAddress: RESILIENCE_REGISTRY.address,
    registrySource: 'deployment',
    chainName,
    genesisHash,
    explorerBlockUrlTemplate: V3_BLOCK_URL_TEMPLATE,
    error,
    at: now(),
  };
}

// ---- recorded anchors + contracts -----------------------------------------

export const RESILIENCE_ANCHOR_ID = 'anc-resilience-registry-167478';

export function anchorsOf(d: ReplayData): V3AnchorRecord[] {
  const out: V3AnchorRecord[] = [];
  for (const b of d.drills) {
    const a = b.anchor;
    if ((a.status === 'in-block' || a.status === 'finalized') && a.blockHash) {
      out.push({
        id: `anc-drill-${b.id}`,
        runId: b.run.id,
        runHash: b.certificate.runHash,
        method: 'remark',
        status: a.status === 'finalized' ? 'finalized' : 'in-block',
        payload: a.remark ?? `kaizen:certificate:v1:${b.certificate.fingerprint}`,
        contractAddress: null,
        signerAddress: a.signer ?? '',
        chainName: null,
        genesisHash: a.network?.genesisHash ?? null,
        txHash: a.txHash ?? null,
        blockHash: a.blockHash,
        blockNumber: a.blockNumber ?? null,
        extrinsicIndex: a.extrinsicIndex ?? null,
        error: null,
        requestedBy: 'drill-live workflow',
        createdAt: b.publishedAt,
        updatedAt: b.publishedAt,
      } as V3AnchorRecord);
    }
  }
  const cert = d.ciCertificate;
  out.push({
    id: RESILIENCE_ANCHOR_ID,
    runId: cert.runId,
    runHash: cert.runHash,
    method: 'contract',
    status: 'finalized',
    payload: `KaizenResilienceRegistry.anchor · certificate ${cert.fingerprint}`,
    contractAddress: RESILIENCE_REGISTRY.address,
    signerAddress: '',
    chainName: 'PortaldotV3 Test',
    genesisHash: V3_GENESIS,
    txHash: RESILIENCE_REGISTRY.anchor.tx,
    blockHash: RESILIENCE_REGISTRY.anchor.blockHash,
    blockNumber: RESILIENCE_REGISTRY.anchor.block,
    extrinsicIndex: null,
    error: null,
    requestedBy: 'CI Proof-of-Resilience run 40042905143',
    createdAt: cert.signedAt,
    updatedAt: cert.signedAt,
  } as V3AnchorRecord);
  out.push(...d.evidenceAnchors);
  return out.sort((x, y) => (y.blockNumber ?? -1) - (x.blockNumber ?? -1));
}

export function contractsOf(d: ReplayData): V3ContractRecord[] {
  const resilience = {
    address: RESILIENCE_REGISTRY.address,
    name: 'KaizenResilienceRegistry',
    codeHash: '',
    deployerAddress: '',
    chainName: 'PortaldotV3 Test',
    genesisHash: V3_GENESIS,
    txHash: RESILIENCE_REGISTRY.deploy.tx,
    blockHash: RESILIENCE_REGISTRY.deploy.blockHash,
    blockNumber: RESILIENCE_REGISTRY.deploy.block,
    createdAt: '',
  } as unknown as V3ContractRecord;
  return [resilience, ...d.evidenceContracts];
}

// ---- live verification ----------------------------------------------------

const utf8Hex = (s: string) => [...new TextEncoder().encode(s)].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Re-check one recorded anchor against the chain NOW: block hash at the
 * recorded height, the recorded extrinsic hash present in that block
 * (blake2b-256 of each extrinsic), the payload bytes inside it, the
 * registry's code via EVM RPC, and the run hash recomputed from the
 * committed run record when the repo has it.
 */
export async function verifyAnchorLive(fetchImpl: FetchLike, d: ReplayData, anchor: V3AnchorRecord): Promise<V3AnchorVerification> {
  const notes: string[] = [];
  const allRuns = [...d.drills.map((b) => b.run), ...d.evidenceRuns];
  const run = allRuns.find((r) => r.id === anchor.runId);
  const recomputed = run ? await runHashOf(run) : null;
  let hashMatches = recomputed !== null ? recomputed === anchor.runHash : false;
  if (recomputed !== null) notes.push(`run hash recomputed in your browser from the recorded run: ${recomputed === anchor.runHash ? 'matches' : 'DIFFERS'}`);
  else notes.push('run record not published (certificate only); checked the hashes inside the extrinsic instead');
  let blockHashMatches: boolean | null = null;
  let contractCodePresent: boolean | null = null;
  let unverifiable = false;
  let txFound: boolean | null = null;
  let payloadOk: boolean | null = null;
  try {
    if (anchor.blockNumber !== null) {
      const live = await rpc<string | null>(fetchImpl, V3_RPC, 'chain_getBlockHash', [anchor.blockNumber]);
      blockHashMatches = live !== null && live === anchor.blockHash;
      notes.push(`block #${anchor.blockNumber} hash re-read now: ${blockHashMatches ? 'matches' : 'DIFFERS'}`);
      const blk = await rpc<{ block: { extrinsics: string[] } } | null>(fetchImpl, V3_RPC, 'chain_getBlock', [live]);
      const xts = blk?.block.extrinsics ?? [];
      const hit = anchor.txHash ? xts.find((x) => extrinsicHash(x) === anchor.txHash!.toLowerCase()) : undefined;
      if (anchor.txHash) notes.push(`extrinsic ${anchor.txHash.slice(0, 12)}… ${hit ? 'found in the block (blake2b-256 recomputed)' : 'NOT found in the block'}`);
      if (anchor.txHash) txFound = Boolean(hit);
      const inTx = (needleHex: string) => (hit ? hit.toLowerCase().includes(needleHex) : xts.some((x) => x.toLowerCase().includes(needleHex)));
      if (anchor.method === 'remark') {
        payloadOk = inTx(utf8Hex(anchor.payload));
        notes.push(`remark payload ${payloadOk ? 'present' : 'NOT present'} in the extrinsic`);
        if (recomputed === null) hashMatches = payloadOk;
      } else if (anchor.id === RESILIENCE_ANCHOR_ID) {
        const fpIn = inTx(d.ciCertificate.fingerprint.slice(2).toLowerCase());
        const rhIn = inTx(anchor.runHash.slice(2).toLowerCase());
        payloadOk = fpIn && rhIn;
        notes.push(`certificate fingerprint ${fpIn ? 'present' : 'NOT present'} and run hash ${rhIn ? 'present' : 'NOT present'} in the call data`);
        if (recomputed === null) hashMatches = payloadOk;
      }
    }
    if (anchor.contractAddress) {
      const code = await rpc<string>(fetchImpl, V3_EVM_RPC, 'eth_getCode', [anchor.contractAddress, 'latest']);
      contractCodePresent = typeof code === 'string' && code.length > 2;
      notes.push(`registry ${anchor.contractAddress.slice(0, 10)}… code ${contractCodePresent ? 'present' : 'absent'} (eth_getCode now)`);
    }
  } catch (e) {
    unverifiable = true;
    notes.push(`V3 node unreachable from the browser: ${(e as Error).message}`);
  }
  const checks = [hashMatches, blockHashMatches, contractCodePresent, txFound, payloadOk].filter((x): x is boolean => x !== null);
  const verdict: V3AnchorVerification['verdict'] = unverifiable ? 'unverifiable' : checks.every(Boolean) ? 'verified' : 'mismatch';
  return {
    anchorId: anchor.id,
    runId: anchor.runId,
    recordedRunHash: anchor.runHash,
    recomputedRunHash: recomputed,
    hashMatches,
    onChainAnchoredAt: null,
    contractCodePresent,
    blockHashMatches,
    verdict,
    notes,
    at: now(),
  };
}
