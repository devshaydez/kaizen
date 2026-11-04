/**
 * Engine factory — wires the shared services used by both the CLI and the API.
 *
 * Single wiring point (DEC-002): the CLI constructs an engine in-process, the
 * API constructs one and exposes it over REST/WS. Both use these exact
 * services; there is no duplicated operational logic.
 */

import path from 'node:path';
import { BinaryManager } from './binary/manager';
import { EventBus } from './events/bus';
import { FailureInjector } from './fault/injector';
import { MonitoringService } from './monitor/service';
import { NetworkService } from './network/service';
import { NodeProcessManager } from './process/manager';
import { PortAllocator } from './process/ports';
import { ScenarioService } from './scenario/service';
import { ScenarioEngine } from './scenario/runner';
import { StateStore } from './state/store';
import { V3AnchorService } from './v3/anchor/service';
import { ResilienceService } from './resilience/service';
import { createNodeConsensusCapture } from './resilience/consensus-runtime';
import { httpUrlForPort } from './process/args';

export const KAIZEN_VERSION = '0.1.0';

export interface EngineOptions {
  /**
   * Root of all Kaizen runtime state (SQLite db, downloaded binaries,
   * network dirs). Default: $KAIZEN_DATA_DIR or ./.kaizen
   */
  dataDir?: string;
  /**
   * Where the Portaldot binary cache lives. Default: <dataDir>/bin.
   * Tests (or multi-project setups) point several engines at one cache.
   */
  binaryCacheDir?: string;
  healthTimeoutMs?: number;
  /** Monitoring poll cadence per network (default 2000ms). */
  monitorIntervalMs?: number;
  /** Capture chain evidence around scenario runs (T-9.5). Default:
   *  KAIZEN_RESILIENCE_EVIDENCE=1. */
  resilienceCapture?: boolean;
  /** Read BABE/GRANDPA/session/era context from the observer node while
   *  capturing evidence (T-9.7B). Default: enabled; set false to record
   *  chain-bound evidence without consensus context. */
  consensusCapture?: boolean;
}

export interface KaizenEngine {
  dataDir: string;
  store: StateStore;
  binaries: BinaryManager;
  processes: NodeProcessManager;
  ports: PortAllocator;
  events: EventBus;
  networks: NetworkService;
  /** Real-RPC monitoring of running networks (auto-starts on 'running'). */
  monitoring: MonitoringService;
  /** Guarded fault injection against designatedTest networks only
   *  (DEC-008/DEC-018). Dry-run by default; execute() revalidates. */
  faults: FailureInjector;
  /** Scenario authoring (T-3.3): CRUD + deterministic validation over the
   *  safe operation registry. Pure data service — it never executes faults. */
  scenarios: ScenarioService;
  /** Scenario execution (T-3.4): gated, auditable runs of saved scenarios
   *  through the FailureInjector. Runs are created only by an explicit
   *  execute() request; saving a scenario NEVER runs it. */
  scenarioRuns: ScenarioEngine;
  /** V3 testnet run anchoring (T-8.2): explicit, operator-signed writes of
   *  finished run hashes; evidence persisted in SQLite. */
  v3Anchors: V3AnchorService;
  /** Proof-of-Resilience (T-9.5): chain-evidence capture around runs (opt-in,
   *  KAIZEN_RESILIENCE_EVIDENCE=1), explicit signed certificates, scores. */
  resilience: ResilienceService;
  /** WS RPC url of a node in a network (by node id). */
  wsUrlForNode(nodeId: string): string;
  /** Release engine resources. Managed node processes are NOT killed —
   *  networks are long-running daemons (stop them explicitly). In-flight
   *  faults are cancelled and rolled back first (no paused process leaks). */
  close(): Promise<void>;
}

export function resolveDataDir(explicit?: string): string {
  return explicit ?? process.env['KAIZEN_DATA_DIR'] ?? path.join(process.cwd(), '.kaizen');
}

export function createEngine(options: EngineOptions = {}): KaizenEngine {
  const dataDir = resolveDataDir(options.dataDir);
  const store = new StateStore(path.join(dataDir, 'kaizen.db'));
  const binaries = new BinaryManager({
    cacheDir: options.binaryCacheDir ?? path.join(dataDir, 'bin'),
  });
  const events = new EventBus();
  const ports = new PortAllocator();
  const processes = new NodeProcessManager({
    onExit: (nodeId, info) => {
      // Crash detection: reflect unexpected exits in the store + events.
      try {
        const node = store.getNode(nodeId);
        store.updateNodeStatus(nodeId, 'crashed', null);
        events.emit('node.status', {
          networkId: node.networkId,
          nodeId,
          name: node.name,
          status: 'crashed',
          note: `unexpected exit (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`,
          at: new Date().toISOString(),
        });
        const network = store.getNetwork(node.networkId);
        if (network.status === 'running') {
          store.updateNetworkStatus(node.networkId, 'degraded');
          events.emit('network.status', {
            networkId: node.networkId,
            name: network.name,
            status: 'degraded',
            at: new Date().toISOString(),
          });
        }
      } catch {
        // store may be closed during shutdown; ignore
      }
    },
  });
  const networks = new NetworkService({
    store,
    binaries,
    processes,
    events,
    ports,
    dataDir,
    healthTimeoutMs: options.healthTimeoutMs,
  });
  const monitoring = new MonitoringService({
    store,
    processes,
    events,
    intervalMs: options.monitorIntervalMs,
  });
  const faults = new FailureInjector({ store, events, processes, networks });
  const scenarios = new ScenarioService({
    store,
    events,
    // The authoring registry mirrors the injector's ACTUAL mechanisms —
    // never a separate list that could contradict it (T-3.3).
    mechanisms: faults.describeMechanisms(),
  });
  const scenarioRuns = new ScenarioEngine({
    store,
    events,
    scenarios,
    faults,
    monitoring,
  });
  // Crash recovery (T-3.4): terminalize runs interrupted by a previous
  // process and reconcile their stuck faults — DEFERRING any run whose
  // recorded executor pid is still alive (owned by a live process, not an
  // orphan: concurrent CLI/API topology, T-3.6A). Idempotent, never rejects,
  // NEVER resumes execution. (Kicked off now; awaited in close().)
  void scenarioRuns.reconcileOnStartup();
  const v3Anchors = new V3AnchorService({ store, events });
  const resilience = new ResilienceService({
    store,
    events,
    capture: options.resilienceCapture,
    consensus:
      options.consensusCapture === false
        ? undefined
        : (observer) => createNodeConsensusCapture(httpUrlForPort(observer.ports.rpc)),
  });

  return {
    dataDir,
    store,
    binaries,
    processes,
    ports,
    events,
    networks,
    monitoring,
    faults,
    scenarios,
    scenarioRuns,
    v3Anchors,
    resilience,
    wsUrlForNode(nodeId: string): string {
      const node = store.getNode(nodeId);
      return `ws://127.0.0.1:${node.ports.ws}`;
    },
    async close(): Promise<void> {
      // Runs first: cancel active runs through the normal cleanup-then-stop
      // path while the injector is still alive, then roll back faults.
      await scenarioRuns.close();
      await faults.shutdown();
      await resilience.close();
      monitoring.stopAll();
      store.close();
    },
  };
}
