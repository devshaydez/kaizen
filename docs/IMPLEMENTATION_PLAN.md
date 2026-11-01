# Implementation Plan

Status: ACTIVE (created Phase 0, 2026-10-09).

Statuses: `NOT STARTED` · `IN PROGRESS` · `BLOCKED` · `IMPLEMENTED` · `VERIFIED`.
`IMPLEMENTED` ≠ `VERIFIED`: a task is VERIFIED only after its acceptance
criteria were tested and evidence recorded in `docs/PROGRESS.md`.

Priority mapping: P0 = essential working core, P1 = core completeness,
P2 = planned wow-factor (Kubernetes/Helm: investigated early, never abandoned).

Dependency notation: "→" means "depends on".

---

## Phase 1: Foundation & Node Lifecycle Core (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-1.1 | Scaffold npm-workspaces monorepo (TS strict, eslint, vitest, root scripts) | - | P0 | `npm install` + `npm run build` + `npm test` pass on empty-ish packages; layout matches ARCHITECTURE §11 | run commands; CI-ready output | VERIFIED |
| T-1.2 | Engine core types + StateStore (SQLite: networks, nodes, runs, history) | T-1.1 | P0 | typed models for NetworkDefinition/NodeConfig/OperationResult; migrations run; store unit-tested | vitest unit tests | VERIFIED |
| T-1.3 | BinaryManager: download `portaldot_dev`+`subkey`, cache in `.kaizen/bin`, SHA-256 TOFU record | T-1.2 | P0 | fresh env can fetch binary; hash recorded; `--version` runs from cache; idempotent re-run | integration test w/ real download (env-gated) | VERIFIED |
| T-1.4 | NodeProcessManager: argv-array spawn, per-node base-path, port allocation, log capture, SIGTERM→SIGKILL stop, restart, DB-wedge detection | T-1.3 | P0 | start dev node → reaches block production; stop within timeout; no orphan procs; SIGKILL+restart recovers DB; wedge detected | integration test vs real node | VERIFIED (see note †) |
| T-1.5 | PortaldotRpcClient (@polkadot/api over WS): health/peers/sync/header/events; reconnect w/ backoff | T-1.3 | P0 | WS client connects to live node; returns typed snapshots; survives node restart (reconnects) | integration test vs real node | VERIFIED |
| T-1.6 | NetworkService: single + two-node presets via build-spec chain-spec generation; create/start/stop/inspect services | T-1.4, T-1.5 | P0 | one call creates a real 2-node network that peers and finalizes; inspect returns real peerIds/heights | integration test replicating Phase 0 experiment through the engine | VERIFIED |
| T-1.7 | CLI skeleton (`kaizen network create/start/stop/status`, `--json`) | T-1.6 | P0 | CLI drives the same services; `--json` output parseable; exit codes correct | shell-driven smoke test w/ real network | VERIFIED |
| T-1.8 | API skeleton (Fastify REST + Zod validation + WS event bus) | T-1.6 | P0 | REST endpoints mirror engine ops; invalid input → 400 with structured error; WS streams engine events | supertest + live smoke | VERIFIED |
| T-1.9 | Phase-1 test suite + docs update (PROGRESS/TESTING/RESEARCH status flips) | T-1.7, T-1.8 | P0 | suite green; evidence recorded | `npm test`; docs diff review | VERIFIED |

† T-1.4 "wedge detected" split: **crash/wedge *death* detection** (unexpected
exit → `crashed` state + log tail; startup wedge → `STARTUP_FAILED`) and
cross-process **adopted stop** (CLI short-lived processes vs daemon nodes) are
implemented and live-verified in Phase 1. **Alive-but-stalled runtime
detection** (process healthy, no blocks: the Phase 0 DB-wedge signature) is
monitoring work and lives in **T-2.4** (MonitoringService state machine), as
planned.

## Phase 2A: Topology Engine & Live Monitoring (P0)

Split from Phase 2 (2026-10-10): engine-side topology/monitoring/API work is
completed and verified BEFORE any UI work starts (T-2.5…T-2.7 remain Phase 2B).

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-2.1 | Inspect Local Testnet genesis authorities; topology preset model as data (single/two/four-validator/validator-fullnode/custom) with pure validation | T-1.6 | P0 | authority set documented in RESEARCH (R-05 flip); presets+custom validation pure and unit-tested; invalid topologies rejected before any side effect | unit tests + live spike evidence in PROGRESS | VERIFIED |
| T-2.2 | ChainSpecService: per-network spec generation (plain → authority patch with binary-derived keys → raw), audit sidecar, purge/reset support | T-2.1 | P0 | 4-authority patched spec generated from the real binary; sidecar records baked-in authorities; purge resets chain data but keeps identity | unit tests (fake binary) + live 4-validator test | VERIFIED |
| T-2.3 | Four-validator + validator+fullnode + custom presets; ordered start/stop; per-node start/stop; expected-peer verification | T-2.2 | P0 | 4 validators full-mesh with all four authoring + finality; full node syncs and authors nothing; node-level ops work; stop/start cycles clean | live integration tests | VERIFIED |
| T-2.4 | MonitoringService: HTTP RPC sampling loop, health state machine (unknown/healthy/unhealthy/unavailable/stale), overlap prevention, typed monitor events, auto-cleanup on network stop | T-1.5, T-2.3 | P0 | samples ≥1/2s cadence; crash → unhealthy with reason; unreachable → unavailable; loop never overlaps; polling stops with the network | unit tests + live monitoring test | VERIFIED |
| T-2.8 | API/WS surface extension: network CRUD + lifecycle + purge, node detail/start/stop, monitoring snapshots, typed events (network.created, monitor.*) with validation and structured errors | T-2.4, T-1.8 | P0 | REST endpoints mirror engine services only; invalid input → structured 400/404/409; WS streams typed monitor/network events with timestamps+ids | live API integration tests (REST + WS) | VERIFIED |
| T-2.9 | Phase 2A test suite + docs (PROGRESS/PLAN/RESEARCH/DECISIONS/TESTING/RISKS/ARCHITECTURE/README) + phase report | T-2.3, T-2.4, T-2.8 | P0 | suite green; evidence recorded; IMPLEMENTED vs VERIFIED distinguished; report written | `npm test`, live suite, docs diff review | VERIFIED |

## Phase 2B: Web UI (P0, complete)

Built on the Phase 2A API/engine. The UI renders ONLY real API/WS data
(DEC-009); the browser never launches processes: every operation goes
through the backend (FR-1).

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-2.5 | Web app scaffold (Vite+React): layout, typed API client, WS client with reconnect, network list/create view, Overview/Events screens | T-1.8, T-2.8 | P0 | UI creates and lists real networks; no mock data anywhere | component tests (jsdom) + live client test against real backend | VERIFIED |
| T-2.6 | Live network dashboard: network detail (identity, nodes, live monitoring table with peers/head/finalized/sync/health, lifecycle controls) + node detail page | T-2.4, T-2.5 | P0 | live values update in real time from a real network; unreachable fields shown explicitly, never invented | component tests + `webclient.int.test.ts` (real nodes; values cross-checked vs raw RPC). NOTE: live tables poll REST at a bounded 5s cadence (paused when not running); WS events drive invalidation + the event feed: real-time, but not per-value WS pushes | VERIFIED |
| T-2.7 | Log capture & tail API/UI: engine `nodeLogTail`, `GET …/nodes/:nodeId/logs`, node-detail log pane with bounded auto-refresh while running | T-2.2, T-2.5 | P1 | tail works for any managed node; UI shows real log bytes | live webclient test (real log bytes from a running node) + component tests. Scope note: bounded-refresh follow, no since-timestamp streaming | VERIFIED |
| T-2.10 | Phase 2B test suite + docs (PLAN/PROGRESS/ARCHITECTURE/TESTING/RISKS/README) + phase report (2A report archived) | T-2.5, T-2.6, T-2.7 | P0 | suite green; evidence recorded; IMPLEMENTED vs VERIFIED distinguished; report written | `npm test`, live suite, docs diff review | VERIFIED |

## Phase 3: Failure Lab & Scenarios (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-3.1 | Fault mechanism study: peer disconnect (reserved-peer RPC vs rewire), pause (SIGSTOP/SIGCONT), partition (isolation strategy) on single host | T-2.3 | P0 | each mechanism proven with evidence; documented in RESEARCH | capability matrix R-22 (TECHNICAL_RESEARCH); 10 recorded spike runs (`test/experiments/t31-spike.mjs`, logs `t31-*.log`); gates green (typecheck/lint/build/unit 113/live 30) | VERIFIED 2026-10-12 (B1/C1/C3 partial: negative results proven; see R-22) |
| T-3.2 | FailureInjector with safeguards (designated-test-network gate, dry-run preview, timeouts, cleanup) | T-3.1 | P0 | destructive op refused on non-test target; every fault logged w/ actor/target/result | `faults.int.test.ts` LIVE 5/5 against real `portaldot_dev` (pause + terminate verified with independent test-side RPC observation; blocked mechanisms → typed 409; cross-network escape refused; audit hygiene); `fault.test.ts` 23 unit (gate, lifecycle, conflicts, cancel, quarantine/reconcile, redaction, event payloads); PROGRESS 2026-10-12 (Phase 3B) | VERIFIED 2026-10-12 (pause+terminate implemented; peer-disconnect/partition typed-blocked with unblock paths: R-22 T-3.2 table) |
| T-3.3 | Scenario model + authoring (ordered actions, delays, conditions; CRUD + validation) | T-3.2 | P0 | invalid scenarios rejected with precise errors; valid saved to SQLite | `scenario.test.ts` 32 unit (model/registry/normalization/determinism/conditions/policy/secrets/capabilities); `scenario-store.test.ts` 11 (CRUD, restart reload, dup/malformed/version rows, atomic updates); `apps/api/test/scenarios.test.ts` 18 (real app + SQLite: CRUD, validate-without-save, structured errors, filters, no-execution guarantees, no execute/replay routes); gates green (typecheck/lint/build/unit 202, live regression 35); PROGRESS 2026-10-14 (Phase 3C) | VERIFIED 2026-10-14 (registry mirrors injector adapters: blocked ops never executable; authoring has zero execution surface per DEC-020) |
| T-3.4 | ScenarioEngine execution w/ per-action recording (timestamps, results, errors) + cancellation | T-3.3 | P0 | scenario runs against live network; history complete incl. failures | `scenario-run.test.ts` 37 unit (state machines, all 10 pre-execution gates as persisted refusals, step order/evidence, policies incl. inconclusive, timeouts, cancellation, cleanup-failure quarantine, crash reconciliation, shutdown); `apps/api/test/scenario-runs.test.ts` 9 (202 execute flow, status/list/cancel, gate refusals as 4xx + persisted rejected runs, no-injector guarantee); `scenario-runs.int.test.ts` LIVE 8/8 against real `portaldot_dev` (pause w/ independent effect+recovery observation, sequential steps, precondition abort + live skip-step, cancel during hold, STEP_TIMEOUT, phantom-network + label gates); gates green (typecheck/lint/build/unit 248, live 43); PROGRESS 2026-10-16 (Phase 3D) | VERIFIED 2026-10-16 (execution is engine-side only; CLI/UI surfaces are T-3.6, replay is T-3.5) |
| T-3.5 | Replay (deterministic action replay with documented semantics) | T-3.4 | P0 | replay re-executes same action sequence; UI/CLI states replay≠identical-outcome | `scenario-replay.test.ts` 10 unit (distinct run + provenance, source immutability, snapshot vs edited/deleted scenario, eligibility rules incl. rejected/unfinished/malformed, auth posture, gate re-evaluation incl. quarantine/conflict/unsupported op, failed-source semantics, cancel + STEP_TIMEOUT on replays, duplicate-replay conflict, `?replayOf` query, store reopen); `apps/api/test/scenario-runs.test.ts` +4 = 13 (202 replay + replayNote + source untouched over the wire, 400/404/409 validation, persisted rejections with provenance, concurrent duplicate 409); `scenario-runs.int.test.ts` LIVE 9/9 (replay on real `portaldot_dev`: fresh effect sampled independently, fresh fault id, source byte-identical, provenance query, ineligible/unknown-target refusals); gates green (typecheck/lint/build/unit 262, live 44); PROGRESS 2026-10-18 (Phase 3E) | VERIFIED 2026-10-18 (replay reuses the T-3.4 executor unchanged; DEC-022) |
| T-3.6 | CLI + API + UI surfaces for Failure Lab & scenarios | T-3.4, T-2.5 | P0 | full flow usable from both CLI and UI | e2e smoke | **PARTIAL: T-3.6A VERIFIED 2026-10-21 (CLI + API audit); T-3.6B IMPLEMENTED 2026-10-21 (web UI, jsdom-verified)**: CLI `kaizen scenario …` / `kaizen run …` over the shared engine (see DEC-024/DEC-025). Web: imported console design wired to the typed client + WS (Failure Lab, Scenarios, run cancel/replay, V3 hand-off). **REMAINING for VERIFIED**: a live UI smoke against a running portaldot_dev network (real browser or webclient-style transport test): not possible on the arm64 sandbox this session (no x86_64 userland; RSK-31). See PHASE_REPORT (Phase 3F/8B) |
| T-3.6B | Web-UI integration of the imported console design (framer-motion) over the real API: shell + lifecycle stepper, Overview live topology, node drawer (detail/logs/diagnostics/start-stop), Failure Lab (pause/terminate execute after confirm, dry-run, live fault log, roll back), Scenarios (CRUD/validate/execute/cancel/replay), Incidents (fault evidence), Deployments (local processes), Validators, Settings; unbuilt features disabled + labelled with their phase | T-3.6A, T-2.5 | P0 | every screen renders only API/WS data; destructive actions confirm first; blocked/planned features labelled, never simulated (DEC-009); gates green | 49 web unit/jsdom tests (6 files: shell, overview, drawer, lab, scenarios, create, validators, incidents, deployments, settings, view-model) + typecheck/lint/build; live UI smoke PENDING (RSK-23, RSK-31) | IMPLEMENTED |
| T-3.6C | Console + landing match the original Kaizen design (p001–p009): bundled fonts (Hanken Grotesk / Bodoni Moda / Source Code Pro), full landing (stats, is/isn't, lifecycle wave, break-one illustration, one-line commands, Proven on Portaldot V3, where it runs, six ways, FAQ, CTA, footer), console shell (sidebar, lifecycle pills, network chip, watermarks), Overview/Failure Lab/failure-active/Incident/Deployments layouts on real data, Networks page; real `kaizen up` CLI command | T-3.6B | P0 | design layouts render real API/WS data only; unbuilt targets labelled (Docker/K8s Phase 6, disconnect/partition R-22); gates green | 61 web jsdom tests + 5 `kaizen up` tests (fake engine) + typecheck/lint/build; headless-Chromium screenshots over fixture API (docs/assets/ui); live UI smoke and live `kaizen up` PENDING (RSK-23, RSK-31) | IMPLEMENTED |

## Phase 4: Incident Detection & Diagnostics (P0)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-4.1 | Signal collectors: process exit, RPC unreachable, peer drop, block stall, `imOnline.SomeOffline` (WS events) | T-2.4 | P0 | each signal fires on induced fault; recorded | integration test w/ fault injection | NOT STARTED |
| T-4.2 | Incident model + correlation + timeline (affected nodes, network deltas) | T-4.1 | P0 | induced fault produces one incident w/ ordered timeline | integration test | NOT STARTED |
| T-4.3 | Evidence collection (log excerpts, RPC snapshots, artifact paths) + retention | T-4.2 | P0 | incident carries retrievable evidence bundle | integration test | NOT STARTED |
| T-4.4 | Recovery operations (restart, reconnect, purge/reinit) + outcome recording | T-3.2, T-4.2 | P0 | recovery from induced fault recorded w/ outcome; network returns healthy | integration test | NOT STARTED |
| T-4.5 | Incident UI/CLI views (timeline, evidence, symptom labeling: never unproven root-cause claims) | T-4.3, T-4.4, T-2.5 | P0 | UI shows incident + evidence from real run | e2e smoke | NOT STARTED |

## Phase 5: Validator Operations (P1)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-5.1 | Read-only validator/session/staking views (era, session, validators, prefs) from real storage | T-2.3 | P1 | values come from chain storage; unknowns shown as unknown, never invented | integration test | NOT STARTED |
| T-5.2 | Session-key inspection (keystore presence, `Session.Keys` decode from metadata) | T-5.1 | P1 | decoded against live metadata V13 | integration test | NOT STARTED |
| T-5.3 | Guarded staking ops (bond/validate/chill on throwaway local net) with effect explanation | T-5.1 | P1 | extrinsic submitted via @polkadot/api succeeds; events recorded; documented effects | integration test | NOT STARTED |
| T-5.4 | `setKeys` flow (generate → insert keystore → setKeys → verify) where prerequisites met | T-5.2 | P1 | full loop verified or documented BLOCKED with evidence | integration test | NOT STARTED |

## Phase 6: Deployment: Docker + Kubernetes/Helm (P1/P2 wow-factor)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-6.1 | Node Docker image (multi-stage, non-root, healthcheck) + build smoke test | T-1.3 | P1 | image builds; container runs `--dev`; RPC answers | docker run + RPC probe | NOT STARTED |
| T-6.2 | DockerAdapter (deploy/status/logs/destroy multi-node on one host) | T-2.2, T-6.1 | P1 | engine deploys 2-node net in Docker; peers verified | integration test | NOT STARTED |
| T-6.3 | Helm chart for multi-node Portaldot (StatefulSets, PVCs, headless service, readiness from RPC) | T-6.1 | P2 | `helm lint` clean; installs on minikube; pods become ready | helm install on minikube | NOT STARTED |
| T-6.4 | K8sHelmAdapter + deployment health monitoring + recovery path | T-6.3, T-2.4 | P2 | deploy/status/logs/destroy/recover via engine; UI shows cluster health | integration test on minikube | NOT STARTED |
| T-6.5 | Deployment surfaces in CLI/UI (deploy target selection, feedback) | T-6.2, T-6.4, T-2.5 | P2 | full deploy flow from UI and CLI | e2e smoke | NOT STARTED |

## Phase 7: Hardening, Testing & Reproducible Setup (P1)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-7.1 | End-to-end suite: CREATE→MONITOR→BREAK→DIAGNOSE→RECOVER→DEPLOY scripted demo | all P0 | P1 | one command runs the full lifecycle on a clean machine | recorded run | NOT STARTED |
| T-7.2 | Reproducible setup (README quickstart verified from scratch, pinned versions, checksums) | T-7.1 | P1 | fresh-clone quickstart works following only README | clean-env rehearsal | NOT STARTED |
| T-7.3 | Security pass: argv validation, RPC exposure audit, secret handling review, `.gitignore` hygiene | T-6.5 | P1 | checklist in TESTING.md all green | manual audit + tests | NOT STARTED |
| T-7.4 | Error-handling & UX polish pass (structured errors everywhere, timeouts, cancellation) | all | P1 | no unhandled rejections; every failure path yields actionable message | fault-injection tests | NOT STARTED |
| T-7.5 | Demo materials (scripted walkthrough, seeded scenarios, screenshots) | T-7.1 | P2 | demo reproducible in <15 min | rehearsal | NOT STARTED |

---

## Phase 8: V3 Connectivity (external endpoints)

No `PHASE_8_PLAN.md` was supplied with the T-8.1 brief (2026-10-19); this
section records the task exactly as scoped there. T-8.2 (on-chain run
anchoring) was briefed for the Portaldot Hacker House Week 2 submission
(2026-10-21) and is recorded below. Wallet authorization / other T-8.x work
remains **undefined and not started**.

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-8.1 | Portaldot V3 connectivity probe: typed endpoint configuration (official V3 endpoints as overridable defaults) + independent read-only probes of Substrate WS (connect, chain name, health, best header), EVM JSON-RPC (validated envelope/IDs, `eth_chainId` matched against config: mismatch ≠ success, HTTP 200 ≠ healthy), and explorer HTTP (availability only, documented scope); deterministic cleanup on success/failure/timeout; credential-free results (origin-redacted endpoints, scrubbed messages); offline unit suite via injected fakes; env-gated live probe | - | P0 | (a) defaults: `wss://test-node-v3.portaldot.dev`, `https://test-evm-rpc-v3.portaldot.dev`, `https://node-console.portaldot.dev`, chain id 420420777, overridable via explicit options/`KAIZEN_V3_*`; (b) per-endpoint typed statuses `ok/unavailable/timeout/protocol-error/malformed-response/mismatch`; (c) endpoints probed independently (failure of one never suppresses another); (d) no writes/signing/auth; no arbitrary-URL probing surface; (e) unit tests cover the required matrix offline; (f) live probe on configured endpoints gated `KAIZEN_TEST_V3=1` with observations recorded (never reported as passed when skipped/blocked) | unit `packages/engine/test/v3-probe.test.ts` (21/21 mocked); live `test/integration/v3-probe.int.test.ts` (1/1 with gate; 1 skipped without: 2026-10-19) | VERIFIED |
| T-8.2 | V3 on-chain run anchoring: deterministic run hash (SHA-256 of canonical run JSON), KaizenRunRegistry (Solidity → EVM bytecode on pallet-revive) deploy/anchor/verify, `system.remarkWithEvent` fallback, env-only signer, SQLite anchor/contract records persisted before submission, CLI `kaizen v3 …`, API `/api/v3/*`, console V3 screen (probe, anchors, verify, anchor-with-confirm) | T-8.1, T-3.4 | P0 | (a) registry deployed on the V3 TEST network with recorded evidence; (b) real Failure Lab runs anchored by contract AND remark, finalized; (c) verify recomputes the hash and re-reads the chain (block hash, `anchoredAt`, `eth_getCode` / remark); (d) failed submissions recorded as failed, never as anchored; (e) secrets never logged/committed; (f) UI shows evidence with node-console links and requires explicit confirm to write | engine `v3-anchor.test.ts` (fake chain, incl. recompute of every committed evidence hash), API `v3.test.ts`, CLI `v3-commands.test.ts`, web `V3.test.tsx` (6, renders committed evidence); LIVE on PortaldotV3 Test (chain id 420420777): deploy block 136822, contract anchors 136899/136919, remark anchors 136940/136947, all re-verified via API 2026-10-21 (`docs/evidence/`, screenshot `docs/assets/node-console-block-136899.webp`); gated write suite `KAIZEN_TEST_V3_WRITE=1` | VERIFIED (UI screen: IMPLEMENTED, jsdom + live API read smoke) |

## Phase 9: Proof-of-Resilience (DEC-029, docs/RESILIENCE_SCORE.md)

| ID | Task | Deps | Pri | Acceptance criteria | Verification | Status |
|----|------|------|-----|---------------------|--------------|--------|
| T-9.1 | Chain-bound evidence: best/finalized heads (number + hash) before/during/after the fault; recovery metrics (time-to-recover, finality gap, blocks missed); verify re-fetches every hash (offline → unverifiable) | T-3.4 | P0 | metrics pure + tested; verify never upgrades; offline/missing/mismatch distinguished | `resilience-evidence.test.ts` (11), `resilience-verify.test.ts` (6); live: `test/integration/resilience.int.test.ts` on x86_64 CI | IMPLEMENTED (live: see PROGRESS 2026-10-24) |
| T-9.2 | Signed certificates: SHA-256 fingerprint over canonical `{run, runHash, chain}`; sr25519 signature; signer from env/file outside the repo; labelled dev key for local nets | T-9.1 | P0 | tampering detected; secrets never echoed; dev key refused off local nets | `resilience-certificate.test.ts` (8) | IMPLEMENTED |
| T-9.3 | Resilience score v1 (0–100) + spec; trust model v2 specified | T-9.2 | P0 | pure, deterministic, worked examples pinned | `resilience-score.test.ts` (12); docs/RESILIENCE_SCORE.md | IMPLEMENTED (v2 PLANNED) |
| T-9.4 | `KaizenResilienceRegistry` (Solidity → EVM bytecode for pallet-revive) + codec | T-9.2 | P1 | committed artifact; selectors cross-checked; logic tested | `resilience-registry.test.ts` (7); `contracts/test-resilience-registry.mjs` in-memory EVM 6/6 | IMPLEMENTED — DEPLOYED on V3 2026-10-24 (T-9.8) |
| T-9.5 | Engine `ResilienceService` (opt-in capture, certify, score, verify), CLI `certify/certificates/score/verify-certificate`, read-only `/api/resilience/*`, live test + x86_64 workflow | T-9.1–T-9.3 | P0 | thin surfaces over the engine; no HTTP signing | `resilience-service.test.ts` (6), CLI `resilience-commands.test.ts` (3), API `resilience.test.ts` (4) | IMPLEMENTED |
| T-9.6 | Trust model v2: future-block-hash-seeded drills (commit-reveal) | T-9.5 | P0 | RESILIENCE_SCORE.md §7.1 | `resilience-drill-seed.test.ts` (4) | IN PROGRESS — step 1 `deriveDrill` + step 2 `DrillRecord` build/check landed; next: on-chain commit, reveal at finalized N, certificate `drill` field, verifier check |
| T-9.7 | Trust model v2: BABE authorship + GRANDPA finality evidence from public RPC; evidence-class score weighting (score v2) | T-9.5 | P0 | §7.2–7.3 | — | NOT STARTED |
| T-9.8 | Deploy `KaizenResilienceRegistry` on the V3 test network; engine `ResilienceRegistryService` (deploy / record / read, persist-first journal, free `recorded()` pre-check); CLI `v3 deploy-resilience-registry`, `v3 anchor-certificate`, `v3 resilience-score`; anchor a real CI certificate and read it back | T-9.4, T-9.5 | P0 | on-chain code = committed artifact; CertificateRecorded observed; getScore read-back; no secret in output | `resilience-onchain.test.ts` (11), CLI `v3-resilience-registry-commands.test.ts` (4); live: docs/evidence/v3-resilience-registry-v1.json | IMPLEMENTED — live on V3 (registry `0x8ec2b52a…764a`, blocks 167466 / 167478) |

---

## Milestone Gates

- **G1 (end Phase 1)**: engine can manage a real single node end-to-end; API+CLI exist.
- **G2 (end Phase 2)**: 4-node network created from UI with live monitoring.
- **G3 (end Phase 4)**: full BREAK→DIAGNOSE→RECOVER loop demonstrated with history.
- **G4 (end Phase 6)**: Helm deploys the same network class to minikube (wow-factor).
- **G5 (end Phase 7)**: reproducible demo from clean clone.

## Explicit Risk-First Sequencing Note

T-6.3/T-6.4 (K8s/Helm) carry the highest uncertainty (R-08/R-18, RSK-04/RSK-11).
Although P2, a **feasibility spike** (minikube start + bare chart install of a
single Portaldot pod) should be scheduled no later than mid-Phase 2 so blockers
surface early; full implementation stays in Phase 6.
