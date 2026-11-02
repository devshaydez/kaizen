/**
 * SQLite-backed state store (DEC-005).
 *
 * Uses Node's built-in `node:sqlite` (stable in Node 24) — zero native
 * dependencies. Stores networks, node configs, and operation history.
 * NEVER stores secrets: node key material lives in files under the network
 * base dir, referenced by path only.
 */

import type { ResilienceCertificate } from '../resilience/certificate';
import type { KaizenAttestation } from '../resilience/attestation';
import type { ChainEvidence } from '../resilience/evidence';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { KaizenError } from '../errors';
import type { FaultEvidence, FaultExecutionResult, FaultPlanStep, FaultPreflight, FaultRecord, FaultState } from '../fault/types';
import { SCENARIO_SCHEMA_VERSION } from '../scenario/types';
import type {
  ScenarioExecutionPolicy,
  ScenarioListResult,
  ScenarioMalformedEntry,
  ScenarioRecord,
  ScenarioTargetRequirements,
  ScenarioValidationResult,
} from '../scenario/types';
import {
  SCENARIO_RUN_STATES,
  type ScenarioRunCancellation,
  type ScenarioRunCleanup,
  type ScenarioRunError,
  type ScenarioRunListResult,
  type ScenarioRunRecord,
  type ScenarioRunState,
  type ScenarioStepRun,
  type ScenarioRunTargetNode,
} from '../scenario/run-types';
import type {
  KaizenErrorJson,
} from '../errors';
import type { V3AnchorRecord, V3ContractRecord } from '../v3/anchor/types';
import type {
  NetworkPreset,
  NetworkRecord,
  NetworkStatus,
  NodeConfig,
  NodeRecord,
  NodeStatus,
  NodePorts,
} from '../types';

const MIGRATIONS: string[] = [
  // 1: networks
  `CREATE TABLE IF NOT EXISTS networks (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     preset TEXT NOT NULL,
     status TEXT NOT NULL,
     designated_test INTEGER NOT NULL DEFAULT 1,
     chain TEXT NOT NULL,
     chain_spec_path TEXT,
     base_dir TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 2: nodes
  `CREATE TABLE IF NOT EXISTS nodes (
     id TEXT PRIMARY KEY,
     network_id TEXT NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     role TEXT NOT NULL,
     chain TEXT NOT NULL,
     chain_spec_path TEXT,
     well_known_key TEXT,
     bootnodes TEXT NOT NULL DEFAULT '[]',
     base_dir TEXT NOT NULL,
     node_key_file TEXT NOT NULL,
     log_file TEXT NOT NULL,
     p2p_port INTEGER NOT NULL,
     rpc_port INTEGER NOT NULL,
     ws_port INTEGER NOT NULL,
     prom_port INTEGER NOT NULL,
     status TEXT NOT NULL,
     pid INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 3: operations
  `CREATE TABLE IF NOT EXISTS operations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     kind TEXT NOT NULL,
     network_id TEXT,
     node_id TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT,
     status TEXT NOT NULL,
     error_code TEXT,
     error_message TEXT,
     detail TEXT
   );`,
  // 4: node uptime + peer expectations (monitoring, T-2.4)
  `ALTER TABLE nodes ADD COLUMN started_at TEXT;`,
  `ALTER TABLE nodes ADD COLUMN expected_peers INTEGER NOT NULL DEFAULT 0;`,
  // 6-8: fault records (FailureInjector audit trail, T-3.2) — deliberately no
  // FK to networks: the audit must survive network removal (like operations).
  `CREATE TABLE IF NOT EXISTS faults (
     id TEXT PRIMARY KEY,
     network_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     node_name TEXT NOT NULL DEFAULT '',
     type TEXT NOT NULL,
     mode TEXT NOT NULL,
     state TEXT NOT NULL,
     requested_by TEXT NOT NULL,
     hold_duration_ms INTEGER,
     requested_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     finished_at TEXT,
     preflight TEXT,
     plan TEXT,
     evidence TEXT,
     result TEXT,
     error TEXT,
     reconciled INTEGER NOT NULL DEFAULT 0
   );`,
  `CREATE INDEX IF NOT EXISTS faults_network_idx ON faults(network_id);`,
  `CREATE INDEX IF NOT EXISTS faults_node_idx ON faults(node_id);`,
  // 9: scenario definitions (T-3.3 authoring — validation/status persisted
  //    alongside the definition so reloads see exactly what was accepted).
  `CREATE TABLE IF NOT EXISTS scenarios (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     description TEXT NOT NULL DEFAULT '',
     schema_version INTEGER NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]',
     requires TEXT NOT NULL,
     steps TEXT NOT NULL,
     execution TEXT NOT NULL,
     validation TEXT NOT NULL,
     validation_status TEXT NOT NULL,
     created_by TEXT NOT NULL DEFAULT 'engine',
     updated_by TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  // 10: recency index for list ordering
  `CREATE INDEX IF NOT EXISTS scenarios_updated_idx ON scenarios(updated_at);`,
  // 11: scenario RUNS (T-3.4 ScenarioEngine audit trail). Deliberately no FK
  //     to scenarios: execution history must survive scenario edits/deletes
  //     (the snapshot column is immutable). No FK to networks either, same as
  //     the faults audit table.
  `CREATE TABLE IF NOT EXISTS scenario_runs (
     id TEXT PRIMARY KEY,
     scenario_id TEXT NOT NULL,
     scenario_name TEXT NOT NULL,
     scenario_schema_version INTEGER NOT NULL,
     network_id TEXT NOT NULL DEFAULT '',
     network_name TEXT NOT NULL DEFAULT '',
     state TEXT NOT NULL,
     current_step_id TEXT,
     requested_by TEXT NOT NULL,
     snapshot TEXT NOT NULL,
     target_nodes TEXT NOT NULL DEFAULT '[]',
     steps TEXT NOT NULL DEFAULT '[]',
     validation TEXT,
     warnings TEXT NOT NULL DEFAULT '[]',
     error TEXT,
     cleanup TEXT,
     cancellation TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     updated_at TEXT NOT NULL,
     finished_at TEXT
   );`,
  `CREATE INDEX IF NOT EXISTS scenario_runs_created_idx ON scenario_runs(created_at);`,
  `CREATE INDEX IF NOT EXISTS scenario_runs_scenario_idx ON scenario_runs(scenario_id);`,
  `CREATE INDEX IF NOT EXISTS scenario_runs_network_idx ON scenario_runs(network_id);`,
  `CREATE INDEX IF NOT EXISTS scenario_runs_state_idx ON scenario_runs(state);`,
  // 12: run provenance (T-3.5 replay). A replay run records the source run
  //     it re-executes; original rows are never rewritten by a replay, so
  //     history stays append-only and both directions stay queryable.
  `ALTER TABLE scenario_runs ADD COLUMN replay_of_run_id TEXT;`,
  `CREATE INDEX IF NOT EXISTS scenario_runs_replay_idx ON scenario_runs(replay_of_run_id);`,
  // 13: run executor ownership (T-3.6A multi-process topology). Startup
  //     reconciliation must distinguish a crash orphan from a run another
  //     LIVE process is executing right now — "unfinished" alone never
  //     proves a crash when CLI/API processes are concurrent and short-
  //     lived. Set once at insert (never rewritten by updates).
  `ALTER TABLE scenario_runs ADD COLUMN executor_pid INTEGER;`,
  // 19-22: V3 testnet anchoring (T-8.2). Anchor rows are persisted BEFORE
  //     submission and updated with what the chain reported; they hold only
  //     public data (hashes, addresses, block refs) — never signer secrets.
  //     A run hash may be anchored at most once per chain (genesis) and
  //     method; failed attempts are kept for audit and do not block retry.
  `CREATE TABLE IF NOT EXISTS v3_anchors (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     run_hash TEXT NOT NULL,
     method TEXT NOT NULL,
     status TEXT NOT NULL,
     payload TEXT NOT NULL,
     contract_address TEXT,
     signer_address TEXT NOT NULL,
     chain_name TEXT,
     genesis_hash TEXT,
     tx_hash TEXT,
     block_hash TEXT,
     block_number INTEGER,
     extrinsic_index INTEGER,
     error TEXT,
     requested_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS v3_anchors_run_idx ON v3_anchors(run_id);`,
  `CREATE INDEX IF NOT EXISTS v3_anchors_hash_idx ON v3_anchors(run_hash);`,
  `CREATE TABLE IF NOT EXISTS v3_contracts (
     address TEXT NOT NULL,
     genesis_hash TEXT NOT NULL,
     name TEXT NOT NULL,
     code_hash TEXT NOT NULL,
     deployer_address TEXT NOT NULL,
     chain_name TEXT NOT NULL,
     tx_hash TEXT NOT NULL,
     block_hash TEXT NOT NULL,
     block_number INTEGER NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (address, genesis_hash)
   );`,
  // 23-25: Proof-of-Resilience (T-9.5). Chain evidence captured around a
  //     run's fault (one row per run), and signed certificates keyed by
  //     fingerprint (INSERT OR IGNORE: issuing twice is idempotent). Public
  //     data only — never signer secrets.
  `CREATE TABLE IF NOT EXISTS resilience_evidence (
     run_id TEXT PRIMARY KEY,
     network_id TEXT NOT NULL,
     validator_id TEXT NOT NULL,
     evidence TEXT NOT NULL,
     created_at TEXT NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS resilience_certificates (
     fingerprint TEXT PRIMARY KEY,
     run_id TEXT NOT NULL,
     validator_id TEXT NOT NULL,
     network_id TEXT NOT NULL,
     signer_address TEXT NOT NULL,
     dev INTEGER NOT NULL,
     certificate TEXT NOT NULL,
     signed_at TEXT NOT NULL
   );`,
  `CREATE INDEX IF NOT EXISTS resilience_certificates_validator_idx ON resilience_certificates(validator_id);`,
  // A2: third-party attestations, one per (fingerprint, attester) pair.
  //     INSERT OR REPLACE: re-attesting by the same key updates its record.
  //     Public data only - never attester secrets.
  `CREATE TABLE IF NOT EXISTS resilience_attestations (
     fingerprint TEXT NOT NULL,
     attester_address TEXT NOT NULL,
     verdict TEXT NOT NULL,
     checked_at TEXT NOT NULL,
     attestation TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY (fingerprint, attester_address)
   );`,
];

interface NetworkRow {
  id: string;
  name: string;
  preset: string;
  status: string;
  designated_test: number;
  chain: string;
  chain_spec_path: string | null;
  base_dir: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  network_id: string;
  name: string;
  role: string;
  chain: string;
  chain_spec_path: string | null;
  well_known_key: string | null;
  bootnodes: string;
  base_dir: string;
  node_key_file: string;
  log_file: string;
  p2p_port: number;
  rpc_port: number;
  ws_port: number;
  prom_port: number;
  status: string;
  pid: number | null;
  started_at: string | null;
  expected_peers: number;
}

export interface OperationRow {
  id: number;
  kind: string;
  network_id: string | null;
  node_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_code: string | null;
  error_message: string | null;
  detail: string | null;
}

interface FaultRow {
  id: string;
  network_id: string;
  node_id: string;
  node_name: string;
  type: string;
  mode: string;
  state: string;
  requested_by: string;
  hold_duration_ms: number | null;
  requested_at: string;
  updated_at: string;
  finished_at: string | null;
  preflight: string | null;
  plan: string | null;
  evidence: string | null;
  result: string | null;
  error: string | null;
  reconciled: number;
}

interface ScenarioRow {
  id: string;
  name: string;
  description: string;
  schema_version: number;
  tags: string;
  requires: string;
  steps: string;
  execution: string;
  validation: string;
  validation_status: string;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

interface ScenarioRunRow {
  id: string;
  scenario_id: string;
  scenario_name: string;
  scenario_schema_version: number;
  network_id: string;
  network_name: string;
  state: string;
  current_step_id: string | null;
  requested_by: string;
  snapshot: string;
  target_nodes: string;
  steps: string;
  validation: string | null;
  warnings: string;
  error: string | null;
  cleanup: string | null;
  cancellation: string | null;
  replay_of_run_id: string | null;
  executor_pid: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

export interface InsertNetworkInput {
  id: string;
  name: string;
  preset: NetworkPreset;
  status: NetworkStatus;
  designatedTest: boolean;
  chain: 'dev' | 'local-spec';
  chainSpecPath?: string;
  baseDir: string;
  createdAt: string;
}

export interface InsertNodeInput {
  config: NodeConfig;
  status: NodeStatus;
  createdAt: string;
}

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  /** Apply pending migrations. Idempotent — safe to call repeatedly. */
  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);',
    );
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null };
    const current = row.v ?? 0;
    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v + 1);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }
  }

  get schemaVersion(): number {
    const row = this.db
      .prepare('SELECT MAX(version) AS v FROM schema_version')
      .get() as { v: number | null };
    return row.v ?? 0;
  }

  // -------------------------------------------------------------------------
  // Networks

  insertNetwork(input: InsertNetworkInput): NetworkRecord {
    this.db
      .prepare(
        `INSERT INTO networks
         (id, name, preset, status, designated_test, chain, chain_spec_path, base_dir, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.preset,
        input.status,
        input.designatedTest ? 1 : 0,
        input.chain,
        input.chainSpecPath ?? null,
        input.baseDir,
        input.createdAt,
        input.createdAt,
      );
    return this.getNetwork(input.id);
  }

  getNetwork(id: string): NetworkRecord {
    const row = this.db.prepare('SELECT * FROM networks WHERE id = ?').get(id) as
      | NetworkRow
      | undefined;
    if (!row) throw new Error(`network not found: ${id}`);
    return mapNetwork(row);
  }

  tryGetNetwork(idOrName: string): NetworkRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM networks WHERE id = ? OR name = ?')
      .get(idOrName, idOrName) as NetworkRow | undefined;
    return row ? mapNetwork(row) : undefined;
  }

  listNetworks(): NetworkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM networks ORDER BY created_at')
      .all() as unknown as NetworkRow[];
    return rows.map(mapNetwork);
  }

  updateNetworkStatus(id: string, status: NetworkStatus): void {
    this.db
      .prepare('UPDATE networks SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);
  }

  // -------------------------------------------------------------------------
  // Nodes

  insertNode(input: InsertNodeInput): NodeRecord {
    const c = input.config;
    this.db
      .prepare(
        `INSERT INTO nodes
         (id, network_id, name, role, chain, chain_spec_path, well_known_key, bootnodes,
          base_dir, node_key_file, log_file, p2p_port, rpc_port, ws_port, prom_port,
          status, pid, started_at, expected_peers, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        c.id,
        c.networkId,
        c.name,
        c.role,
        c.chain,
        c.chainSpecPath ?? null,
        c.wellKnownKey ?? null,
        JSON.stringify(c.bootnodes),
        c.baseDir,
        c.nodeKeyFile,
        c.logFile,
        c.ports.p2p,
        c.ports.rpc,
        c.ports.ws,
        c.ports.prometheus,
        input.status,
        c.expectedPeers ?? 0,
        input.createdAt,
        input.createdAt,
      );
    return this.getNode(c.id);
  }

  getNode(id: string): NodeRecord {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined;
    if (!row) throw new Error(`node not found: ${id}`);
    return mapNode(row);
  }

  tryGetNode(id: string): NodeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | NodeRow
      | undefined;
    return row ? mapNode(row) : undefined;
  }

  listNodes(networkId: string): NodeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM nodes WHERE network_id = ? ORDER BY id')
      .all(networkId) as unknown as NodeRow[];
    return rows.map(mapNode);
  }

  updateNodeStatus(
    id: string,
    status: NodeStatus,
    pid?: number | null,
    startedAt?: string | null,
  ): void {
    this.db
      .prepare(
        'UPDATE nodes SET status = ?, pid = ?, started_at = COALESCE(?, started_at), updated_at = ? WHERE id = ?',
      )
      .run(status, pid ?? null, startedAt ?? null, new Date().toISOString(), id);
  }

  deleteNodes(networkId: string): void {
    this.db.prepare('DELETE FROM nodes WHERE network_id = ?').run(networkId);
  }

  // -------------------------------------------------------------------------
  // Operations

  startOperation(kind: string, networkId?: string, nodeId?: string): number {
    const res = this.db
      .prepare(
        `INSERT INTO operations (kind, network_id, node_id, started_at, status)
         VALUES (?, ?, ?, ?, 'running')`,
      )
      .run(kind, networkId ?? null, nodeId ?? null, new Date().toISOString());
    return Number(res.lastInsertRowid);
  }

  /** Link an operation row to a network once its id exists (create flow). */
  attachOperationToNetwork(opId: number, networkId: string): void {
    this.db
      .prepare('UPDATE operations SET network_id = ? WHERE id = ?')
      .run(networkId, opId);
  }

  finishOperation(
    id: number,
    outcome: {
      status: 'ok' | 'error';
      errorCode?: string;
      errorMessage?: string;
      detail?: Record<string, unknown>;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE operations
         SET finished_at = ?, status = ?, error_code = ?, error_message = ?, detail = ?
         WHERE id = ?`,
      )
      .run(
        new Date().toISOString(),
        outcome.status,
        outcome.errorCode ?? null,
        outcome.errorMessage ?? null,
        outcome.detail ? JSON.stringify(outcome.detail) : null,
        id,
      );
  }

  getOperation(id: number): OperationRow | undefined {
    return this.db.prepare('SELECT * FROM operations WHERE id = ?').get(id) as
      | OperationRow
      | undefined;
  }

  listOperations(filter: { networkId?: string; limit?: number } = {}): OperationRow[] {
    const limit = filter.limit ?? 100;
    if (filter.networkId) {
      return this.db
        .prepare(
          'SELECT * FROM operations WHERE network_id = ? ORDER BY id DESC LIMIT ?',
        )
        .all(filter.networkId, limit) as unknown as OperationRow[];
    }
    return this.db
      .prepare('SELECT * FROM operations ORDER BY id DESC LIMIT ?')
      .all(limit) as unknown as OperationRow[];
  }

  deleteNetwork(id: string): void {
    this.db.prepare('DELETE FROM networks WHERE id = ?').run(id);
  }

  // -------------------------------------------------------------------------
  // Faults (FailureInjector audit trail, T-3.2)

  insertFault(record: FaultRecord): void {
    this.db
      .prepare(
        `INSERT INTO faults
         (id, network_id, node_id, node_name, type, mode, state, requested_by, hold_duration_ms,
          requested_at, updated_at, finished_at, preflight, plan, evidence, result, error, reconciled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.networkId,
        record.nodeId,
        record.nodeName,
        record.type,
        record.mode,
        record.state,
        record.requestedBy,
        record.holdDurationMs ?? null,
        record.requestedAt,
        record.updatedAt,
        record.finishedAt ?? null,
        record.preflight ? JSON.stringify(record.preflight) : null,
        record.plan ? JSON.stringify(record.plan) : null,
        record.evidence ? JSON.stringify(record.evidence) : null,
        record.result ? JSON.stringify(record.result) : null,
        record.error ? JSON.stringify(record.error) : null,
        record.reconciled ? 1 : 0,
      );
  }

  updateFault(id: string, patch: {
    state?: FaultState;
    holdDurationMs?: number;
    finishedAt?: string;
    updatedAt: string;
    preflight?: FaultPreflight;
    plan?: FaultPlanStep[];
    evidence?: FaultEvidence;
    result?: FaultExecutionResult;
    error?: KaizenErrorJson;
    reconciled?: boolean;
  }): void {
    this.db
      .prepare(
        `UPDATE faults SET
           state = COALESCE(?, state),
           hold_duration_ms = COALESCE(?, hold_duration_ms),
           finished_at = COALESCE(?, finished_at),
           preflight = COALESCE(?, preflight),
           plan = COALESCE(?, plan),
           evidence = COALESCE(?, evidence),
           result = COALESCE(?, result),
           error = COALESCE(?, error),
           reconciled = COALESCE(?, reconciled),
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.state ?? null,
        patch.holdDurationMs ?? null,
        patch.finishedAt ?? null,
        patch.preflight ? JSON.stringify(patch.preflight) : null,
        patch.plan ? JSON.stringify(patch.plan) : null,
        patch.evidence ? JSON.stringify(patch.evidence) : null,
        patch.result ? JSON.stringify(patch.result) : null,
        patch.error ? JSON.stringify(patch.error) : null,
        patch.reconciled === undefined ? null : patch.reconciled ? 1 : 0,
        patch.updatedAt,
        id,
      );
  }

  getFault(id: string): FaultRecord {
    const row = this.db.prepare('SELECT * FROM faults WHERE id = ?').get(id) as
      | FaultRow
      | undefined;
    if (!row) throw new Error(`fault not found: ${id}`);
    return mapFault(row);
  }

  tryGetFault(id: string): FaultRecord | undefined {
    const row = this.db.prepare('SELECT * FROM faults WHERE id = ?').get(id) as
      | FaultRow
      | undefined;
    return row ? mapFault(row) : undefined;
  }

  listFaults(filter: { networkId?: string; nodeId?: string; limit?: number } = {}): FaultRecord[] {
    const limit = filter.limit ?? 100;
    if (filter.networkId && filter.nodeId) {
      return (
        this.db
          .prepare(
            'SELECT * FROM faults WHERE network_id = ? AND node_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?',
          )
          .all(filter.networkId, filter.nodeId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    if (filter.networkId) {
      return (
        this.db
          .prepare('SELECT * FROM faults WHERE network_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(filter.networkId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    if (filter.nodeId) {
      return (
        this.db
          .prepare('SELECT * FROM faults WHERE node_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?')
          .all(filter.nodeId, limit) as unknown as FaultRow[]
      ).map(mapFault);
    }
    return (
      this.db
        .prepare('SELECT * FROM faults ORDER BY requested_at DESC, id DESC LIMIT ?')
        .all(limit) as unknown as FaultRow[]
    ).map(mapFault);
  }

  // -------------------------------------------------------------------------
  // Scenarios (T-3.3) — create/read/update/delete of validated definitions.
  // NEVER executes anything; these rows are inert authoring data.

  /** Insert a fully validated record. Atomic (single statement); UNIQUE
   *  violations on id/name surface as SCENARIO_ALREADY_EXISTS. */
  insertScenario(record: ScenarioRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO scenarios
           (id, name, description, schema_version, tags, requires, steps, execution,
            validation, validation_status, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.name,
          record.description,
          record.schemaVersion,
          JSON.stringify(record.tags),
          JSON.stringify(record.requires),
          JSON.stringify(record.steps),
          JSON.stringify(record.execution),
          JSON.stringify(record.validation),
          record.validationStatus,
          record.createdBy,
          record.updatedBy,
          record.createdAt,
          record.updatedAt,
        );
    } catch (e) {
      throw translateScenarioConstraint(e, record.name);
    }
  }

  /**
   * Replace one record atomically (single statement). The caller has already
   * re-validated the merged scenario, so all columns are written together —
   * a failed update leaves the previous row untouched.
   */
  updateScenario(record: ScenarioRecord): void {
    let changes = 0;
    try {
      const result = this.db
        .prepare(
          `UPDATE scenarios SET
             name = ?, description = ?, schema_version = ?, tags = ?, requires = ?,
             steps = ?, execution = ?, validation = ?, validation_status = ?,
             updated_by = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          record.name,
          record.description,
          record.schemaVersion,
          JSON.stringify(record.tags),
          JSON.stringify(record.requires),
          JSON.stringify(record.steps),
          JSON.stringify(record.execution),
          JSON.stringify(record.validation),
          record.validationStatus,
          record.updatedBy,
          record.updatedAt,
          record.id,
        );
      changes = Number(result.changes);
    } catch (e) {
      throw translateScenarioConstraint(e, record.name);
    }
    if (changes === 0) {
      throw new KaizenError('SCENARIO_NOT_FOUND', `Scenario ${record.id} not found`, {
        scenarioId: record.id,
      });
    }
  }

  /** Throws SCENARIO_NOT_FOUND (missing) or read errors (malformed/version). */
  getScenario(id: string): ScenarioRecord {
    const row = this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as
      | ScenarioRow
      | undefined;
    if (!row) {
      throw new KaizenError('SCENARIO_NOT_FOUND', `Scenario ${id} not found`, {
        scenarioId: id,
      });
    }
    return mapScenarioRow(row);
  }

  /** undefined when missing; may throw structured read errors when the row
   *  cannot be parsed/supported by this build. */
  tryGetScenario(id: string): ScenarioRecord | undefined {
    const row = this.db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id) as
      | ScenarioRow
      | undefined;
    return row ? mapScenarioRow(row) : undefined;
  }

  tryGetScenarioByName(name: string): ScenarioRecord | undefined {
    const row = this.db.prepare('SELECT * FROM scenarios WHERE name = ?').get(name) as
      | ScenarioRow
      | undefined;
    return row ? mapScenarioRow(row) : undefined;
  }

  /** Newest-updated first; unparseable rows are surfaced, never dropped. */
  listScenarios(
    filter: { q?: string; tag?: string; status?: string; limit?: number; offset?: number } = {},
  ): ScenarioListResult {
    const { whereSql, params } = scenarioFilterWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT * FROM scenarios ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as unknown as ScenarioRow[];
    const scenarios: ScenarioRecord[] = [];
    const malformed: ScenarioMalformedEntry[] = [];
    for (const row of rows) {
      try {
        scenarios.push(mapScenarioRow(row));
      } catch (e) {
        malformed.push({
          id: row.id,
          code:
            e instanceof KaizenError &&
            (e.code === 'SCENARIO_MALFORMED' || e.code === 'SCENARIO_VERSION_UNSUPPORTED')
              ? e.code
              : 'SCENARIO_MALFORMED',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { scenarios, malformed };
  }

  countScenarios(filter: { q?: string; tag?: string; status?: string } = {}): number {
    const { whereSql, params } = scenarioFilterWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scenarios ${whereSql}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** true when a scenario with this name exists (any id). */
  scenarioNameExists(name: string, exceptId?: string): boolean {
    const row = exceptId
      ? (this.db
          .prepare('SELECT id FROM scenarios WHERE name = ? AND id != ?')
          .get(name, exceptId) as { id: string } | undefined)
      : (this.db.prepare('SELECT id FROM scenarios WHERE name = ?').get(name) as
          | { id: string }
          | undefined);
    return row !== undefined;
  }

  deleteScenario(id: string): boolean {
    const result = this.db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  // -------------------------------------------------------------------------
  // Scenario runs (T-3.4) — durable execution audit. Every state transition
  // rewrites the whole row in ONE statement (state + steps + timestamps
  // together), so a run record is never half-updated. No FK to scenarios:
  // history survives scenario edits and deletion.

  insertScenarioRun(record: ScenarioRunRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO scenario_runs
           (id, scenario_id, scenario_name, scenario_schema_version, network_id, network_name,
            state, current_step_id, requested_by, snapshot, target_nodes, steps, validation,
            warnings, error, cleanup, cancellation, replay_of_run_id, executor_pid,
            created_at, started_at, updated_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.scenarioId,
          record.scenarioName,
          record.scenarioSchemaVersion,
          record.networkId,
          record.networkName,
          record.state,
          record.currentStepId,
          record.requestedBy,
          JSON.stringify(record.snapshot),
          JSON.stringify(record.targetNodes),
          JSON.stringify(record.steps),
          record.validation ? JSON.stringify(record.validation) : null,
          JSON.stringify(record.warnings),
          record.error ? JSON.stringify(record.error) : null,
          record.cleanup ? JSON.stringify(record.cleanup) : null,
          record.cancellation ? JSON.stringify(record.cancellation) : null,
          // provenance is immutable and set once at insert (a replay never
          // rewrites the SOURCE row; the update statement does not touch it)
          record.replayOfRunId,
          // executor ownership is likewise set once at insert (the update
          // statement does not touch it) — consulted by startup reconciliation
          record.executorPid ?? null,
          record.createdAt,
          record.startedAt,
          record.updatedAt,
          record.finishedAt,
        );
    } catch (e) {
      throw translateScenarioRunConstraint(e, record.id);
    }
  }

  /**
   * Atomic full-row rewrite (single statement — no partial transitions).
   *
   * `cancellation` is write-once/append-only (DEC-025): a durable request
   * persisted by another process must never be clobbered back to null by a
   * concurrent full-row rewrite from this process (lost update), so the SQL
   * keeps the existing value whenever the incoming record carries none.
   */
  updateScenarioRun(record: ScenarioRunRecord): void {
    let changes = 0;
    try {
      const result = this.db
        .prepare(
          `UPDATE scenario_runs SET
             scenario_name = ?, scenario_schema_version = ?, network_id = ?, network_name = ?,
             state = ?, current_step_id = ?, snapshot = ?, target_nodes = ?, steps = ?,
             validation = ?, warnings = ?, error = ?, cleanup = ?, cancellation = COALESCE(?, cancellation),
             started_at = ?, updated_at = ?, finished_at = ?
           WHERE id = ?`,
        )
        .run(
          record.scenarioName,
          record.scenarioSchemaVersion,
          record.networkId,
          record.networkName,
          record.state,
          record.currentStepId,
          JSON.stringify(record.snapshot),
          JSON.stringify(record.targetNodes),
          JSON.stringify(record.steps),
          record.validation ? JSON.stringify(record.validation) : null,
          JSON.stringify(record.warnings),
          record.error ? JSON.stringify(record.error) : null,
          record.cleanup ? JSON.stringify(record.cleanup) : null,
          record.cancellation ? JSON.stringify(record.cancellation) : null,
          record.startedAt,
          record.updatedAt,
          record.finishedAt,
          record.id,
        );
      changes = Number(result.changes);
    } catch (e) {
      throw translateScenarioRunConstraint(e, record.id);
    }
    if (changes === 0) {
      throw new KaizenError('SCENARIO_RUN_NOT_FOUND', `Scenario run ${record.id} not found`, {
        runId: record.id,
      });
    }
  }

  /** Throws SCENARIO_RUN_NOT_FOUND (missing) or SCENARIO_MALFORMED (corrupt). */
  getScenarioRun(id: string): ScenarioRunRecord {
    const row = this.db.prepare('SELECT * FROM scenario_runs WHERE id = ?').get(id) as
      | ScenarioRunRow
      | undefined;
    if (!row) {
      throw new KaizenError('SCENARIO_RUN_NOT_FOUND', `Scenario run ${id} not found`, {
        runId: id,
      });
    }
    return mapScenarioRunRow(row);
  }

  tryGetScenarioRun(id: string): ScenarioRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM scenario_runs WHERE id = ?').get(id) as
      | ScenarioRunRow
      | undefined;
    return row ? mapScenarioRunRow(row) : undefined;
  }

  /** Newest-first; unparseable rows are surfaced, never silently dropped. */
  listScenarioRuns(
    filter: {
      scenarioId?: string;
      networkId?: string;
      state?: ScenarioRunState;
      replayOf?: string;
      unfinishedOnly?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): ScenarioRunListResult {
    const { whereSql, params } = scenarioRunFilterWhere(filter);
    const rows = this.db
      .prepare(
        `SELECT * FROM scenario_runs ${whereSql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit ?? 50, filter.offset ?? 0) as unknown as ScenarioRunRow[];
    const runs: ScenarioRunRecord[] = [];
    const malformed: ScenarioRunListResult['malformed'] = [];
    for (const row of rows) {
      try {
        runs.push(mapScenarioRunRow(row));
      } catch (e) {
        malformed.push({
          id: row.id,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { runs, malformed };
  }

  countScenarioRuns(
    filter: {
      scenarioId?: string;
      networkId?: string;
      state?: ScenarioRunState;
      replayOf?: string;
    } = {},
  ): number {
    const { whereSql, params } = scenarioRunFilterWhere(filter);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scenario_runs ${whereSql}`)
      .get(...params) as { n: number };
    return row.n;
  }

  /** Runs that never reached a terminal state (i.e. interrupted by a crash). */
  listUnfinishedScenarioRuns(): ScenarioRunRecord[] {
    const terminals = TERMINAL_SCENARIO_RUN_SQL_LIST;
    const rows = this.db
      .prepare(
        `SELECT * FROM scenario_runs WHERE state NOT IN (${terminals}) ORDER BY created_at, id`,
      )
      .all() as unknown as ScenarioRunRow[];
    const runs: ScenarioRunRecord[] = [];
    for (const row of rows) {
      try {
        runs.push(mapScenarioRunRow(row));
      } catch {
        // A corrupt unfinished row cannot be reconciled — surfaced via
        // listScenarioRuns; skipping here keeps reconciliation honest
        // (it only ever touches rows it can actually read).
      }
    }
    return runs;
  }

  // -------------------------------------------------------------------------
  // Proof-of-Resilience (T-9.5)

  upsertResilienceEvidence(runId: string, evidence: ChainEvidence): void {
    this.db
      .prepare(
        `INSERT INTO resilience_evidence (run_id, network_id, validator_id, evidence, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET network_id = excluded.network_id,
           validator_id = excluded.validator_id, evidence = excluded.evidence`,
      )
      .run(runId, evidence.networkId, evidence.validatorId, JSON.stringify(evidence), new Date().toISOString());
  }

  getResilienceEvidence(runId: string): ChainEvidence | null {
    const row = this.db.prepare('SELECT evidence FROM resilience_evidence WHERE run_id = ?').get(runId) as
      | { evidence: string }
      | undefined;
    return row ? (JSON.parse(row.evidence) as ChainEvidence) : null;
  }

  /** Returns false when a certificate with this fingerprint already exists. */
  insertResilienceCertificate(cert: ResilienceCertificate): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO resilience_certificates
         (fingerprint, run_id, validator_id, network_id, signer_address, dev, certificate, signed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        cert.fingerprint,
        cert.runId,
        cert.validatorId,
        cert.networkId,
        cert.signature.address,
        cert.signature.dev ? 1 : 0,
        JSON.stringify(cert),
        cert.signedAt,
      );
    return Number(r.changes) > 0;
  }

  getResilienceCertificate(fingerprint: string): ResilienceCertificate | null {
    const row = this.db
      .prepare('SELECT certificate FROM resilience_certificates WHERE fingerprint = ?')
      .get(fingerprint) as { certificate: string } | undefined;
    return row ? (JSON.parse(row.certificate) as ResilienceCertificate) : null;
  }

  listResilienceCertificates(filter: { validatorId?: string; runId?: string } = {}): ResilienceCertificate[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.validatorId !== undefined) {
      where.push('validator_id = ?');
      args.push(filter.validatorId);
    }
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      args.push(filter.runId);
    }
    const rows = this.db
      .prepare(
        `SELECT certificate FROM resilience_certificates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY signed_at DESC, fingerprint`,
      )
      .all(...args) as { certificate: string }[];
    return rows.map((r) => JSON.parse(r.certificate) as ResilienceCertificate);
  }

  /** Stores (or replaces) an attestation for a fingerprint. Idempotent per attester key. */
  insertResilienceAttestation(att: KaizenAttestation): boolean {
    const r = this.db
      .prepare(
        `INSERT OR REPLACE INTO resilience_attestations
         (fingerprint, attester_address, verdict, checked_at, attestation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        att.certificateFingerprint,
        att.attester.address,
        att.verdict,
        att.checkedAt,
        JSON.stringify(att),
        new Date().toISOString(),
      );
    return Number(r.changes) > 0;
  }

  listResilienceAttestations(fingerprint: string): KaizenAttestation[] {
    const rows = this.db
      .prepare('SELECT attestation FROM resilience_attestations WHERE fingerprint = ? ORDER BY checked_at DESC, attester_address')
      .all(fingerprint) as { attestation: string }[];
    return rows.map((r) => JSON.parse(r.attestation) as KaizenAttestation);
  }

  // -------------------------------------------------------------------------
  // V3 anchors (T-8.2)

  insertV3Anchor(record: V3AnchorRecord): void {
    this.db
      .prepare(
        `INSERT INTO v3_anchors (id, run_id, run_hash, method, status, payload, contract_address,
           signer_address, chain_name, genesis_hash, tx_hash, block_hash, block_number,
           extrinsic_index, error, requested_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.runHash,
        record.method,
        record.status,
        record.payload,
        record.contractAddress,
        record.signerAddress,
        record.chainName,
        record.genesisHash,
        record.txHash,
        record.blockHash,
        record.blockNumber,
        record.extrinsicIndex,
        record.error,
        record.requestedBy,
        record.createdAt,
        record.updatedAt,
      );
  }

  updateV3Anchor(record: V3AnchorRecord): void {
    this.db
      .prepare(
        `UPDATE v3_anchors SET status = ?, contract_address = ?, chain_name = ?, genesis_hash = ?,
           tx_hash = ?, block_hash = ?, block_number = ?, extrinsic_index = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        record.status,
        record.contractAddress,
        record.chainName,
        record.genesisHash,
        record.txHash,
        record.blockHash,
        record.blockNumber,
        record.extrinsicIndex,
        record.error,
        record.updatedAt,
        record.id,
      );
  }

  tryGetV3Anchor(id: string): V3AnchorRecord | undefined {
    const row = this.db.prepare('SELECT * FROM v3_anchors WHERE id = ?').get(id) as V3AnchorRow | undefined;
    return row ? mapV3Anchor(row) : undefined;
  }

  listV3Anchors(filter: { runId?: string; runHash?: string; limit?: number } = {}): V3AnchorRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.runId !== undefined) {
      where.push('run_id = ?');
      args.push(filter.runId);
    }
    if (filter.runHash !== undefined) {
      where.push('run_hash = ?');
      args.push(filter.runHash);
    }
    const sql = `SELECT * FROM v3_anchors ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    args.push(Math.min(Math.max(filter.limit ?? 100, 1), 500));
    const rows = this.db.prepare(sql).all(...args) as unknown as V3AnchorRow[];
    return rows.map(mapV3Anchor);
  }

  insertV3Contract(record: V3ContractRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO v3_contracts (address, genesis_hash, name, code_hash, deployer_address,
           chain_name, tx_hash, block_hash, block_number, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.address,
        record.genesisHash,
        record.name,
        record.codeHash,
        record.deployerAddress,
        record.chainName,
        record.txHash,
        record.blockHash,
        record.blockNumber,
        record.createdAt,
      );
  }

  listV3Contracts(filter: { genesisHash?: string } = {}): V3ContractRecord[] {
    const rows = (
      filter.genesisHash !== undefined
        ? this.db
            .prepare('SELECT * FROM v3_contracts WHERE genesis_hash = ? ORDER BY created_at DESC, rowid DESC')
            .all(filter.genesisHash)
        : this.db.prepare('SELECT * FROM v3_contracts ORDER BY created_at DESC, rowid DESC').all()
    ) as unknown as V3ContractRow[];
    return rows.map((r) => ({
      address: r.address,
      name: 'KaizenRunRegistry',
      codeHash: r.code_hash,
      deployerAddress: r.deployer_address,
      chainName: r.chain_name,
      genesisHash: r.genesis_hash,
      txHash: r.tx_hash,
      blockHash: r.block_hash,
      blockNumber: r.block_number,
      createdAt: r.created_at,
    }));
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

interface V3AnchorRow {
  id: string;
  run_id: string;
  run_hash: string;
  method: string;
  status: string;
  payload: string;
  contract_address: string | null;
  signer_address: string;
  chain_name: string | null;
  genesis_hash: string | null;
  tx_hash: string | null;
  block_hash: string | null;
  block_number: number | null;
  extrinsic_index: number | null;
  error: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
}

interface V3ContractRow {
  address: string;
  genesis_hash: string;
  name: string;
  code_hash: string;
  deployer_address: string;
  chain_name: string;
  tx_hash: string;
  block_hash: string;
  block_number: number;
  created_at: string;
}

function mapV3Anchor(row: V3AnchorRow): V3AnchorRecord {
  return {
    id: row.id,
    runId: row.run_id,
    runHash: row.run_hash,
    method: row.method as V3AnchorRecord['method'],
    status: row.status as V3AnchorRecord['status'],
    payload: row.payload,
    contractAddress: row.contract_address,
    signerAddress: row.signer_address,
    chainName: row.chain_name,
    genesisHash: row.genesis_hash,
    txHash: row.tx_hash,
    blockHash: row.block_hash,
    blockNumber: row.block_number,
    extrinsicIndex: row.extrinsic_index,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNetwork(row: NetworkRow): NetworkRecord {
  return {
    id: row.id,
    name: row.name,
    preset: row.preset as NetworkPreset,
    status: row.status as NetworkStatus,
    designatedTest: row.designated_test === 1,
    chain: row.chain as 'dev' | 'local-spec',
    chainSpecPath: row.chain_spec_path ?? undefined,
    baseDir: row.base_dir,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Translate UNIQUE constraint failures on scenarios into typed errors. */
function translateScenarioConstraint(e: unknown, name: string): KaizenError {
  if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) {
    return new KaizenError(
      'SCENARIO_ALREADY_EXISTS',
      `A scenario named "${name}" (or with the same id) already exists`,
      { name },
    );
  }
  return e instanceof KaizenError
    ? e
    : new KaizenError('SCENARIO_MALFORMED', e instanceof Error ? e.message : String(e));
}

function scenarioFilterWhere(filter: { q?: string; tag?: string; status?: string }): {
  whereSql: string;
  params: string[];
} {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.q !== undefined && filter.q !== '') {
    where.push('(name LIKE ? OR description LIKE ?)');
    params.push(`%${filter.q}%`, `%${filter.q}%`);
  }
  if (filter.tag !== undefined && filter.tag !== '') {
    where.push('tags LIKE ?');
    params.push(`%"${filter.tag}"%`);
  }
  if (filter.status !== undefined && filter.status !== '') {
    where.push('validation_status = ?');
    params.push(filter.status);
  }
  return {
    whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
    params,
  };
}

/**
 * Map one scenarios row. Throws structured errors instead of returning
 * half-parsed data: a newer schema version (downgrade) is
 * SCENARIO_VERSION_UNSUPPORTED; unparseable/shape-broken JSON is
 * SCENARIO_MALFORMED. Callers (list) collect these per row.
 */
function mapScenarioRow(row: ScenarioRow): ScenarioRecord {
  if (row.schema_version !== SCENARIO_SCHEMA_VERSION) {
    throw new KaizenError(
      'SCENARIO_VERSION_UNSUPPORTED',
      `Scenario ${row.id} was stored with schemaVersion ${row.schema_version}; this build supports ${SCENARIO_SCHEMA_VERSION}`,
      { scenarioId: row.id, stored: row.schema_version, supported: SCENARIO_SCHEMA_VERSION },
    );
  }
  try {
    const tags = JSON.parse(row.tags) as unknown;
    const requires = JSON.parse(row.requires) as ScenarioTargetRequirements;
    const steps = JSON.parse(row.steps) as unknown;
    const execution = JSON.parse(row.execution) as ScenarioExecutionPolicy;
    const validation = JSON.parse(row.validation) as ScenarioValidationResult;
    const basicShapeOk =
      Array.isArray(tags) &&
      tags.every((t) => typeof t === 'string') &&
      requires !== null &&
      typeof requires === 'object' &&
      Array.isArray(steps) &&
      steps.every((s) => s !== null && typeof s === 'object') &&
      execution !== null &&
      typeof execution === 'object' &&
      validation !== null &&
      typeof validation === 'object' &&
      typeof validation.valid === 'boolean' &&
      Array.isArray(validation.issues);
    if (!basicShapeOk) {
      throw new Error('stored scenario columns do not match the expected shape');
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      schemaVersion: row.schema_version,
      tags: tags as string[],
      requires,
      steps: steps as ScenarioRecord['steps'],
      execution,
      validation,
      validationStatus:
        row.validation_status === 'warning' ? 'warning' : 'valid',
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch (e) {
    if (e instanceof KaizenError) throw e;
    throw new KaizenError(
      'SCENARIO_MALFORMED',
      `Scenario ${row.id} cannot be parsed by this build: ${e instanceof Error ? e.message : String(e)}`,
      { scenarioId: row.id },
    );
  }
}

// --- scenario runs (T-3.4) ------------------------------------------------

/** SQL literal list of terminal run states (for unfinished-run queries). */
const TERMINAL_SCENARIO_RUN_SQL_LIST = (
  [
    'rejected',
    'completed',
    'completed-with-warnings',
    'failed',
    'cancelled',
    'cleanup-failed',
  ] as const
)
  .map((s) => `'${s}'`)
  .join(', ');

function translateScenarioRunConstraint(e: unknown, id: string): KaizenError {
  if (e instanceof KaizenError) return e;
  return new KaizenError(
    'SCENARIO_MALFORMED',
    `Scenario run ${id} could not be persisted: ${e instanceof Error ? e.message : String(e)}`,
    { runId: id },
  );
}

function scenarioRunFilterWhere(filter: {
  scenarioId?: string;
  networkId?: string;
  state?: ScenarioRunState;
  replayOf?: string;
  unfinishedOnly?: boolean;
}): { whereSql: string; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.scenarioId !== undefined) {
    where.push('scenario_id = ?');
    params.push(filter.scenarioId);
  }
  if (filter.networkId !== undefined) {
    where.push('network_id = ?');
    params.push(filter.networkId);
  }
  if (filter.state !== undefined) {
    where.push('state = ?');
    params.push(filter.state);
  }
  if (filter.replayOf !== undefined) {
    where.push('replay_of_run_id = ?');
    params.push(filter.replayOf);
  }
  if (filter.unfinishedOnly === true) {
    where.push(`state NOT IN (${TERMINAL_SCENARIO_RUN_SQL_LIST})`);
  }
  return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
}

/**
 * Map one scenario_runs row. Corrupt/unknown-shaped rows throw structured
 * errors instead of returning half-parsed data (list collects them per row).
 * Run rows are NOT version-rejected on scenario schema changes: the snapshot
 * is immutable execution history and must stay readable by later builds.
 */
function mapScenarioRunRow(row: ScenarioRunRow): ScenarioRunRecord {
  try {
    const snapshot = JSON.parse(row.snapshot) as unknown;
    const targetNodes = JSON.parse(row.target_nodes) as unknown;
    const steps = JSON.parse(row.steps) as unknown;
    const warnings = JSON.parse(row.warnings) as unknown;
    const validation = row.validation ? (JSON.parse(row.validation) as unknown) : null;
    const error = row.error ? (JSON.parse(row.error) as unknown) : null;
    const cleanup = row.cleanup ? (JSON.parse(row.cleanup) as unknown) : null;
    const cancellation = row.cancellation ? (JSON.parse(row.cancellation) as unknown) : null;
    const basicShapeOk =
      snapshot !== null &&
      typeof snapshot === 'object' &&
      Array.isArray(targetNodes) &&
      Array.isArray(steps) &&
      steps.every((s) => s !== null && typeof s === 'object') &&
      Array.isArray(warnings) &&
      warnings.every((w) => typeof w === 'string') &&
      (validation === null || (typeof validation === 'object' && validation !== null)) &&
      (error === null || (typeof error === 'object' && error !== null)) &&
      (cleanup === null || (typeof cleanup === 'object' && cleanup !== null)) &&
      (cancellation === null || (typeof cancellation === 'object' && cancellation !== null)) &&
      (SCENARIO_RUN_STATES as readonly string[]).includes(row.state);
    if (!basicShapeOk) {
      throw new Error('stored scenario run columns do not match the expected shape');
    }
    return {
      id: row.id,
      scenarioId: row.scenario_id,
      scenarioName: row.scenario_name,
      scenarioSchemaVersion: row.scenario_schema_version,
      snapshot: snapshot as ScenarioRecord,
      networkId: row.network_id,
      networkName: row.network_name,
      state: row.state as ScenarioRunState,
      currentStepId: row.current_step_id,
      targetNodes: targetNodes as ScenarioRunTargetNode[],
      requestedBy: row.requested_by,
      replayOfRunId: row.replay_of_run_id ?? null,
      executorPid: row.executor_pid ?? null,
      steps: steps as ScenarioStepRun[],
      validation: validation as ScenarioValidationResult | null,
      warnings: warnings as string[],
      error: error as ScenarioRunError | null,
      cleanup: cleanup as ScenarioRunCleanup | null,
      cancellation: cancellation as ScenarioRunCancellation | null,
      createdAt: row.created_at,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      finishedAt: row.finished_at,
      currentStepOrder:
        (steps as ScenarioStepRun[]).find((s) => s.stepId === row.current_step_id)?.order ?? null,
    };
  } catch (e) {
    if (e instanceof KaizenError) throw e;
    throw new KaizenError(
      'SCENARIO_MALFORMED',
      `Scenario run ${row.id} cannot be parsed by this build: ${e instanceof Error ? e.message : String(e)}`,
      { runId: row.id },
    );
  }
}

function mapFault(row: FaultRow): FaultRecord {
  return {
    id: row.id,
    networkId: row.network_id,
    nodeId: row.node_id,
    nodeName: row.node_name,
    type: row.type as FaultRecord['type'],
    mode: row.mode as FaultRecord['mode'],
    state: row.state as FaultState,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at ?? undefined,
    holdDurationMs: row.hold_duration_ms ?? undefined,
    preflight: row.preflight ? (JSON.parse(row.preflight) as FaultPreflight) : undefined,
    plan: row.plan ? (JSON.parse(row.plan) as FaultPlanStep[]) : undefined,
    evidence: row.evidence ? (JSON.parse(row.evidence) as FaultEvidence) : undefined,
    result: row.result ? (JSON.parse(row.result) as FaultExecutionResult) : undefined,
    error: row.error ? (JSON.parse(row.error) as KaizenErrorJson) : undefined,
    reconciled: row.reconciled === 1,
  };
}

function mapNode(row: NodeRow): NodeRecord {
  const ports: NodePorts = {
    p2p: row.p2p_port,
    rpc: row.rpc_port,
    ws: row.ws_port,
    prometheus: row.prom_port,
  };
  return {
    id: row.id,
    networkId: row.network_id,
    name: row.name,
    role: row.role as NodeConfig['role'],
    chain: row.chain as 'dev' | 'local-spec',
    chainSpecPath: row.chain_spec_path ?? undefined,
    wellKnownKey: (row.well_known_key as NodeConfig['wellKnownKey']) ?? undefined,
    bootnodes: JSON.parse(row.bootnodes) as string[],
    baseDir: row.base_dir,
    nodeKeyFile: row.node_key_file,
    logFile: row.log_file,
    ports,
    status: row.status as NodeStatus,
    pid: row.pid ?? undefined,
    startedAt: row.started_at ?? undefined,
    expectedPeers: row.expected_peers ?? 0,
  };
}
