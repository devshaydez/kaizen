/**
 * V3 chain I/O for anchoring (T-8.2): the pluggable transport behind
 * `V3AnchorService`. The service depends only on `V3ChainConnector` /
 * `V3ChainSession`, so unit tests inject fakes; `PolkadotV3ChainConnector`
 * is the real implementation over @polkadot/api (DEC-001) against the
 * Portaldot V3 Substrate endpoint.
 *
 * Verified runtime facts this relies on (live, 2026-10-21, R-30):
 *  - spec `portaldot-v3` 3002, token tPOT, 14 decimals, ss58 42
 *  - `pallet-revive` present: `revive.instantiateWithCode` / `revive.call`,
 *    `allowEVMBytecode = true` (solc EVM bytecode is accepted — no PolkaVM
 *    toolchain needed), `autoMap = true` (no explicit `map_account` needed
 *    for an sr25519 origin; we still map explicitly when a dry-run says
 *    `AccountUnmapped`)
 *  - `system.remarkWithEvent` present (fallback path)
 *
 * Every write is preceded by a runtime-API dry run (`reviveApi.instantiate`
 * / `reviveApi.call`) so funding and contract errors are reported BEFORE a
 * fee is spent; the dry run also sizes the storage-deposit limit.
 */

import { ApiPromise, WsProvider } from '@polkadot/api';
import type { SubmittableExtrinsic } from '@polkadot/api/types';
import type { EventRecord } from '@polkadot/types/interfaces';
import type { KeyringPair } from '@polkadot/keyring/types';
import { KaizenError } from '../../errors';
import type { RegistryLog } from './abi';

export interface V3ChainInfo {
  chainName: string;
  genesisHash: string;
  specName: string;
  specVersion: number;
  tokenSymbol: string;
  tokenDecimals: number;
  bestNumber: number;
}

export interface V3TxReceipt {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  extrinsicIndex: number;
  finalized: boolean;
  /** `section.method` of every event attributed to the extrinsic. */
  events: string[];
  /** EVM logs emitted by contracts during the extrinsic (revive.ContractEmitted). */
  logs: RegistryLog[];
  /** revive.Instantiated contract address, when the extrinsic deployed one. */
  instantiated: string | null;
  /** system.Remarked hash when present. */
  remarkHash: string | null;
}

export interface V3SubmitOptions {
  /** Max wait for block inclusion. */
  inclusionTimeoutMs: number;
  /** Extra wait for finality after inclusion (not reaching it ≠ failure). */
  finalityTimeoutMs: number;
}

export interface V3ChainSession {
  info(): Promise<V3ChainInfo>;
  freeBalance(address: string): Promise<bigint>;
  /** H160 the revive pallet maps an account to. */
  evmAddressOf(address: string): Promise<string>;
  /** Block hash at a height (null when unknown). */
  blockHashAt(blockNumber: number): Promise<string | null>;
  submitRemark(signer: KeyringPair, payload: string, opts: V3SubmitOptions): Promise<V3TxReceipt>;
  deployContract(signer: KeyringPair, initCode: string, opts: V3SubmitOptions): Promise<V3TxReceipt>;
  callContract(signer: KeyringPair, contract: string, calldata: string, opts: V3SubmitOptions): Promise<V3TxReceipt>;
  /**
   * Re-read a past deployment from chain evidence: the extrinsic (by hash)
   * in the given block, its signer, success, and revive.Instantiated address.
   */
  deploymentAt(blockHash: string, txHash: string): Promise<{
    contract: string | null;
    signer: string;
    blockNumber: number;
    success: boolean;
    events: string[];
  } | null>;
  /**
   * Read a past extrinsic (by hash) from a block: success, events and EVM
   * logs. Optional so scripted sessions written before T-9.7D still satisfy
   * the interface; its absence is reported as "receipt not checked".
   */
  extrinsicAt?(blockHash: string, txHash: string): Promise<{
    signer: string;
    blockNumber: number;
    success: boolean;
    events: string[];
    logs: RegistryLog[];
    remarkHash: string | null;
    instantiated: string | null;
  } | null>;
  /** Text of a `system.remark*` extrinsic at (block, index); null when absent. */
  remarkAt(blockHash: string, extrinsicIndex: number): Promise<string | null>;
  /** Read-only contract call (runtime-API dry run); returns return data hex. */
  readContract(origin: string, contract: string, calldata: string): Promise<string>;
  close(): Promise<void>;
}

export interface V3ChainConnector {
  connect(wsUrl: string, opts: { connectTimeoutMs: number }): Promise<V3ChainSession>;
}

// ---------------------------------------------------------------------------
// Real implementation

const WEIGHT_FLOOR = { refTime: 50_000_000_000n, proofSize: 5_000_000n };

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new KaizenError('RPC_TIMEOUT', `${what} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/*
 * @polkadot/api ships augmented types for Polkadot/Kusama only; the V3
 * runtime's revive pallet, runtime API, and constants are decorated from
 * live metadata at runtime. This facade types exactly the members used
 * here (verified against the live V3 metadata, R-30) instead of `any`.
 */
interface BigLike {
  toBigInt(): bigint;
}
interface WeightLike {
  refTime: BigLike;
  proofSize: BigLike;
}
/** ReturnFlags is `{ bits: u32 }` on this runtime (observed live); older
 *  shapes expose the number directly. */
type ReturnFlagsLike = { bits?: { toNumber(): number }; toNumber?: () => number };
function flagBits(flags: ReturnFlagsLike): number {
  if (flags.bits) return flags.bits.toNumber();
  return flags.toNumber ? flags.toNumber() : 0;
}
interface DispatchErrorLike {
  isModule: boolean;
  asModule: unknown;
  toString(): string;
}
interface ReviveDryRun {
  result: {
    isErr: boolean;
    asErr: DispatchErrorLike;
    asOk: { flags: ReturnFlagsLike; data: { toHex(): string } };
  };
  weightRequired: WeightLike;
  storageDeposit: { isCharge: boolean; asCharge: BigLike };
}
type Extrinsic = SubmittableExtrinsic<'promise'>;
interface V3RuntimeFacade {
  call: {
    reviveApi: {
      address(account: string): Promise<{ toHex(): string }>;
      instantiate(...args: unknown[]): Promise<ReviveDryRun>;
      call(...args: unknown[]): Promise<ReviveDryRun>;
    };
  };
  query: {
    system: { account(address: string): Promise<{ data: { free: { toString(): string } } }> };
    revive: { originalAccount(h160: unknown): Promise<{ isEmpty: boolean }> };
  };
  tx: {
    system: { remarkWithEvent(payload: string): Extrinsic };
    revive: {
      mapAccount(): Extrinsic;
      instantiateWithCode(...args: unknown[]): Extrinsic;
      call(...args: unknown[]): Extrinsic;
    };
  };
  consts: {
    system: { blockWeights: { perClass: { normal: { maxExtrinsic: { unwrapOrDefault(): WeightLike } } } } };
    revive: { autoMap?: { isTrue: boolean } };
  };
}

class PolkadotV3ChainSession implements V3ChainSession {
  private readonly rt: V3RuntimeFacade;

  constructor(private readonly api: ApiPromise) {
    this.rt = api as unknown as V3RuntimeFacade;
  }

  async info(): Promise<V3ChainInfo> {
    const [chain, props, header] = await Promise.all([
      this.api.rpc.system.chain(),
      this.api.rpc.system.properties(),
      this.api.rpc.chain.getHeader(),
    ]);
    const symbols = props.tokenSymbol.unwrapOr(null);
    const decimals = props.tokenDecimals.unwrapOr(null);
    return {
      chainName: chain.toString(),
      genesisHash: this.api.genesisHash.toHex(),
      specName: this.api.runtimeVersion.specName.toString(),
      specVersion: this.api.runtimeVersion.specVersion.toNumber(),
      tokenSymbol: symbols?.[0]?.toString() ?? 'UNIT',
      tokenDecimals: decimals?.[0]?.toNumber() ?? 12,
      bestNumber: header.number.toNumber(),
    };
  }

  async freeBalance(address: string): Promise<bigint> {
    const account = await this.rt.query.system.account(address);
    return BigInt(account.data.free.toString());
  }

  async evmAddressOf(address: string): Promise<string> {
    const h160 = await this.rt.call.reviveApi.address(address);
    return h160.toHex().toLowerCase();
  }

  async blockHashAt(blockNumber: number): Promise<string | null> {
    const hash = await this.api.rpc.chain.getBlockHash(blockNumber);
    const hex = hash.toHex();
    return /^0x0+$/.test(hex) ? null : hex;
  }

  private moduleErrorName(err: DispatchErrorLike): string | null {
    if (!err.isModule) return null;
    try {
      const meta = this.api.registry.findMetaError(err.asModule as Parameters<typeof this.api.registry.findMetaError>[0]);
      return `${meta.section}.${meta.name}`;
    } catch {
      return null;
    }
  }

  private dryRunFailure(result: ReviveDryRun['result'], what: string): KaizenError {
    const name = this.moduleErrorName(result.asErr);
    const text = name ?? result.asErr.toString();
    if (name === 'revive.StorageDepositNotEnoughFunds' || name === 'balances.InsufficientBalance' || /Funds|Balance/i.test(text)) {
      return new KaizenError('V3_INSUFFICIENT_FUNDS', `${what} dry run: signer cannot pay (${text}). Fund the signer with tPOT.`, {
        dispatchError: text,
      });
    }
    return new KaizenError('V3_TX_FAILED', `${what} dry run failed: ${text}`, { dispatchError: text });
  }

  private weightLimit(required: WeightLike): {
    refTime: bigint;
    proofSize: bigint;
  } {
    const max = this.rt.consts.system.blockWeights.perClass.normal.maxExtrinsic.unwrapOrDefault();
    const capRef = max.refTime.toBigInt() / 2n;
    const capProof = max.proofSize.toBigInt() / 2n;
    const ref = required.refTime.toBigInt() * 10n;
    const proof = required.proofSize.toBigInt() * 10n;
    const pick = (v: bigint, floor: bigint, cap: bigint) => (v < floor ? floor : v > cap ? cap : v);
    return {
      refTime: pick(ref, WEIGHT_FLOOR.refTime, capRef),
      proofSize: pick(proof, WEIGHT_FLOOR.proofSize, capProof > 0n ? capProof : WEIGHT_FLOOR.proofSize * 10n),
    };
  }

  /**
   * Dry-run charge + 2% + 0.01 unit headroom. The dry run is deterministic
   * for the same code/state, so a small margin suffices; a large margin
   * could exceed the signer's free balance (the limit must be payable).
   */
  private depositLimit(deposit: ReviveDryRun['storageDeposit']): bigint {
    const charge = deposit.isCharge ? deposit.asCharge.toBigInt() : 0n;
    return charge + charge / 50n + 1_000_000_000_000n;
  }

  private async ensureMapped(signer: KeyringPair, opts: V3SubmitOptions): Promise<void> {
    const h160 = await this.rt.call.reviveApi.address(signer.address);
    const original = await this.rt.query.revive.originalAccount(h160);
    if (!original.isEmpty) return;
    if (this.rt.consts.revive.autoMap?.isTrue) return; // runtime maps on first use
    await this.submit(this.rt.tx.revive.mapAccount(), signer, opts, 'revive.mapAccount');
  }

  async submitRemark(signer: KeyringPair, payload: string, opts: V3SubmitOptions): Promise<V3TxReceipt> {
    return this.submit(this.rt.tx.system.remarkWithEvent(payload), signer, opts, 'system.remarkWithEvent');
  }

  async deployContract(signer: KeyringPair, initCode: string, opts: V3SubmitOptions): Promise<V3TxReceipt> {
    await this.ensureMapped(signer, opts);
    const dry = await this.rt.call.reviveApi.instantiate(signer.address, 0, null, null, { Upload: initCode }, '0x', null);
    if (dry.result.isErr) throw this.dryRunFailure(dry.result, 'instantiate');
    const tx = this.rt.tx.revive.instantiateWithCode(
      0,
      this.weightLimit(dry.weightRequired),
      this.depositLimit(dry.storageDeposit),
      initCode,
      '0x',
      null,
    );
    return this.submit(tx, signer, opts, 'revive.instantiateWithCode');
  }

  async callContract(signer: KeyringPair, contract: string, calldata: string, opts: V3SubmitOptions): Promise<V3TxReceipt> {
    await this.ensureMapped(signer, opts);
    const dry = await this.rt.call.reviveApi.call(signer.address, contract, 0, null, null, calldata);
    if (dry.result.isErr) throw this.dryRunFailure(dry.result, 'contract call');
    const ok = dry.result.asOk;
    if (flagBits(ok.flags) & 1) {
      // REVERT flag: the contract refused (e.g. "already anchored").
      throw new KaizenError('V3_TX_FAILED', `contract call dry run reverted (data ${ok.data.toHex().slice(0, 266)})`, {
        reverted: true,
      });
    }
    const tx = this.rt.tx.revive.call(
      contract,
      0,
      this.weightLimit(dry.weightRequired),
      this.depositLimit(dry.storageDeposit),
      calldata,
    );
    return this.submit(tx, signer, opts, 'revive.call');
  }

  async extrinsicAt(blockHash: string, txHash: string): Promise<{
    signer: string;
    blockNumber: number;
    success: boolean;
    events: string[];
    logs: RegistryLog[];
    remarkHash: string | null;
    instantiated: string | null;
  } | null> {
    const signed = await this.api.rpc.chain.getBlock(blockHash);
    const idx = signed.block.extrinsics.findIndex((e) => e.hash.toHex() === txHash);
    const ext = signed.block.extrinsics[idx];
    if (idx < 0 || !ext) return null;
    const at = (await this.api.at(blockHash)) as unknown as {
      query: { system: { events(): Promise<unknown> } };
    };
    const all = (await at.query.system.events()) as EventRecord[];
    const mine = all.filter((e) => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.toNumber() === idx);
    const extracted = this.extract(mine);
    return {
      signer: ext.signer.toString(),
      blockNumber: signed.block.header.number.toNumber(),
      success: extracted.events.includes('system.ExtrinsicSuccess'),
      events: extracted.events,
      logs: extracted.logs,
      remarkHash: extracted.remarkHash,
      instantiated: extracted.instantiated,
    };
  }

  async deploymentAt(blockHash: string, txHash: string): Promise<{
    contract: string | null;
    signer: string;
    blockNumber: number;
    success: boolean;
    events: string[];
  } | null> {
    const found = await this.extrinsicAt(blockHash, txHash);
    if (!found) return null;
    return {
      contract: found.instantiated,
      signer: found.signer,
      blockNumber: found.blockNumber,
      success: found.success,
      events: found.events,
    };
  }

  async remarkAt(blockHash: string, extrinsicIndex: number): Promise<string | null> {
    const signed = await this.api.rpc.chain.getBlock(blockHash);
    const ext = signed.block.extrinsics[extrinsicIndex];
    if (!ext) return null;
    const { section, method } = ext.method;
    if (section !== 'system' || (method !== 'remarkWithEvent' && method !== 'remark')) return null;
    const arg = ext.method.args[0] as unknown as { toU8a(isBare: boolean): Uint8Array } | undefined;
    return arg ? Buffer.from(arg.toU8a(true)).toString('utf8') : null;
  }

  async readContract(origin: string, contract: string, calldata: string): Promise<string> {
    const dry = await this.rt.call.reviveApi.call(origin, contract, 0, null, null, calldata);
    if (dry.result.isErr) throw this.dryRunFailure(dry.result, 'contract read');
    const ok = dry.result.asOk;
    if (flagBits(ok.flags) & 1) throw new KaizenError('V3_TX_FAILED', 'contract read reverted');
    return ok.data.toHex();
  }

  private submit(
    tx: SubmittableExtrinsic<'promise'>,
    signer: KeyringPair,
    opts: V3SubmitOptions,
    what: string,
  ): Promise<V3TxReceipt> {
    return new Promise<V3TxReceipt>((resolve, reject) => {
      let settled = false;
      let unsub: (() => void) | null = null;
      let receipt: V3TxReceipt | null = null;
      let finalityTimer: NodeJS.Timeout | undefined;
      let headerDone = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(inclusionTimer);
        if (finalityTimer) clearTimeout(finalityTimer);
        try {
          unsub?.();
        } catch {
          /* already unsubscribed */
        }
        fn();
      };
      const inclusionTimer = setTimeout(
        () =>
          finish(() =>
            reject(
              new KaizenError('RPC_TIMEOUT', `${what}: not included within ${opts.inclusionTimeoutMs}ms`, {
                txHash: tx.hash.toHex(),
              }),
            ),
          ),
        opts.inclusionTimeoutMs,
      );

      tx.signAndSend(signer, (result) => {
        const { status, events, dispatchError } = result;
        if (status.isInvalid || status.isDropped || status.isUsurped) {
          finish(() => reject(new KaizenError('V3_TX_FAILED', `${what}: transaction ${status.type.toLowerCase()}`)));
          return;
        }
        if ((status.isInBlock || status.isFinalized) && !receipt) {
          const blockHash = (status.isInBlock ? status.asInBlock : status.asFinalized).toHex();
          if (dispatchError) {
            const name = this.moduleErrorName(dispatchError) ?? dispatchError.toString();
            finish(() =>
              reject(
                new KaizenError('V3_TX_FAILED', `${what}: dispatch failed in block ${blockHash} (${name})`, {
                  txHash: tx.hash.toHex(),
                  blockHash,
                  dispatchError: name,
                }),
              ),
            );
            return;
          }
          const extrinsicIndex = (result as unknown as { txIndex?: number }).txIndex ?? this.indexFromEvents(events);
          receipt = {
            txHash: tx.hash.toHex(),
            blockHash,
            blockNumber: -1,
            extrinsicIndex: extrinsicIndex ?? -1,
            finalized: status.isFinalized,
            ...this.extract(events),
          };
          const r = receipt;
          void this.api.rpc.chain
            .getHeader(blockHash)
            .then((h) => {
              r.blockNumber = h.number.toNumber();
            })
            .catch(() => undefined)
            .finally(() => {
              headerDone = true;
              if (r.finalized) {
                finish(() => resolve(r));
                return;
              }
              clearTimeout(inclusionTimer);
              finalityTimer = setTimeout(() => finish(() => resolve(r)), opts.finalityTimeoutMs);
            });
          return;
        }
        if (status.isFinalized && receipt) {
          const r = receipt;
          r.finalized = true;
          // Wait for the header lookup to land (bounded) before resolving.
          const settle = (): void => {
            if (settled) return;
            if (headerDone) finish(() => resolve(r));
            else setTimeout(settle, 100);
          };
          settle();
        }
      })
        .then((u) => {
          unsub = u;
          if (settled) u();
        })
        .catch((e: unknown) => {
          const msg = messageOf(e);
          const code = /balance|funds|payment/i.test(msg) ? 'V3_INSUFFICIENT_FUNDS' : 'V3_TX_FAILED';
          finish(() => reject(new KaizenError(code, `${what}: submission rejected (${msg})`)));
        });
    });
  }

  private indexFromEvents(events: EventRecord[]): number | null {
    for (const e of events) if (e.phase.isApplyExtrinsic) return e.phase.asApplyExtrinsic.toNumber();
    return null;
  }

  private extract(events: EventRecord[]): Pick<V3TxReceipt, 'events' | 'logs' | 'instantiated' | 'remarkHash'> {
    const names: string[] = [];
    const logs: RegistryLog[] = [];
    let instantiated: string | null = null;
    let remarkHash: string | null = null;
    for (const { event } of events) {
      names.push(`${event.section}.${event.method}`);
      // Event data serializes positionally on the V3 runtime (observed live:
      // revive.Instantiated -> [deployer, contract]); accept named shapes too.
      const raw = (event.data as unknown as { toJSON(): unknown }).toJSON();
      const field = (name: string, index: number): unknown =>
        Array.isArray(raw) ? raw[index] : (raw as Record<string, unknown> | null)?.[name];
      if (event.section === 'revive' && event.method === 'ContractEmitted') {
        const topics = field('topics', 2);
        logs.push({
          contract: String(field('contract', 0) ?? '').toLowerCase(),
          data: String(field('data', 1) ?? '0x'),
          topics: (Array.isArray(topics) ? topics : []).map((t) => String(t).toLowerCase()),
        });
      }
      if (event.section === 'revive' && event.method === 'Instantiated') {
        const contract = field('contract', 1);
        instantiated = contract ? String(contract).toLowerCase() : null;
      }
      if (event.section === 'system' && event.method === 'Remarked') {
        const hash = field('hash_', 1) ?? field('hash', 1);
        remarkHash = hash ? String(hash) : null;
      }
    }
    return { events: names, logs, instantiated, remarkHash };
  }

  async close(): Promise<void> {
    await this.api.disconnect().catch(() => undefined);
  }
}

export class PolkadotV3ChainConnector implements V3ChainConnector {
  async connect(wsUrl: string, opts: { connectTimeoutMs: number }): Promise<V3ChainSession> {
    const provider = new WsProvider(wsUrl, false);
    try {
      await withDeadline(provider.connect(), opts.connectTimeoutMs, 'V3 websocket connect');
      const api = await withDeadline(
        ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
        opts.connectTimeoutMs,
        'V3 API init',
      );
      return new PolkadotV3ChainSession(api);
    } catch (e) {
      await provider.disconnect().catch(() => undefined);
      if (e instanceof KaizenError) throw e;
      throw new KaizenError('RPC_CONNECTION_FAILED', `V3 connect failed: ${messageOf(e)}`);
    }
  }
}
