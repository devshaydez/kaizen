# Kaizen: Project Specification

Status: LOCKED (Phase 0, 2026-10-09). Changes require an explicit decision entry in `docs/DECISIONS.md`.

### Product positioning statement

Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.

## 1. Problem Statement

Operating a Substrate-based blockchain network (Portaldot) requires juggling node
processes, chain specs, peer wiring, keys, and failure recovery: usually through
raw CLI flags and log-scraping. There is no tool in the Portaldot ecosystem that
lets a developer **create, monitor, deliberately break, diagnose, recover, and
deploy** a Portaldot network as one coherent, observable workflow.

Kaizen fills that gap: a node-operations and infrastructure-management platform
for Portaldot, with a web UI and a CLI that drive **real infrastructure
operations** through a shared backend engine.

## 2. Product Goals

- Make local Portaldot multi-node networks reproducible with one command / one click.
- Make failure a first-class, *controlled* experiment (Failure Lab), not an accident.
- Make every operation observable: status, logs, timelines, results, errors.
- Make validator operations accessible where the official runtime exposes them.
- Make deployment to Docker and Kubernetes/Helm a genuine, verified capability.
- Keep the web UI and CLI on one shared operations engine: no divergent logic.

## 3. Non-Goals

- Not a block explorer, wallet, or trading interface.
- Not a hosted/managed service; it runs on the operator's machine/cluster.
- Not a claim of compatibility with every cloud provider.
- Not automated root-cause analysis: Kaizen detects and presents **symptoms and
  evidence**; it does not invent root causes it cannot prove.
- Not a substitute for production-grade validator key custody (no HSM support).

## 4. Target Users

1. **Portaldot developers**: need a local multi-node network to test dApps.
2. **Node operators / SREs**: need monitoring, failure drills, recovery runbooks.
3. **Hackathon/demo audience**: need a visually impressive, real end-to-end workflow.

## 5. Core Lifecycle

```
CREATE → MONITOR → BREAK → DIAGNOSE → RECOVER → DEPLOY
```

Every feature maps to at least one stage of this lifecycle.

## 6. Locked Scope

### 6.1 Local network operations (P0)
- Create local Portaldot networks from topology presets: single-node, two-node,
  four-validator, validator-plus-full-node, and custom (where technically feasible).
- Manage multiple node processes and their configurations (base-path, ports,
  chain spec, bootnodes, roles).
- Start, stop, restart, inspect nodes.
- Inspect peer connections and network state.
- Monitor sync, block height, node health, logs, runtime info.
- Meaningful operation status and error reporting.

### 6.2 Validator operations (P1)
- Display validator status and runtime information.
- Inspect staking and session information.
- Support validator configuration and session-key operations **only where the
  official runtime exposes them** and only where prerequisites, permissions,
  and effects are understood.
- Never fabricate validator states, staking results, or session information.

### 6.3 Failure Lab (P0)
- Controlled experiments: stop/restart a node, disconnect a peer, simulate a
  network partition where feasible, pause/disrupt a validator process where
  feasible, restore connectivity and recover nodes.
- All failure operations: restricted to a designated test network, guarded,
  and recorded in an observable execution history.

### 6.4 Scenarios and replay (P0)
- Create and save reusable scenarios: ordered actions with timing.
- Execute scenarios against selected test networks.
- Record actions, timestamps, results, errors.
- Deterministic **action replay** where the environment allows it. Kaizen
  distinguishes deterministic action replay from identical blockchain outcomes :
  the latter is never claimed.

### 6.5 Incident detection and diagnostics (P0)
- Detect failures from real signals: process exit, RPC unreachable, peer loss,
  block production stall, runtime events (e.g. `imOnline.SomeOffline`).
- Track affected nodes and network changes; build incident timelines.
- Collect logs and diagnostic evidence; expose recovery operations; record outcomes.
- Label findings as symptoms/evidence, never as unproven root-cause claims.

### 6.6 Deployment (P1/P2)
- Local process execution: P1 (primary, verified path).
- Docker-based deployment: P1 (investigate → implement).
- **Kubernetes + Helm: P2 wow-factor: planned, not abandoned.** Investigated
  early (Phase 0) for blockers. If a genuine blocker arises: document evidence,
  propose fallback, never silently drop the feature.

### 6.7 Interfaces (all phases)
- **Web UI**: primary visual interface for actual operations.
- **CLI**: scriptable interface for power users and automation.
- **Shared engine**: both invoke the same application services.
- **API + realtime**: HTTP for commands/queries, WebSocket for events (see
  `docs/ARCHITECTURE.md`, DEC-003).

## 7. Functional Requirements (summary)

- FR-1: The backend owns all infrastructure operations. The frontend never
  controls host processes directly and never executes arbitrary shell commands.
- FR-2: CLI and web UI call the same engine services; no duplicated operation logic.
- FR-3: Every operation returns typed status, duration, and structured errors.
- FR-4: Every mutating operation is logged with actor, target, timestamps, result.
- FR-5: Failure operations require an explicit designated-test-network target and
  are refused otherwise.
- FR-6: All displayed chain/node data comes from real RPC or process signals.
- FR-7: Secrets (node keys, keystore passwords) never appear in logs, API
  responses, or the repository.
- FR-8: Long-running operations support timeout and cancellation with cleanup.

## 8. Acceptance Criteria (Phase-0-level, global)

- AC-1: `kaizen` CLI can create, start, stop, and inspect a real local Portaldot
  network of ≥2 nodes that actually peer and produce blocks.
- AC-2: Web UI shows live data (block height, peers, health) from a real running
  network, updating via WebSocket.
- AC-3: A saved scenario can be executed and replayed with a recorded history.
- AC-4: A failure experiment (e.g. kill one validator) produces a detectable
  incident with timeline and evidence, and a recorded successful recovery.
- AC-5: A Helm chart deploys a multi-node Portaldot network to a local
  Kubernetes (minikube) with health feedback: or a documented, evidenced
  blocker with an accepted fallback.

## 9. Explicitly Deferred / Unsupported

- Mainnet/production deployment operation (read-only investigation only; any
  mainnet interaction requires an explicit future decision).
- Windows native node support (upstream ships no Windows binary; WSL only).
- ink! contract tooling (upstream Contracts pallet is legacy, pre-rent-model).
- Multi-cloud portability matrices (single local K8s target for now).
- Guaranteed identical blockchain outcomes on replay (see 6.4).

## 10. Main User Journeys

1. **Quickstart network**: pick "four-validator" preset → CREATE → watch MONITOR
   (peers/height/health) → stop.
2. **Failure drill**: select running network → Failure Lab → "isolate validator-2"
   → observe incident timeline → RECOVER → verify healed.
3. **Scenario**: author "partition-and-recover" scenario → run → inspect recorded
   history → replay.
4. **Validator inspection**: open validator node → staking/session readouts →
   supported config ops.
5. **Deploy**: export network definition → deploy via Helm to minikube → monitor.
