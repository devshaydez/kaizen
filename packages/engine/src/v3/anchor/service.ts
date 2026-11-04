/**
 * V3AnchorService (T-8.2): anchors finished Failure Lab runs on the
 * Portaldot V3 TEST network and keeps the evidence in SQLite.
 *
 * Contract:
 *  - Only TERMINAL, executed runs are anchorable (completed,
 *    completed-with-warnings, failed, cancelled, cleanup-failed). A run's
 *    record is immutable once terminal, so its hash is stable.
 *  - Writes happen only on an explicit request (`anchorRun`,
 *    `deployRegistry`) — never automatically — because they spend real
 *    testnet funds from an operator-supplied key (DEC-026).
 *  - Method: `contract` (KaizenRunRegistry via pallet-revive) is the default
 *    whenever a registry is known (env `KAIZEN_V3_REGISTRY_ADDRESS` or a
 *    recorded deployment on this chain); otherwise the caller must deploy
 *    the registry or explicitly choose `remark` — there is no silent
 *    fallback (DEC-027).
 *  - The anchor row is persisted BEFORE submission; the chain's answer
 *    (tx hash, block, events) is what flips it to in-block/finalized. A
 *    submission whose expected evidence (RunAnchored log / Remarked event)
 *    is missing is recorded as `failed`, never as anchored.
 *  - The signer secret is read only from `KAIZEN_V3_SIGNER_SURI`; every
 *    message leaving this service is scrubbed of it.
 */

import { randomBytes } from 'node:crypto';
import { keccakAsHex } from '@polkadot/util-crypto';
import { KaizenError, isKaizenError } from '../../errors';
import type { EventBus } from '../../events/bus';
import { redactSecrets } from '../../fault/redact';
import { isReplayableScenarioRunState } from '../../scenario/run-types';
import type { StateStore } from '../../state/store';
import { redactEndpointUrl, resolveV3Config, type V3EndpointConfig } from '../config';
import { FetchJsonRpcTransport, type V3HttpJsonRpcTransport } from '../transports';
import {
  decodeRunAnchoredLog,
  decodeUintReturn,
  encodeAnchorCall,
  encodeAnchoredAtCall,
} from './abi';
import { PolkadotV3ChainConnector, type V3ChainConnector, type V3ChainSession, type V3SubmitOptions } from './chain';
import { computeRunHash, runAnchorMeta, remarkPayload, isBytes32Hex } from './canonical';
import { KAIZEN_RUN_REGISTRY_ARTIFACT } from './registry-artifact';
import { loadV3Signer, v3SignerConfigured, type V3Signer } from './signer';
import type {
  V3AnchorMethod,
  V3AnchorRecord,
  V3AnchorStatusReport,
  V3AnchorVerification,
  V3ContractRecord,
} from './types';

export const V3_REGISTRY_ENV_KEY = 'KAIZEN_V3_REGISTRY_ADDRESS';

export interface V3AnchorServiceOptions {
  store: StateStore;
  events: EventBus;
  /** Chain transport (default: real @polkadot/api connector). */
  connector?: V3ChainConnector;
  /** EVM JSON-RPC transport for `eth_getCode` verification. */
  evmRpc?: V3HttpJsonRpcTransport;
  /** Environment to read the signer/registry from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Endpoint overrides (default: resolveV3Config()). */
  config?: Partial<V3EndpointConfig>;
  submit?: Partial<V3SubmitOptions>;
  connectTimeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_SUBMIT: V3SubmitOptions = { inclusionTimeoutMs: 120_000, finalityTimeoutMs: 60_000 };

function isH160(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export class V3AnchorService {
  private readonly store: StateStore;
  private readonly events: EventBus;
  private readonly connector: V3ChainConnector;
  private readonly evmRpc: V3HttpJsonRpcTransport;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configOverrides: Partial<V3EndpointConfig>;
  private readonly submitOpts: V3SubmitOptions;
  private readonly connectTimeoutMs: number;
  private readonly now: () => Date;
  /** In-process guard against concurrent writes for the same run hash. */
  private readonly inFlight = new Set<string>();

  constructor(options: V3AnchorServiceOptions) {
    this.store = options.store;
    this.events = options.events;
    this.connector = options.connector ?? new PolkadotV3ChainConnector();
    this.evmRpc = options.evmRpc ?? new FetchJsonRpcTransport();
    this.env = options.env ?? process.env;
    this.configOverrides = options.config ?? {};
    this.submitOpts = { ...DEFAULT_SUBMIT, ...options.submit };
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20_000;
    this.now = options.now ?? (() => new Date());
  }

  private config(): V3EndpointConfig {
    return resolveV3Config(this.configOverrides);
  }

  private iso(): string {
    return this.now().toISOString();
  }

  /** polkadot-js apps (node console) block link template; `{block}` = hash. */
  explorerBlockUrlTemplate(): string {
    const cfg = this.config();
    return `${redactEndpointUrl(cfg.explorerUrl)}/?rpc=${encodeURIComponent(redactEndpointUrl(cfg.substrateWsUrl))}#/explorer/query/{block}`;
  }

  /** Env-configured registry (validated H160) or null. */
  private envRegistry(): string | null {
    const raw = this.env[V3_REGISTRY_ENV_KEY];
    if (raw === undefined || raw.trim() === '') return null;
    if (!isH160(raw.trim())) {
      throw new KaizenError('INVALID_INPUT', `${V3_REGISTRY_ENV_KEY} must be a 0x-prefixed 20-byte address`);
    }
    return raw.trim().toLowerCase();
  }

  /** Registry in effect for a chain: env override wins, then latest deployment. */
  registryFor(genesisHash: string | null): { address: string; source: 'env' | 'deployment' } | null {
    const fromEnv = this.envRegistry();
    if (fromEnv) return { address: fromEnv, source: 'env' };
    const deployments = this.store.listV3Contracts(genesisHash ? { genesisHash } : {});
    const latest = deployments[0];
    return latest ? { address: latest.address, source: 'deployment' } : null;
  }

  private async open(): Promise<V3ChainSession> {
    return this.connector.connect(this.config().substrateWsUrl, { connectTimeoutMs: this.connectTimeoutMs });
  }

  private clean(text: string, signer?: V3Signer): string {
    return redactSecrets(signer ? signer.scrub(text) : text);
  }

  /** Re-wrap any failure as a KaizenError whose message is secret-free. */
  private safeError(e: unknown, signer?: V3Signer): KaizenError {
    if (isKaizenError(e)) {
      return new KaizenError(e.code, this.clean(e.message, signer), e.details);
    }
    const message = e instanceof Error ? e.message : String(e);
    return new KaizenError('INTERNAL', this.clean(message, signer));
  }

  // ---------------------------------------------------------------------------
  // Read-only surface

  list(filter: { runId?: string; limit?: number } = {}): V3AnchorRecord[] {
    return this.store.listV3Anchors(filter);
  }

  get(anchorId: string): V3AnchorRecord {
    const record = this.store.tryGetV3Anchor(anchorId);
    if (!record) throw new KaizenError('V3_ANCHOR_NOT_FOUND', `No V3 anchor with id ${anchorId}`, { anchorId });
    return record;
  }

  contracts(): V3ContractRecord[] {
    return this.store.listV3Contracts();
  }

  /** Deterministic hash of a run as it is stored now (no chain access). */
  hashRun(runId: string): { runId: string; runHash: string; state: string; anchorable: boolean } {
    const run = this.store.getScenarioRun(runId);
    return {
      runId: run.id,
      runHash: computeRunHash(run),
      state: run.state,
      anchorable: isReplayableScenarioRunState(run.state),
    };
  }

  /**
   * Signer + registry + chain status. Never throws for chain trouble: an
   * unreachable endpoint is reported in `error` (credential-free).
   */
  async status(): Promise<V3AnchorStatusReport> {
    const report: V3AnchorStatusReport = {
      signer: {
        configured: v3SignerConfigured(this.env),
        address: null,
        evmAddress: null,
        freeBalance: null,
        tokenSymbol: null,
        tokenDecimals: null,
      },
      registryAddress: null,
      registrySource: null,
      chainName: null,
      genesisHash: null,
      explorerBlockUrlTemplate: this.explorerBlockUrlTemplate(),
      error: null,
      at: this.iso(),
    };
    let signer: V3Signer | undefined;
    try {
      if (report.signer.configured) {
        signer = await loadV3Signer(this.env);
        report.signer.address = signer.address;
      }
      const session = await this.open();
      try {
        const info = await session.info();
        report.chainName = info.chainName;
        report.genesisHash = info.genesisHash;
        report.signer.tokenSymbol = info.tokenSymbol;
        report.signer.tokenDecimals = info.tokenDecimals;
        if (signer) {
          report.signer.freeBalance = (await session.freeBalance(signer.address)).toString();
          report.signer.evmAddress = await session.evmAddressOf(signer.address).catch(() => null);
        }
      } finally {
        await session.close();
      }
    } catch (e) {
      report.error = this.clean(e instanceof Error ? e.message : String(e), signer);
    }
    try {
      const registry = this.registryFor(report.genesisHash);
      report.registryAddress = registry?.address ?? null;
      report.registrySource = registry?.source ?? null;
    } catch (e) {
      report.error = report.error ?? (e instanceof Error ? e.message : String(e));
    }
    return report;
  }

  // ---------------------------------------------------------------------------
  // Writes (explicit only)

  /** Deploy KaizenRunRegistry (EVM bytecode via revive.instantiateWithCode). */
  async deployRegistry(): Promise<V3ContractRecord> {
    const signer = await loadV3Signer(this.env);
    let session: V3ChainSession | undefined;
    try {
      session = await this.open();
      const info = await session.info();
      const free = await session.freeBalance(signer.address);
      if (free === 0n) {
        throw new KaizenError(
          'V3_INSUFFICIENT_FUNDS',
          `Signer ${signer.address} has 0 ${info.tokenSymbol} on ${info.chainName}; fund it before deploying.`,
          { address: signer.address },
        );
      }
      const receipt = await session.deployContract(signer.pair, KAIZEN_RUN_REGISTRY_ARTIFACT.bytecode, this.submitOpts);
      if (!receipt.instantiated) {
        throw new KaizenError(
          'V3_TX_FAILED',
          `Deployment tx ${receipt.txHash} was included in block ${receipt.blockHash} but no revive.Instantiated event was observed`,
          { txHash: receipt.txHash, blockHash: receipt.blockHash, events: receipt.events },
        );
      }
      const record: V3ContractRecord = {
        address: receipt.instantiated,
        name: 'KaizenRunRegistry',
        codeHash: keccakAsHex(KAIZEN_RUN_REGISTRY_ARTIFACT.bytecode, 256),
        deployerAddress: signer.address,
        chainName: info.chainName,
        genesisHash: info.genesisHash,
        txHash: receipt.txHash,
        blockHash: receipt.blockHash,
        blockNumber: receipt.blockNumber,
        createdAt: this.iso(),
      };
      this.store.insertV3Contract(record);
      this.events.emit('v3.contract', {
        address: record.address,
        txHash: record.txHash,
        blockNumber: record.blockNumber,
        at: record.createdAt,
      });
      return record;
    } catch (e) {
      throw this.safeError(e, signer);
    } finally {
      await session?.close();
    }
  }

  /**
   * Record an existing registry deployment from CHAIN EVIDENCE only (block
   * hash + extrinsic hash): the extrinsic must exist in that block, have
   * succeeded, and have emitted revive.Instantiated. Used to recover a
   * deployment whose local record was lost or never written. Read-only.
   */
  async importDeployment(blockHash: string, txHash: string): Promise<V3ContractRecord> {
    if (!isBytes32Hex(blockHash.toLowerCase()) || !isBytes32Hex(txHash.toLowerCase())) {
      throw new KaizenError('INVALID_INPUT', 'blockHash and txHash must be 0x-prefixed 32-byte hex');
    }
    const session = await this.open();
    try {
      const info = await session.info();
      const dep = await session.deploymentAt(blockHash.toLowerCase(), txHash.toLowerCase());
      if (!dep) {
        throw new KaizenError('V3_TX_FAILED', `Extrinsic ${txHash} was not found in block ${blockHash}`);
      }
      if (!dep.success || !dep.contract) {
        throw new KaizenError(
          'V3_TX_FAILED',
          `Extrinsic ${txHash} did not deploy a contract (events: ${dep.events.join(', ')})`,
        );
      }
      const record: V3ContractRecord = {
        address: dep.contract,
        name: 'KaizenRunRegistry',
        codeHash: keccakAsHex(KAIZEN_RUN_REGISTRY_ARTIFACT.bytecode, 256),
        deployerAddress: dep.signer,
        chainName: info.chainName,
        genesisHash: info.genesisHash,
        txHash: txHash.toLowerCase(),
        blockHash: blockHash.toLowerCase(),
        blockNumber: dep.blockNumber,
        createdAt: this.iso(),
      };
      this.store.insertV3Contract(record);
      this.events.emit('v3.contract', {
        address: record.address,
        txHash: record.txHash,
        blockNumber: record.blockNumber,
        at: record.createdAt,
      });
      return record;
    } finally {
      await session.close();
    }
  }

  /** Anchor a finished run's deterministic hash on the V3 test network. */
  async anchorRun(
    runId: string,
    options: { method?: V3AnchorMethod; requestedBy?: string } = {},
  ): Promise<V3AnchorRecord> {
    const run = this.store.getScenarioRun(runId);
    if (!isReplayableScenarioRunState(run.state)) {
      throw new KaizenError(
        'V3_RUN_NOT_ANCHORABLE',
        `Run ${run.id} is '${run.state}': only finished, executed runs can be anchored (completed, completed-with-warnings, failed, cancelled, cleanup-failed).`,
        { runId: run.id, state: run.state },
      );
    }
    const runHash = computeRunHash(run);
    if (!isBytes32Hex(runHash)) throw new KaizenError('INTERNAL', 'run hash is not 32 bytes');
    const signer = await loadV3Signer(this.env);

    if (this.inFlight.has(runHash)) {
      throw new KaizenError('V3_ALREADY_ANCHORED', `An anchor for run ${run.id} is already being submitted`, {
        runId: run.id,
        runHash,
      });
    }
    this.inFlight.add(runHash);
    let session: V3ChainSession | undefined;
    let record: V3AnchorRecord | undefined;
    try {
      session = await this.open();
      const info = await session.info();
      const registry = this.registryFor(info.genesisHash);
      const method: V3AnchorMethod | null = options.method ?? (registry ? 'contract' : null);
      if (method === null || (method === 'contract' && !registry)) {
        throw new KaizenError(
          'V3_REGISTRY_NOT_DEPLOYED',
          `No KaizenRunRegistry is known for ${info.chainName}. Deploy it (kaizen v3 deploy-registry), set ${V3_REGISTRY_ENV_KEY}, or explicitly choose the remark method.`,
          { chainName: info.chainName },
        );
      }
      const prior = this.store
        .listV3Anchors({ runHash, limit: 50 })
        .find(
          (a) =>
            a.method === method &&
            a.genesisHash === info.genesisHash &&
            (a.status === 'in-block' || a.status === 'finalized' || a.status === 'pending'),
        );
      if (prior) {
        throw new KaizenError(
          'V3_ALREADY_ANCHORED',
          `Run ${run.id} (hash ${runHash}) is already anchored via ${method}: anchor ${prior.id} (${prior.status}, tx ${prior.txHash ?? 'pending'})`,
          { anchorId: prior.id, runHash },
        );
      }
      const free = await session.freeBalance(signer.address);
      if (free === 0n) {
        throw new KaizenError(
          'V3_INSUFFICIENT_FUNDS',
          `Signer ${signer.address} has 0 ${info.tokenSymbol} on ${info.chainName}; fund it before anchoring.`,
          { address: signer.address },
        );
      }

      const contractAddress = method === 'contract' && registry ? registry.address : null;
      const payload = method === 'contract' ? runAnchorMeta(run) : remarkPayload(runHash, run.id);
      const at = this.iso();
      record = {
        id: `anc-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`,
        runId: run.id,
        runHash,
        method,
        status: 'pending',
        payload,
        contractAddress,
        signerAddress: signer.address,
        chainName: info.chainName,
        genesisHash: info.genesisHash,
        txHash: null,
        blockHash: null,
        blockNumber: null,
        extrinsicIndex: null,
        error: null,
        requestedBy: options.requestedBy ?? 'operator',
        createdAt: at,
        updatedAt: at,
      };
      this.store.insertV3Anchor(record);
      this.emit(record);

      const receipt =
        method === 'contract' && contractAddress
          ? await session.callContract(signer.pair, contractAddress, encodeAnchorCall(runHash, payload), this.submitOpts)
          : await session.submitRemark(signer.pair, payload, this.submitOpts);

      record.txHash = receipt.txHash;
      record.blockHash = receipt.blockHash;
      record.blockNumber = receipt.blockNumber >= 0 ? receipt.blockNumber : null;
      record.extrinsicIndex = receipt.extrinsicIndex >= 0 ? receipt.extrinsicIndex : null;

      const evidence =
        method === 'contract'
          ? receipt.logs.some((log) => {
              if (log.contract !== contractAddress) return false;
              const decoded = decodeRunAnchoredLog(log);
              return decoded !== null && decoded.runHash === runHash;
            })
          : receipt.events.includes('system.Remarked');
      if (evidence) {
        record.status = receipt.finalized ? 'finalized' : 'in-block';
      } else {
        record.status = 'failed';
        record.error =
          method === 'contract'
            ? `included in block but no RunAnchored(${runHash}) log from ${contractAddress} was observed (events: ${receipt.events.join(', ')})`
            : `included in block but no system.Remarked event was observed (events: ${receipt.events.join(', ')})`;
      }
      record.updatedAt = this.iso();
      this.store.updateV3Anchor(record);
      this.emit(record);
      return record;
    } catch (e) {
      if (record) {
        const message = this.clean(e instanceof Error ? e.message : String(e), signer);
        record.status = 'failed';
        record.error = message;
        const details = isKaizenError(e) ? e.details : undefined;
        if (!record.txHash && typeof details?.['txHash'] === 'string') record.txHash = details['txHash'];
        if (!record.blockHash && typeof details?.['blockHash'] === 'string') record.blockHash = details['blockHash'];
        record.updatedAt = this.iso();
        try {
          this.store.updateV3Anchor(record);
          this.emit(record);
        } catch {
          /* store closed during shutdown */
        }
      }
      throw this.safeError(e, signer);
    } finally {
      this.inFlight.delete(runHash);
      await session?.close();
    }
  }

  /**
   * Re-verify an anchor: recompute the run hash from SQLite, re-read the
   * block hash at the recorded height, and (contract method) read
   * `anchoredAt(runHash)` from the registry plus `eth_getCode` from the
   * EVM RPC; (remark method) re-read the remark text from the block.
   */
  async verify(anchorId: string): Promise<V3AnchorVerification> {
    const anchor = this.get(anchorId);
    const notes: string[] = [];
    const result: V3AnchorVerification = {
      anchorId,
      runId: anchor.runId,
      recordedRunHash: anchor.runHash,
      recomputedRunHash: null,
      hashMatches: false,
      onChainAnchoredAt: null,
      contractCodePresent: null,
      blockHashMatches: null,
      evmChainId: null,
      chainIdMatches: null,
      contractAddressMatches: null,
      txHashMatches: null,
      txSucceeded: null,
      onChainRecordMatches: null,
      verdict: 'unverifiable',
      notes,
      at: this.iso(),
    };
    const run = this.store.tryGetScenarioRun(anchor.runId);
    if (run) {
      result.recomputedRunHash = computeRunHash(run);
      result.hashMatches = result.recomputedRunHash === anchor.runHash;
    } else {
      notes.push('run record is no longer in this data directory; hash cannot be recomputed');
    }
    if (anchor.status !== 'in-block' && anchor.status !== 'finalized') {
      notes.push(`anchor status is '${anchor.status}': nothing on chain to verify`);
      result.verdict = result.hashMatches ? 'unverifiable' : 'mismatch';
      return result;
    }
    let chainOk = true;
    let session: V3ChainSession | undefined;
    try {
      session = await this.open();
      const info = await session.info();
      if (anchor.genesisHash && info.genesisHash !== anchor.genesisHash) {
        notes.push('connected chain genesis differs from the anchor\'s chain');
        chainOk = false;
      }

      // EVM chain identity: a matching block hash on a different EVM chain is
      // not the chain the anchor claims.
      result.evmChainId = await this.evmChainId(notes);
      if (result.evmChainId === null) {
        notes.push('EVM chain id could not be read: chain identity is only partially checked');
      } else {
        result.chainIdMatches = result.evmChainId === this.config().expectedEvmChainId;
        if (!result.chainIdMatches) {
          notes.push(
            `EVM chain id ${result.evmChainId} does not match the configured expected chain id ${this.config().expectedEvmChainId}`,
          );
          chainOk = false;
        }
      }

      if (anchor.blockNumber !== null && anchor.blockHash) {
        const at = await session.blockHashAt(anchor.blockNumber);
        result.blockHashMatches = at === anchor.blockHash;
        if (!result.blockHashMatches) chainOk = false;
      }

      if (anchor.method === 'contract') {
        if (!anchor.contractAddress || !isH160(anchor.contractAddress)) {
          result.contractAddressMatches = false;
          notes.push('recorded contract address is not a 20-byte H160');
          chainOk = false;
        } else {
          const current = this.registryFor(info.genesisHash);
          const recordedDeployment = this.store
            .listV3Contracts(anchor.genesisHash ? { genesisHash: anchor.genesisHash } : {})
            .some((c) => c.address.toLowerCase() === anchor.contractAddress!.toLowerCase());
          result.contractAddressMatches =
            (current?.address.toLowerCase() === anchor.contractAddress.toLowerCase()) || recordedDeployment;
          if (!result.contractAddressMatches) {
            notes.push(
              'recorded contract address is neither the registry in effect nor a recorded deployment for this chain',
            );
            chainOk = false;
          }
          const data = await session.readContract(
            anchor.signerAddress,
            anchor.contractAddress,
            encodeAnchoredAtCall(anchor.runHash),
          );
          const ts = Number(decodeUintReturn(data));
          result.onChainAnchoredAt = ts;
          result.onChainRecordMatches = ts > 0;
          if (ts === 0) {
            notes.push('registry reports this run hash as NOT anchored');
            chainOk = false;
          }
          result.contractCodePresent = await this.codePresent(anchor.contractAddress, notes);
          if (result.contractCodePresent === false) chainOk = false;
        }
      }

      // Transaction receipt: the recorded hash must exist in the recorded
      // block, have succeeded, and (contract method) carry a RunAnchored log
      // for exactly this run hash.
      if (anchor.txHash && anchor.blockHash) {
        if (!session.extrinsicAt) {
          notes.push('transaction receipt not checked: this chain session does not expose extrinsicAt');
        } else {
          const found = await session.extrinsicAt(anchor.blockHash, anchor.txHash);
          result.txHashMatches = found !== null;
          if (!found) {
            notes.push('recorded transaction was not found in the recorded block');
            chainOk = false;
          } else {
            result.txSucceeded = found.success;
            if (!found.success) {
              notes.push('recorded transaction did not report system.ExtrinsicSuccess');
              chainOk = false;
            }
            if (anchor.method === 'contract' && anchor.contractAddress && found.logs.length > 0) {
              const matching = found.logs.some((log) => {
                if (log.contract !== anchor.contractAddress!.toLowerCase()) return false;
                const decoded = decodeRunAnchoredLog(log);
                return decoded !== null && decoded.runHash === anchor.runHash;
              });
              result.onChainRecordMatches = (result.onChainRecordMatches !== false) && matching;
              if (!matching) {
                notes.push('transaction logs do not contain RunAnchored for this run hash');
                chainOk = false;
              }
            }
          }
        }
      }

      if (anchor.method === 'remark' && anchor.blockHash && anchor.extrinsicIndex !== null) {
        const text = await session.remarkAt(anchor.blockHash, anchor.extrinsicIndex);
        result.onChainRecordMatches = text === anchor.payload;
        if (text !== anchor.payload) {
          notes.push('remark text in the block does not match the recorded payload');
          chainOk = false;
        }
      }
    } catch (e) {
      notes.push(`chain verification incomplete: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      result.verdict = 'unverifiable';
      return result;
    } finally {
      await session?.close();
    }
    result.verdict = result.hashMatches && chainOk ? 'verified' : 'mismatch';
    return result;
  }

  /** EVM `eth_chainId`; null (with a note) when the RPC cannot answer. */
  private async evmChainId(notes: string[]): Promise<number | null> {
    try {
      const res = await this.evmRpc.post({
        url: this.config().evmRpcUrl,
        method: 'eth_chainId',
        params: [],
        timeoutMs: 15_000,
        id: 1,
      });
      const json = res.json as { result?: unknown } | null;
      if (res.httpStatus !== 200 || typeof json?.result !== 'string') {
        notes.push('EVM RPC eth_chainId gave no usable result');
        return null;
      }
      const id = Number.parseInt(json.result, 16);
      if (!Number.isSafeInteger(id)) {
        notes.push('EVM RPC eth_chainId returned a malformed value');
        return null;
      }
      return id;
    } catch (e) {
      notes.push(`EVM RPC eth_chainId failed: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      return null;
    }
  }

  private async codePresent(address: string, notes: string[]): Promise<boolean | null> {
    try {
      const res = await this.evmRpc.post({
        url: this.config().evmRpcUrl,
        method: 'eth_getCode',
        params: [address, 'latest'],
        timeoutMs: 15_000,
        id: 1,
      });
      const json = res.json as { result?: unknown } | null;
      if (res.httpStatus !== 200 || typeof json?.result !== 'string') {
        notes.push('EVM RPC eth_getCode gave no usable result');
        return null;
      }
      return json.result.length > 2 && !/^0x0*$/.test(json.result);
    } catch (e) {
      notes.push(`EVM RPC eth_getCode failed: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
      return null;
    }
  }

  private emit(record: V3AnchorRecord): void {
    this.events.emit('v3.anchor', {
      anchorId: record.id,
      runId: record.runId,
      runHash: record.runHash,
      method: record.method,
      status: record.status,
      txHash: record.txHash,
      blockNumber: record.blockNumber,
      contractAddress: record.contractAddress,
      error: record.error,
      at: record.updatedAt,
    });
  }
}
