/**
 * Shared typed Kaizen API client (T-2.5).
 *
 * One place for: base-URL handling (same-origin by default — the Vite dev
 * server proxies /api to the local backend), JSON envelopes, structured
 * error translation, timeouts, and abortability. Components never call
 * fetch() directly.
 *
 * The browser never launches processes: every operation here is a request to
 * the backend, which delegates to the shared engine (FR-1).
 */

import type {
  ApiErrorBody,
  BinaryStatusResponse,
  CreateNetworkInput,
  HealthResponse,
  MonitorResponse,
  NetworkDetailResponse,
  NetworkListResponse,
  NodeDetailResponse,
  NodeLogsResponse,
  OperationResponse,
  ScenarioDeleteResponse,
  ScenarioExecuteResponse,
  ScenarioInput,
  ScenarioListResponse,
  ScenarioOperationsResponse,
  ScenarioReplayResponse,
  ScenarioResponse,
  ScenarioRunListResponse,
  ScenarioRunResponse,
  ScenarioRunState,
  ScenarioValidateResponse,
  FaultDryRunResponse,
  FaultExecuteResponse,
  FaultListResponse,
  FaultRequestInput,
  FaultResponse,
  V3AnchorListResponse,
  V3AnchorMethod,
  V3AnchorResponse,
  V3ProbeResponse,
  V3RunHashResponse,
  V3StatusResponse,
  V3VerifyResponse,
} from './types';
import { REPLAY } from '../lib/mode';
import { createReplayFetch } from './replay/fetch';

/** Stable machine-readable failure classification for the UI. */
export type ApiErrorCode =
  | ApiErrorBody['code']
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'BAD_RESPONSE'
  | `HTTP_${number}`;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** Per-field issues from Zod validation, when present. */
  get issues(): string[] {
    const issues = this.details?.['issues'];
    if (Array.isArray(issues)) {
      return issues.map((i) =>
        typeof i === 'object' && i !== null && 'message' in i
          ? String((i as { message: unknown }).message)
          : String(i),
      );
    }
    const problems = this.details?.['problems'];
    if (Array.isArray(problems)) return problems.map(String);
    return [];
  }
}

export interface ApiClientOptions {
  /** Origin of the API; '' (same origin) by default. */
  baseUrl?: string;
  /** Default request timeout. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

/** Lifecycle operations are health-gated and can take minutes. */
export const START_TIMEOUT_MS = 300_000;
export const STOP_TIMEOUT_MS = 120_000;

export class KaizenApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: unknown; timeoutMs?: number } = {},
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: options.body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let payload: unknown = null;
      if (text) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          // A failed request with a non-JSON body (e.g. a proxy error page)
          // is still an HTTP failure — classify by status, not as BAD_RESPONSE.
          if (!res.ok) {
            throw new ApiError(`Request failed with HTTP ${res.status}`, `HTTP_${res.status}`, res.status);
          }
          throw new ApiError(`Non-JSON response (HTTP ${res.status})`, 'BAD_RESPONSE', res.status);
        }
      }
      if (!res.ok) {
        const err = (payload as { error?: ApiErrorBody } | null)?.error;
        throw new ApiError(
          err?.message ?? `Request failed with HTTP ${res.status}`,
          err?.code ?? `HTTP_${res.status}`,
          res.status,
          // Bodies without an error envelope (e.g. a 403 dry-run preview with
          // its full check list) are kept as details so callers can render them.
          err?.details ?? (err ? undefined : ((payload as Record<string, unknown> | null) ?? undefined)),
        );
      }
      return payload as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ApiError(`Request timed out after ${timeoutMs}ms`, 'TIMEOUT', 0);
      }
      const message = e instanceof Error ? e.message : String(e);
      throw new ApiError(`API unreachable: ${message}`, 'NETWORK_ERROR', 0);
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- meta ---------------------------------------------------------------
  health(options: { timeoutMs?: number } = {}): Promise<HealthResponse> {
    return this.request('GET', '/api/health', options);
  }

  binaries(): Promise<BinaryStatusResponse> {
    return this.request('GET', '/api/binaries');
  }

  // ---- networks -----------------------------------------------------------
  listNetworks(): Promise<NetworkListResponse> {
    return this.request('GET', '/api/networks');
  }

  createNetwork(input: CreateNetworkInput): Promise<{ ok: boolean; network: { id: string } }> {
    return this.request('POST', '/api/networks', { body: input });
  }

  getNetwork(id: string): Promise<NetworkDetailResponse> {
    return this.request('GET', `/api/networks/${encodeURIComponent(id)}`);
  }

  /** Health-gated; can take minutes (START_TIMEOUT_MS default). */
  startNetwork(id: string): Promise<OperationResponse> {
    return this.request('POST', `/api/networks/${encodeURIComponent(id)}/start`, {
      timeoutMs: START_TIMEOUT_MS,
    });
  }

  stopNetwork(id: string): Promise<OperationResponse> {
    return this.request('POST', `/api/networks/${encodeURIComponent(id)}/stop`, {
      timeoutMs: STOP_TIMEOUT_MS,
    });
  }

  purgeNetwork(id: string): Promise<OperationResponse> {
    return this.request('POST', `/api/networks/${encodeURIComponent(id)}/purge`, {
      timeoutMs: STOP_TIMEOUT_MS,
    });
  }

  removeNetwork(id: string): Promise<{ ok: boolean; removed: string }> {
    return this.request('DELETE', `/api/networks/${encodeURIComponent(id)}`, {
      timeoutMs: STOP_TIMEOUT_MS,
    });
  }

  monitorSnapshot(id: string): Promise<MonitorResponse> {
    return this.request('GET', `/api/networks/${encodeURIComponent(id)}/monitor`);
  }

  // ---- nodes --------------------------------------------------------------
  getNode(networkId: string, nodeId: string): Promise<NodeDetailResponse> {
    return this.request(
      'GET',
      `/api/networks/${encodeURIComponent(networkId)}/nodes/${encodeURIComponent(nodeId)}`,
    );
  }

  startNode(networkId: string, nodeId: string): Promise<OperationResponse> {
    return this.request(
      'POST',
      `/api/networks/${encodeURIComponent(networkId)}/nodes/${encodeURIComponent(nodeId)}/start`,
      { timeoutMs: START_TIMEOUT_MS },
    );
  }

  stopNode(networkId: string, nodeId: string): Promise<OperationResponse> {
    return this.request(
      'POST',
      `/api/networks/${encodeURIComponent(networkId)}/nodes/${encodeURIComponent(nodeId)}/stop`,
      { timeoutMs: STOP_TIMEOUT_MS },
    );
  }

  nodeLogs(networkId: string, nodeId: string, maxBytes = 16_384): Promise<NodeLogsResponse> {
    return this.request(
      'GET',
      `/api/networks/${encodeURIComponent(networkId)}/nodes/${encodeURIComponent(nodeId)}/logs?maxBytes=${maxBytes}`,
    );
  }

  // ---- scenarios (T-3.3 authoring surface: CRUD + validate only; saving a
  // scenario never executes anything) --------------------------------------
  listScenarios(
    filter: { q?: string; tag?: string; status?: 'valid' | 'warning'; limit?: number; offset?: number } = {},
  ): Promise<ScenarioListResponse> {
    const params = new URLSearchParams();
    if (filter.q !== undefined) params.set('q', filter.q);
    if (filter.tag !== undefined) params.set('tag', filter.tag);
    if (filter.status !== undefined) params.set('status', filter.status);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const qs = params.toString();
    return this.request('GET', `/api/scenarios${qs ? `?${qs}` : ''}`);
  }

  /** Safe operation registry (statuses, bounds, safety metadata). */
  scenarioOperations(): Promise<ScenarioOperationsResponse> {
    return this.request('GET', '/api/scenarios/operations');
  }

  /** Validate WITHOUT saving (never executes anything). */
  validateScenario(input: ScenarioInput): Promise<ScenarioValidateResponse> {
    return this.request('POST', '/api/scenarios/validate', { body: input });
  }

  createScenario(input: ScenarioInput): Promise<ScenarioResponse> {
    return this.request('POST', '/api/scenarios', { body: input });
  }

  getScenario(id: string): Promise<ScenarioResponse> {
    return this.request('GET', `/api/scenarios/${encodeURIComponent(id)}`);
  }

  updateScenario(id: string, patch: Partial<ScenarioInput>): Promise<ScenarioResponse> {
    return this.request('PUT', `/api/scenarios/${encodeURIComponent(id)}`, { body: patch });
  }

  deleteScenario(id: string): Promise<ScenarioDeleteResponse> {
    return this.request('DELETE', `/api/scenarios/${encodeURIComponent(id)}`);
  }

  // ---- scenario runs (T-3.4 execution surface) -----------------------------
  // Explicit, target-selected requests only (mode:'execute'). The backend
  // enforces every gate server-side; the client passes no operational
  // parameters beyond the target and audit actor.

  /**
   * Request execution of a saved scenario against an explicit target
   * network. Answers 202: the run is persisted BEFORE any side effect and
   * executes in the background — poll getScenarioRun, or cancelScenarioRun.
   */
  executeScenario(
    scenarioId: string,
    request: { networkIdOrName: string; requestedBy?: string },
  ): Promise<ScenarioExecuteResponse> {
    return this.request('POST', `/api/scenarios/${encodeURIComponent(scenarioId)}/execute`, {
      body: { mode: 'execute', ...request },
    });
  }

  /** Full run record: immutable snapshot, per-step evidence, cleanup, error. */
  getScenarioRun(runId: string): Promise<ScenarioRunResponse> {
    return this.request('GET', `/api/scenarios/runs/${encodeURIComponent(runId)}`);
  }

  /** Paginated run history (summaries without the snapshot payload). */
  listScenarioRuns(
    filter: {
      scenarioId?: string;
      networkId?: string;
      state?: ScenarioRunState;
      /** Only runs replayed FROM this source run (T-3.5 provenance). */
      replayOf?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<ScenarioRunListResponse> {
    const params = new URLSearchParams();
    if (filter.scenarioId !== undefined) params.set('scenarioId', filter.scenarioId);
    if (filter.networkId !== undefined) params.set('networkId', filter.networkId);
    if (filter.state !== undefined) params.set('state', filter.state);
    if (filter.replayOf !== undefined) params.set('replayOf', filter.replayOf);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    if (filter.offset !== undefined) params.set('offset', String(filter.offset));
    const qs = params.toString();
    return this.request('GET', `/api/scenarios/runs${qs ? `?${qs}` : ''}`);
  }

  /**
   * Request cancellation: explicit, persisted, and interruptive only via
   * the injector's supported cancellation (rollback first, then stop).
   */
  cancelScenarioRun(runId: string, requestedBy?: string): Promise<ScenarioRunResponse> {
    return this.request('POST', `/api/scenarios/runs/${encodeURIComponent(runId)}/cancel`, {
      body: requestedBy !== undefined ? { requestedBy } : {},
    });
  }

  /**
   * Replay a finished run's recorded actions as a NEW run (T-3.5): same
   * engine path, same gates, fresh evidence. The target must be confirmed
   * explicitly again (same mode:'execute' posture); replay repeats actions
   * and never claims identical outcomes. Poll getScenarioRun for the new
   * run id, or cancelScenarioRun to stop it.
   */
  replayScenarioRun(
    runId: string,
    request: { networkIdOrName: string; requestedBy?: string },
  ): Promise<ScenarioReplayResponse> {
    return this.request('POST', `/api/scenarios/runs/${encodeURIComponent(runId)}/replay`, {
      body: { mode: 'execute', ...request },
    });
  }

  // ---- faults (T-3.2; Failure Lab) ----------------------------------------
  // Execute blocks server-side until the fault is applied, held, removed and
  // recovery is verified — the client timeout covers the hold plus margin.

  /** Preflight + plan (never executes). A gate denial answers 403 with the
   *  preview in ApiError.details.preview. */
  dryRunFault(networkId: string, input: FaultRequestInput): Promise<FaultDryRunResponse> {
    return this.request('POST', `/api/networks/${encodeURIComponent(networkId)}/faults/dry-run`, { body: input });
  }

  executeFault(networkId: string, input: FaultRequestInput): Promise<FaultExecuteResponse> {
    const hold = input.options?.durationMs ?? 0;
    return this.request('POST', `/api/networks/${encodeURIComponent(networkId)}/faults/execute`, {
      body: { mode: 'execute', ...input },
      timeoutMs: hold + START_TIMEOUT_MS,
    });
  }

  listFaults(networkId: string): Promise<FaultListResponse> {
    return this.request('GET', `/api/networks/${encodeURIComponent(networkId)}/faults`);
  }

  getFault(faultId: string): Promise<FaultResponse> {
    return this.request('GET', `/api/faults/${encodeURIComponent(faultId)}`);
  }

  /** Cancel an in-flight fault: the injector rolls the effect back first. */
  cancelFault(faultId: string): Promise<unknown> {
    return this.request('POST', `/api/faults/${encodeURIComponent(faultId)}/cancel`, {
      body: {},
      timeoutMs: STOP_TIMEOUT_MS,
    });
  }

  // ---- Portaldot V3 (T-8.1 probe, T-8.2 anchoring) -------------------------

  v3Probe(): Promise<V3ProbeResponse> {
    return this.request('GET', '/api/v3/probe', { timeoutMs: V3_READ_TIMEOUT_MS });
  }

  v3Status(): Promise<V3StatusResponse> {
    return this.request('GET', '/api/v3/status', { timeoutMs: V3_READ_TIMEOUT_MS });
  }

  v3Anchors(filter: { runId?: string; limit?: number } = {}): Promise<V3AnchorListResponse> {
    const params = new URLSearchParams();
    if (filter.runId !== undefined) params.set('runId', filter.runId);
    if (filter.limit !== undefined) params.set('limit', String(filter.limit));
    const qs = params.toString();
    return this.request('GET', `/api/v3/anchors${qs ? `?${qs}` : ''}`);
  }

  /** Explicit, operator-confirmed write to the V3 TEST network. */
  anchorRun(runId: string, method?: V3AnchorMethod): Promise<V3AnchorResponse> {
    return this.request('POST', '/api/v3/anchors', {
      body: { mode: 'execute', runId, requestedBy: 'web', ...(method ? { method } : {}) },
      timeoutMs: V3_ANCHOR_TIMEOUT_MS,
    });
  }

  verifyAnchor(anchorId: string): Promise<V3VerifyResponse> {
    return this.request('POST', `/api/v3/anchors/${encodeURIComponent(anchorId)}/verify`, {
      body: {},
      timeoutMs: V3_READ_TIMEOUT_MS,
    });
  }

  runHash(runId: string): Promise<V3RunHashResponse> {
    return this.request('GET', `/api/v3/runs/${encodeURIComponent(runId)}/hash`);
  }
}

/** Remote V3 calls cross the public internet (bounded server-side too). */
export const V3_READ_TIMEOUT_MS = 60_000;
/** An anchor waits for inclusion + finality (server bounds: 120s + 60s). */
export const V3_ANCHOR_TIMEOUT_MS = 240_000;

/**
 * Default client: same-origin (dev server proxies /api → backend). In the
 * hosted build (VITE_KAIZEN_PUBLIC=1) there is no engine: the same client
 * reads REAL recorded drills through the replay fetch adapter, and every
 * mutating request is refused with REPLAY_MODE (src/api/replay).
 */
export const apiClient = REPLAY
  ? new KaizenApiClient({ baseUrl: '', fetchImpl: createReplayFetch(), timeoutMs: 60_000 })
  : new KaizenApiClient({
      baseUrl: import.meta.env?.['VITE_KAIZEN_API'] ?? '',
    });
