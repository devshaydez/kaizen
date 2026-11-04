/**
 * V3 run-anchoring model (T-8.2).
 *
 * An anchor is a durable record that a specific Kaizen scenario run (by its
 * deterministic run hash) was written to the Portaldot V3 TEST network —
 * with the transaction hash, block, and (for the contract method) the
 * registry address as evidence. Records are persisted BEFORE submission
 * (`pending`) and updated with what the chain actually reported; a
 * submission that never reached a block is recorded as `failed`, never as
 * anchored.
 */

/**
 * - `contract` — KaizenRunRegistry.anchor(runHash, meta) via pallet-revive
 *                (`revive.call`); evidence = RunAnchored event log
 * - `remark`   — `system.remarkWithEvent("kaizen:v1:<runHash>:<runId>")`;
 *                evidence = `system.Remarked` event (DEC-027 fallback)
 */
export type V3AnchorMethod = 'contract' | 'remark';

/**
 * - `pending`   — persisted, not yet submitted / not yet in a block
 * - `in-block`  — included in a block; finality not observed in the bound
 * - `finalized` — included in a GRANDPA-finalized block
 * - `failed`    — never included, or included with a dispatch failure
 */
export type V3AnchorStatus = 'pending' | 'in-block' | 'finalized' | 'failed';

export interface V3AnchorRecord {
  id: string;
  runId: string;
  /** 0x + SHA-256 of the canonical run document (computeRunHash). */
  runHash: string;
  method: V3AnchorMethod;
  status: V3AnchorStatus;
  /** On-chain descriptor (contract meta) or remark payload. */
  payload: string;
  /** Registry H160 for the contract method; null for remark. */
  contractAddress: string | null;
  /** SS58 address of the signer (public; never the secret). */
  signerAddress: string;
  chainName: string | null;
  genesisHash: string | null;
  /** Extrinsic hash (0x…); null until submitted. */
  txHash: string | null;
  blockHash: string | null;
  blockNumber: number | null;
  extrinsicIndex: number | null;
  /** Sanitized failure explanation for `failed` anchors. */
  error: string | null;
  requestedBy: string;
  createdAt: string;
  updatedAt: string;
}

/** A registry contract deployment observed on chain. */
export interface V3ContractRecord {
  /** H160 contract address (lowercase 0x hex). */
  address: string;
  name: 'KaizenRunRegistry';
  /** keccak/sha of the deployed init code for provenance. */
  codeHash: string;
  deployerAddress: string;
  chainName: string;
  genesisHash: string;
  txHash: string;
  blockHash: string;
  blockNumber: number;
  createdAt: string;
}

export interface V3AnchorVerification {
  anchorId: string;
  runId: string;
  recordedRunHash: string;
  /** Hash recomputed now from the run record in SQLite. */
  recomputedRunHash: string | null;
  hashMatches: boolean;
  /** Contract method: registry `anchoredAt(runHash)` read on chain (unix s). */
  onChainAnchoredAt: number | null;
  /** Contract method: EVM RPC `eth_getCode` non-empty for the registry. */
  contractCodePresent: boolean | null;
  /** Block hash re-read from the chain at the recorded block number. */
  blockHashMatches: boolean | null;
  /** EVM chain id read from the configured EVM RPC (null when unreadable). */
  evmChainId: number | null;
  /** `evmChainId` equals the configured expected chain id. */
  chainIdMatches: boolean | null;
  /** Recorded contract address is a valid H160 and has recorded provenance. */
  contractAddressMatches: boolean | null;
  /** The recorded transaction hash exists in the recorded block. */
  txHashMatches: boolean | null;
  /** The recorded transaction reported `system.ExtrinsicSuccess`. */
  txSucceeded: boolean | null;
  /**
   * The on-chain record names this run hash: `anchoredAt(runHash) > 0` for the
   * contract method (or the matching `RunAnchored` log), or the exact remark
   * payload for the remark method.
   */
  onChainRecordMatches: boolean | null;
  verdict: 'verified' | 'mismatch' | 'unverifiable';
  notes: string[];
  at: string;
}

export interface V3SignerStatus {
  configured: boolean;
  /** Public SS58 address when configured. */
  address: string | null;
  /** H160 the revive pallet maps this account to (when observed). */
  evmAddress: string | null;
  /** Free balance in planck (string, 14 decimals on V3) when observed. */
  freeBalance: string | null;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
}

export interface V3AnchorStatusReport {
  signer: V3SignerStatus;
  /** Registry address in effect (env override or latest deployment). */
  registryAddress: string | null;
  registrySource: 'env' | 'deployment' | null;
  chainName: string | null;
  genesisHash: string | null;
  /** Polkadot-js apps base for building block links (node console). */
  explorerBlockUrlTemplate: string;
  error: string | null;
  at: string;
}
