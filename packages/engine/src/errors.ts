/**
 * Structured error taxonomy for the Kaizen engine.
 *
 * Every failure surfaced to CLI/API carries a stable `code` so callers can
 * react programmatically and users get actionable messages. Never include
 * secrets (keys, passwords) in messages or details.
 */

export type KaizenErrorCode =
  // binary management
  | 'UNSUPPORTED_PLATFORM'
  | 'BINARY_NOT_AVAILABLE'
  | 'DOWNLOAD_FAILED'
  | 'INVALID_ARTIFACT'
  | 'MANIFEST_CORRUPT'
  // process management
  | 'NODE_ALREADY_RUNNING'
  | 'NODE_NOT_RUNNING'
  | 'STALE_PROCESS'
  | 'STARTUP_FAILED'
  | 'STOP_TIMEOUT'
  // ports / input
  | 'PORT_ALLOCATION_FAILED'
  | 'INVALID_INPUT'
  // RPC
  | 'RPC_CONNECTION_FAILED'
  | 'RPC_TIMEOUT'
  | 'RPC_ERROR'
  // networks / store
  | 'NETWORK_NOT_FOUND'
  | 'NETWORK_ALREADY_EXISTS'
  | 'NETWORK_ALREADY_RUNNING'
  | 'NODE_NOT_FOUND'
  | 'OPERATION_TIMEOUT'
  // fault injection (T-3.2)
  | 'FAULT_NOT_FOUND'
  | 'FAULT_NOT_ALLOWED'
  | 'FAULT_CONFLICT'
  | 'FAULT_NOT_SUPPORTED'
  // scenario authoring (T-3.3)
  | 'SCENARIO_NOT_FOUND'
  | 'SCENARIO_ALREADY_EXISTS'
  | 'SCENARIO_INVALID'
  | 'SCENARIO_MALFORMED'
  | 'SCENARIO_VERSION_UNSUPPORTED'
  // scenario execution (T-3.4)
  | 'SCENARIO_RUN_NOT_FOUND'
  | 'SCENARIO_RUN_CONFLICT'
  | 'SCENARIO_EXEC_NOT_ALLOWED'
  | 'SCENARIO_RUN_NOT_REPLAYABLE'
  // fault interruption recovery (T-3.4 startup reconciliation)
  | 'FAULT_INTERRUPTED'
  // V3 testnet anchoring (T-8.2)
  | 'V3_SIGNER_NOT_CONFIGURED'
  | 'V3_SIGNER_INVALID'
  | 'V3_REGISTRY_NOT_DEPLOYED'
  | 'V3_RUN_NOT_ANCHORABLE'
  | 'V3_ALREADY_ANCHORED'
  | 'V3_INSUFFICIENT_FUNDS'
  | 'V3_TX_FAILED'
  | 'V3_ANCHOR_NOT_FOUND'
  // Proof-of-Resilience (T-9.x)
  | 'RESILIENCE_SIGNER_NOT_CONFIGURED'
  | 'RESILIENCE_SIGNER_INVALID'
  | 'RESILIENCE_NOT_CERTIFIABLE'
  | 'RESILIENCE_CERTIFICATE_NOT_FOUND'
  | 'ATTESTATION_SIGNER_NOT_CONFIGURED'
  | 'ATTESTATION_SAME_KEY'
  | 'ATTESTATION_INVALID'
  | 'INTERNAL';

export interface KaizenErrorJson {
  code: KaizenErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class KaizenError extends Error {
  readonly code: KaizenErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: KaizenErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KaizenError';
    this.code = code;
    this.details = details;
  }

  toJSON(): KaizenErrorJson {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

export function isKaizenError(e: unknown): e is KaizenError {
  return e instanceof KaizenError;
}

/** Convert any thrown value into a structured KaizenErrorJson. */
export function toErrorJson(e: unknown): KaizenErrorJson {
  if (isKaizenError(e)) return e.toJSON();
  if (e instanceof Error) return { code: 'INTERNAL', message: e.message };
  return { code: 'INTERNAL', message: String(e) };
}
