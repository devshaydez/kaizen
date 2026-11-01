/**
 * Typed API contract for the Kaizen web UI.
 *
 * Response shapes mirror what `apps/api/src/server.ts` actually returns.
 * Engine types are imported (type-only — zero runtime cost) so the UI can
 * never drift from the shared engine's models.
 */

import type {
  KaizenEventMap,
  KaizenEventName,
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeHealthReport,
  NodeHealthState,
  NodeMonitorSample,
  NodeRecord,
  NodeRole,
  NodeStatus,
  OperationResult,
  CustomTopologyNodeInput,
  ScenarioInput,
  ScenarioMalformedEntry,
  ScenarioRecord,
  ScenarioRunMalformedEntry,
  ScenarioRunRecord,
  ScenarioRunState,
  ScenarioRunSummary,
  ScenarioStepRun,
  ScenarioValidationResult,
  SerializedOperationDefinition,
  FaultRecord,
  FaultExecutionResult,
  FaultEvidence,
  FaultPreview,
  FaultType,
  FaultState,
  WellKnownKey,
  V3ConnectivityReport,
  V3EndpointProbeResult,
  V3AnchorRecord,
  V3ContractRecord,
  V3AnchorStatusReport,
  V3AnchorVerification,
  V3AnchorMethod,
  RpcPeerInfo,
} from '@kaizen/engine';

export type {
  FaultRecord,
  FaultExecutionResult,
  FaultEvidence,
  FaultPreview,
  FaultType,
  FaultState,
  WellKnownKey,
  V3ConnectivityReport,
  V3EndpointProbeResult,
  V3AnchorRecord,
  V3ContractRecord,
  V3AnchorStatusReport,
  V3AnchorVerification,
  V3AnchorMethod,
  RpcPeerInfo,
  KaizenEventMap,
  KaizenEventName,
  NetworkMonitorSnapshot,
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeHealthReport,
  NodeHealthState,
  NodeMonitorSample,
  NodeRecord,
  NodeRole,
  NodeStatus,
  OperationResult,
  ScenarioInput,
  ScenarioMalformedEntry,
  ScenarioRecord,
  ScenarioRunMalformedEntry,
  ScenarioRunRecord,
  ScenarioRunState,
  ScenarioRunSummary,
  ScenarioStepRun,
  ScenarioValidationResult,
  SerializedOperationDefinition,
};

/** Envelope for structured API errors ({ ok: false, error }). */
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  dataDir: string;
}

export interface BinaryStatusResponse {
  ok: boolean;
  status: {
    available: boolean;
    version?: string;
    sha256?: string;
    path?: string;
    error?: string;
  };
}

/** `GET /api/networks` items: full record + node count. */
export type NetworkWithCount = NetworkRecord & { nodeCount: number };

export interface NetworkListResponse {
  ok: boolean;
  networks: NetworkWithCount[];
}

export interface NetworkDetailResponse {
  ok: boolean;
  network: NetworkRecord;
  nodes: NodeRecord[];
}

/** Lifecycle routes answer 200 with a possibly-failed OperationResult. */
export interface OperationResponse {
  ok: boolean;
  result: OperationResult;
}

export interface MonitorResponse {
  ok: boolean;
  snapshot: NetworkMonitorSnapshot;
}

export interface NodeDetailResponse {
  ok: boolean;
  node: NodeRecord;
  sample: NodeMonitorSample | null;
  health: NodeHealthReport | null;
}

export interface NodeLogsResponse {
  ok: boolean;
  nodeId: string;
  lines: string[];
}

/** Input accepted by POST /api/networks (mirrors the server's Zod schema). */
export interface CreateNetworkInput {
  name: string;
  preset: NetworkPreset;
  custom?: { nodes: CustomTopologyNodeInput[] };
}

// ---------------------------------------------------------------------------
// Scenarios (T-3.3 authoring surface). Client contract only — the Failure
// Lab UI is a later phase (T-3.6); these methods exist so CLI/UI work can
// consume the same typed model.

export interface ScenarioListResponse {
  ok: boolean;
  scenarios: ScenarioRecord[];
  malformed: ScenarioMalformedEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface ScenarioResponse {
  ok: boolean;
  scenario: ScenarioRecord;
}

/** POST /api/scenarios/validate answers 200 with validity + structured result. */
export interface ScenarioValidateResponse {
  ok: boolean;
  result: ScenarioValidationResult;
}

export interface ScenarioOperationsResponse {
  ok: boolean;
  operations: SerializedOperationDefinition[];
}

export interface ScenarioDeleteResponse {
  ok: boolean;
  removed: string;
}

// ---------------------------------------------------------------------------
// Scenario runs (T-3.4 execution surface). Typed contracts only — the
// Failure Lab UI is a later phase (T-3.6). Runs are created ONLY by an
// explicit execute request (mode:'execute' + selected target); these
// methods never imply that saving a scenario runs it.

/** POST /api/scenarios/:id/execute answers 202 with the persisted run. */
export interface ScenarioExecuteResponse {
  ok: boolean;
  run: ScenarioRunRecord;
}

/**
 * POST /api/scenarios/runs/:runId/replay answers 202 with the NEW run.
 * `replayNote` states the contract inline: replay repeats the source run's
 * actions; identical outcomes are NOT guaranteed and every piece of evidence
 * in the run was freshly observed (null safety for original executions).
 */
export interface ScenarioReplayResponse extends ScenarioExecuteResponse {
  replayNote: string | null;
}

export interface ScenarioRunResponse {
  ok: boolean;
  run: ScenarioRunRecord;
}

export interface ScenarioRunListResponse {
  ok: boolean;
  runs: ScenarioRunSummary[];
  malformed: ScenarioRunMalformedEntry[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------
// Faults (T-3.2 FailureInjector surface, consumed by the Failure Lab UI)

export interface FaultRequestInput {
  nodeId: string;
  type: FaultType;
  options?: { durationMs?: number };
  requestedBy?: string;
}

export interface FaultDryRunResponse {
  ok: boolean;
  preview: FaultPreview;
}

export interface FaultExecuteResponse {
  ok: boolean;
  result: FaultExecutionResult;
}

export interface FaultListResponse {
  ok: boolean;
  faults: FaultRecord[];
}

export interface FaultResponse {
  ok: boolean;
  fault: FaultRecord;
}

// ---------------------------------------------------------------------------
// Portaldot V3 (T-8.1 probe + T-8.2 anchoring)

export interface V3ProbeResponse {
  ok: boolean;
  report: V3ConnectivityReport;
}

export interface V3StatusResponse {
  ok: boolean;
  status: V3AnchorStatusReport;
}

export interface V3AnchorListResponse {
  ok: boolean;
  anchors: V3AnchorRecord[];
  contracts: V3ContractRecord[];
  /** polkadot-js node-console block URL with a `{block}` placeholder. */
  explorerBlockUrlTemplate: string;
}

export interface V3AnchorResponse {
  ok: boolean;
  anchor: V3AnchorRecord;
}

export interface V3VerifyResponse {
  ok: boolean;
  verification: V3AnchorVerification;
}

export interface V3RunHashResponse {
  ok: boolean;
  runId: string;
  runHash: string;
  state: string;
  anchorable: boolean;
}
