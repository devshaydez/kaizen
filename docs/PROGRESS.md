## 2026-10-30 — P1 certificate metadata integrity

**Files modified**: `packages/engine/src/resilience/certificate.ts`, `packages/engine/src/resilience/service.ts`, `packages/engine/src/resilience/verify.ts`, `packages/engine/test/resilience-certificate.test.ts`, `packages/engine/test/resilience-service.test.ts`, `docs/PROGRESS.md`.
**Work done**: Certificate integrity now checks the top-level run ID, run hash, validator ID, and network ID against the supplied run and chain evidence. Scoring excludes certificates failing any metadata check, and full verification reports metadata mismatches as integrity failures. Added individual tampering regressions for validatorId, networkId, runHash, and run ID, including score exclusion assertions.
**Verification**: `git diff --check` and `npm run build -w @kaizen/engine` passed. `npm ci` completed with engine warnings under Node v20.20.2. Focused Vitest tests could not execute: Node 20 lacks the required built-in `node:sqlite` module (zero tests ran). `npm run typecheck` also failed in downstream CLI checks because `@kaizen/engine` declarations were not found and existing implicit-any/unknown errors surfaced; engine package typecheck/build itself passed. Project requires Node >=24; CI should rerun the focused tests and full typecheck on supported Node.
**Problems / decisions / remaining work**: Full acceptance tests and full repository typecheck remain unverified due unsupported Node version in this environment.
**Next step**: Push the feature branch and open the requested PR into `main`.

---

## 2026-10-30 — UI polish: benchmark-driven screens and reduced-motion interactions

**Files modified**: `apps/web/src/App.tsx`, `apps/web/src/components/ui.tsx`, `apps/web/src/components/ProofChecklist.tsx`, `apps/web/src/pages/Landing.tsx`, `apps/web/src/pages/Live.tsx`, `apps/web/src/pages/Networks.tsx`, `apps/web/src/styles.css`, `docs/PROGRESS.md`.
**Work done**: Landing hero now pairs the risk and response in one sentence and gives the visitor one clear “Run Drill Now” CTA. Sidebar groups existing routes into Actions and Inspect without removing routes. Live run/certificate results show a plain-language checklist from the evidence already fetched, including explorer links when existing evidence provides them; no additional fetches. Networks deduplicates display rows by network id and uses a compact name, preset, status and node-count layout without changing selection or network logic. Added purposeful 150–200ms ease-out page, sidebar, landing-section and checklist entrances, button hover/tap feedback, and small landing-card hover/tap feedback, honoring the reduced-motion preference. Reused existing framer-motion; no dependency added. Existing honest replay/live, test-network and evidence-status labels remain intact.
**Verification**: `git diff --check` passed. Environment is Node v20.20.2, below repository-required Node >=24. `npm run typecheck -- --pretty false` could not start because `tsc` is not installed. `npm run build --workspace @kaizen/web` could not start because `vite` is not installed. CI on Node 24 must verify typecheck and build. Full test suite not run, as requested.
**Problems / decisions / remaining work**: Local rendering/build/typecheck could not be verified because dependencies are absent and Node 20 is unsupported. No new data fetching or dependencies introduced.
**Next step**: CI on Node 24 should verify typecheck/build after this branch is pushed and a PR is opened.

---

## 2026-10-30 — T-DOC-POS: consistent Kaizen positioning

**Files modified**: `README.md`, `apps/web/index.html`, `apps/web/src/pages/Landing.tsx`, `docs/PROJECT_SPEC.md`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROGRESS.md`.
**Work done**: Applied the approved line once beneath the README heading and once in the PROJECT_SPEC product-positioning introduction. Replaced the landing hero tagline and footer descriptor, and used the same line for the HTML title and meta description. Copy only; no application behavior changed.
**Verification**: `git diff --check` passed. `npm run build --workspace @kaizen/web` passed; Vite emitted existing `use client` directive and large-chunk warnings. Exact tagline placement was checked in source. No app logic changed.
**Problems / decisions / remaining work**: Added decision DEC-030 because PROJECT_SPEC is locked; added task T-DOC-POS. A pre-existing untracked `docs/BUSINESS.md` was left untouched and excluded. One PR against `main` is pending.
**Next step**: Commit T-DOC-POS on `docs/kaizen-positioning-line`, push, and open one PR against `main` with the requested title.

---

## 2026-10-30 — T-DOC-BIZ: business case documentation

**Files modified**: `docs/BUSINESS.md`, `docs/PROGRESS.md`.
**Work done**: Added a concise business case describing the validator reliability problem, the three requested user/customer groups, open-source CLI adoption, registry-backed certificate history, and a badge served by the live page. Clearly scoped current drills to local test networks and the registry's supported certificate anchors to Portaldot V3 testnet; explicitly states local-network results are not claims about mainnet behavior or guaranteed uptime. Hosted scheduled drills and chain-wide pre-upgrade drills are labeled planned, not current offerings. No prices, revenue, user counts, or partnerships added.
**Verification**: `git diff --check` passed; reviewed against `docs/PROJECT_SPEC.md`, `docs/RESILIENCE_SCORE.md`, and `docs/ARCHITECTURE.md`. Documentation-only change; no test suite run.
**Problems / decisions / remaining work**: Pull request review and CI remain pending.
**Next step**: Commit task T-DOC-BIZ on this feature branch and open one PR titled `docs: add business plan`.

---

# Engineering Progress Log

Chronological, append-only. Every entry records the date, task IDs, files touched,
work done, actual verification results, problems, decisions, remaining work, and
an exact next step.

---

## 2026-10-30 — documentation synchronization (T-3.6C, T-9.1 to T-9.5)

**Files modified**: `docs/ARCHITECTURE.md`, `docs/PHASE_REPORT.md`, `docs/PHASE_REPORT_v1.md` (verbatim archive), `docs/PROGRESS.md`.
**Work done**: Replaced the stale Phase 0 architecture status with an explicit implemented/partially implemented/planned matrix and 2026-10-30 revision date. Documented resilience evidence capture/verification, certificates, score v1 and the partially implemented but undeployed `KaizenResilienceRegistry.sol`. Kept IncidentMonitor and Docker/Kubernetes adapters visibly planned. Replaced the current phase report with T-3.6C and T-9.1 through T-9.5 status, separating unit tests, real local-network integration tests, public Portaldot V3 transactions, browser tests with mock data, and full live-browser verification. Added the localhost-only, unauthenticated API warning and the planned Host/Origin and WebSocket cross-origin controls before remote deployment; noted the registry duplicate-fingerprint design blocker.
**Verification (actual results)**: Documentation content was reconciled against the dated records in `docs/PROGRESS.md`, including T-3.6C screenshot rendering with fixture API data and the T-9.1 local-network workflow. The previous `PHASE_REPORT.md` from `main` was copied byte-for-byte to `PHASE_REPORT_v1.md`. `git diff --check` is pending. No application tests or runtime verification were run for this documentation-only change. The separate certificate metadata integrity source/test changes are excluded from the docs-only PR.
**Problems / decisions / remaining work**: Full live-browser verification remains unverified; API origin validation and authentication remain planned. IncidentMonitor and Docker/Kubernetes adapters remain unimplemented. Registry stays undeployed pending duplicate-fingerprint design resolution.
**Next step**: Run `git diff --check`, commit only `docs/ARCHITECTURE.md`, `docs/PHASE_REPORT.md`, `docs/PHASE_REPORT_v1.md`, and `docs/PROGRESS.md` on the dedicated documentation branch, then open one PR into `main`.

---

## 2026-10-29 — on-demand live drills and 30-minute refresh cadence

Chronological, append-only. Every entry records the date, task IDs, files touched,
work done, actual verification results, problems, decisions, remaining work, and
an exact next step.

---

## 2026-10-29 — A3/A4: live-first web console and honest data labels

**Files modified**: `apps/web/src/pages/Live.tsx`, `apps/web/src/pages/publicMonitor.tsx`, `apps/web/src/pages/publicMonitor.test.ts`, `apps/web/src/pages/Overview.tsx`, `apps/web/src/pages/Validators.tsx`, `apps/web/src/components/ConsoleDataNotice.tsx`, `apps/web/src/components/ConsoleDataNotice.test.ts`, `apps/web/src/App.tsx`, `docs/PROGRESS.md`.
**Work done**: Added a 15-second public Portaldot V3 monitor card using `chain_getHeader` and `chain_getFinalizedHead`; rendered published demo bundle anchor fields (`txHash`, `blockNumber`, `finality`, `signerAddress`) on Live and identify the selected anchor as live bundle data. Overview, Validators, Networks, Lab, Scenarios, Incidents, Deployments, Settings, and Create are marked REPLAY, with published drill data primary where relevant and committed fixtures identified as fallback. Live and V3 identify their live endpoints separately from recorded drill evidence. Added explicit not-implemented notices for hosted replay actions not backed by the live control plane. Added focused Vitest tests for monitor source fetches and the route source map.
**Verification**: `git diff --check` passed on Node v20.20.2. `node_modules`, Vitest, and TypeScript executables are absent, so Vitest, TypeScript checks, and builds could not be run locally. Per repository policy, CI on GitHub Actions must cover Vitest, typecheck, and builds. No Vercel deployment was performed.
**Problems / decisions / remaining work**: No published live-chain values were fabricated. Local test/build verification is pending CI. A3/A4 changes have not yet been committed or reviewed by CI.
**Next step**: Run `git diff --check` on the complete change, set the requested git identity, commit additively, push `feat/a3-a4-live-console`, and open a PR that records CI requirements and route labels.

---

## 2026-10-29 — demo-publisher: publish independently checkable anchor evidence

**Files modified**: `scripts/demo/publish-drill.mjs`, `docs/PROGRESS.md`.
**Work done**: Extended each published index drill's `anchor` object with the anchor transaction hash, block number, finalized/in-block status, and signer address from the keyring-backed anchor result. Missing fields remain null, so skipped and failed anchors stay honestly marked by their original status. The full drill bundle already includes the anchor result. Anchoring behavior was not changed.
**Verification**: `node --check scripts/demo/publish-drill.mjs` and `git diff --check` both passed. No live-chain anchor was run, so no on-chain values were added.
**Problems / decisions / remaining work**: No on-chain values were fabricated; skipped anchors retain `status: "skipped"` with null evidence fields.
**Next step**: Commit this feature branch and open a pull request.

---
## 2026-10-09: PHASE 0: Foundation, Technical Discovery & Build Governance

**Phase/Task IDs**: Phase 0 (discovery); feeds tasks T-1.x planning.
**Files created/modified**: `README.md` (replaced 1-line stub),
`AGENTS.md`, `docs/PROJECT_SPEC.md`, `docs/TECHNICAL_RESEARCH.md`,
`docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PROGRESS.md`
(this file), `docs/DECISIONS.md`, `docs/TESTING.md`, `docs/RISKS.md`.
No application code written (per Phase 0 constraints).

### 1. Workspace & environment inspection (actual results)

- Git: branch `main`, up to date with `origin/main`
  (`https://github.com/Shaydez-Defi/kaizen`), **clean working tree**, single
  commit `1bcbc0c Initial commit`. Existing files: `README.md` (content:
  `# kaizen`), `LICENSE` (MIT, © 2026 shaydez). Nothing overwritten beyond the
  trivial README stub; no uncommitted user work existed.
- Toolchain present: Node v24.21.0, npm 11.19.0, Docker 29.8.0 (daemon
  running), kubectl v1.37.0, **Helm v4.3.0**, minikube (at
  `/usr/local/bin/minikube`), Python 3.14.2, Go 1.27.1, **no Rust/cargo**.
- Hardware: x86_64, 2 vCPU, 7.8 GiB RAM, ~19 GiB free disk.
- Kubernetes: **no cluster reachable** (`kubectl cluster-info` → connection
  refused on localhost:8080). Recorded as R-18 UNVERIFIED, not blocked.

### 2. Portaldot investigation (commands executed → actual results)

All probes run 2026-10-09 in `/tmp/opencode/portaldot-probe` (outside repo;
nothing machine-level installed; all processes stopped afterwards).

1. `curl api.github.com/repos/portaldotVolunteer/Portaldot-node/contents/` →
   4 tarballs (testnet/mainnet × ubuntu/macos); testnet-ubuntu = 29,591,898 B.
2. Download + extract → `portaldot_dev`, `subkey`.
3. `./portaldot_dev --version` → `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu`.
4. `--help` → full older-generation Substrate CLI (R-02): `--dev`,
   `--chain`, `--alice…--ferdie/--one/--two`, `--validator`, `--base-path`,
   `--port/--rpc-port/--ws-port`, `--bootnodes`, `--node-key-file`,
   `--prometheus-port` (metrics on by default), `--rpc-methods`, subcommands
   `build-spec`, `purge-chain`, `key {generate-node-key, insert, inspect…}`.
5. Single-node run `--dev --alice` (ports 30343/19933/19944) → BABE blocks
   every ~6 s, peer id logged, Prometheus at 9615. **R-03 VERIFIED.**
6. HTTP RPC probes → real responses for `system_health`, `system_chain`
   ("Development"), `system_name` ("Portaldot Node"), `system_version`,
   `system_peers`, `system_localPeerId`, `system_syncState`,
   `chain_getHeader`, `state_getRuntimeVersion` (specName `portaldot`,
   specVersion **1002**, 13 runtime APIs). **R-07/R-08 VERIFIED.**
7. `build-spec --chain local --raw --disable-default-bootnode` → 1,488,964 B
   raw spec; non-raw shows `Local Testnet` / `local_testnet` / chainType
   `Local`; genesis runtime keys include babe, grandpa, staking, session,
   sudo, imOnline, balances, indices, treasury, authorityDiscovery, vesting,
   gilt, transactionStorage. **R-10 VERIFIED.**
8. **2-node network experiment** (script `/tmp/.../multinode-test.sh`):
   Alice (30353/19953/19964/9715) + Bob with
   `--bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<AlicePeer>` (30354/19954/19965/9716)
   → both `system_health.peers = 1`, peers listed with `roles: "AUTHORITY"`,
   identical best block (#7, hash `0x38ba8…7f3f`), finality progressing
   (`finalized #5` on both). **R-04 VERIFIED: multi-node local networks work.**
9. `state_getMetadata` → magic `meta`, **metadata V13** (matches ecosystem
   notes). **R-15 VERIFIED.** (First attempt failed: `--tmp` + `--base-path`
   are mutually exclusive: recorded as a real constraint.)
10. `file`/`ldd` on binary → glibc dynamic x86_64 (libstdc++, libz, libgcc_s,
    libc). Docker daemon running. **R-17 PARTIALLY VERIFIED (feasible, no
    image built).**
11. Stop test → `kill` (SIGTERM) both nodes; `pgrep -x portaldot_dev` → no
    orphans. **R-09 PARTIALLY VERIFIED (clean exit observed; DB-flush proof
    pending T-1.4).**
12. Docs cross-check: official readthedocs (local test, system RPC, staking
    and session extrinsics, imOnline events, chain info) fetched; staking
    surface is full modern NPoS (R-12), session exposes `setKeys`/`purgeKeys`
    (R-13), imOnline exposes `AllGood`/`HeartbeatReceived`/`SomeOffline`
    (R-14). Ecosystem prior art (`portaldot-dev-kit`, a different hackathon
    project) documented for its V13 signing quirk + DB-wedge note (R-16); no
    code reused.

### 3. Problems encountered

- `pkill -f "<pattern>"` matched the invoking shell itself and killed the
  probe script → switched to `pkill -x portaldot_dev` (exact name). Noted for
  test-harness design.
- `--tmp` + `--base-path` mutual exclusion surfaced via a clap error →
  recorded; engine must never emit both.
- Backgrounded `&&`-chains lost variable scope in shell probes → switched to
  standalone script files for multi-step experiments.

### 4. Decisions made

DEC-001…DEC-010 recorded in `docs/DECISIONS.md` (TS monorepo; in-process CLI
engine; REST+WS; argv-only process orchestration; SQLite; deployment adapter
interface; TOFU binary hashes; test-network gate for failure ops; no
fabrication; phased evidence-based delivery).

### 5. Deliverable status (Phase 0 checklist)

| Deliverable | Status |
|---|---|
| Workspace/environment report | DONE (this log + §1) |
| Portaldot capability matrix w/ statuses | DONE (`docs/TECHNICAL_RESEARCH.md`, R-01…R-20) |
| Initial architecture proposal | DONE (`docs/ARCHITECTURE.md`) |
| Stack recommendation + justification | DONE (DEC-001 + ARCHITECTURE §10) |
| Prioritized implementation plan (IDs, ACs) | DONE (`docs/IMPLEMENTATION_PLAN.md`, T-1.1…T-7.5) |
| Risk register | DONE (`docs/RISKS.md`, RSK-01…RSK-20) |
| Documentation structure | DONE (9 docs + README) |
| Root-level AGENTS.md | DONE |
| Unresolved questions + exact experiments | DONE (ARCHITECTURE §12, RESEARCH "Next step" per entry, plan spike note) |
| Phase 1 task specification | DONE (plan Phase 1 table + "Exact next action" below) |

### 6. Remaining work / exact next step

**STOP after Phase 0** (per instruction). Next session starts Phase 1 with
**T-1.1**: scaffold the npm-workspaces monorepo per `docs/ARCHITECTURE.md` §11
(packages/engine, packages/cli, apps/api, apps/web), TS strict config, vitest,
`npm run build` + `npm test` green: then commit as a reviewable unit and
update this log.

---

## 2026-10-09: PHASE 1: Foundation & Node Lifecycle Core (T-1.1…T-1.9)

**Phase/Task IDs**: T-1.1 (scaffold), T-1.2 (types+StateStore), T-1.3
(BinaryManager), T-1.4 (NodeProcessManager), T-1.5 (PortaldotRpcClient),
T-1.6 (NetworkService), T-1.7 (CLI), T-1.8 (API), T-1.9 (suite+docs).
**Status**: all VERIFIED (see `docs/IMPLEMENTATION_PLAN.md` + note † there).

### 1. What was built

Runnable npm-workspaces monorepo (TS 5.9 strict, eslint 9 flat config, vitest):

- **`packages/engine`**: the single shared operations engine (DEC-002):
  - `types.ts`/`errors.ts`: typed models (NetworkDefinition, NodeRecord,
    OperationResult, RpcSnapshot incl. head + **finalized**) and the
    `KaizenError` taxonomy (structured code/message/details).
  - `state/store.ts`: SQLite (`node:sqlite` DatabaseSync, zero native deps)
    with schema migrations (v1), networks/nodes/operations CRUD, operation→
    network linking.
  - `binary/manager.ts`: TOFU SHA-256 manifest, idempotent `setup()` with
    cached-tarball re-verification, tar extraction with layout validation,
    `--version` smoke check; frozen platform URL table (linux-x64,
    darwin-x64/arm64; win32 → `UNSUPPORTED_PLATFORM` with WSL guidance).
    Never downloads at startup: explicit setup only.
  - `process/`: probe-bind PortAllocator (31000–34999 default),
    `buildNodeArgs`+`assertSafeArgs` (argv arrays only; forbids `--tmp`,
    external RPC hosts per DEC-004/DEC-008), NodeProcessManager (settle
    check → `STARTUP_FAILED` + log tail; pid files; `STALE_PROCESS`;
    SIGTERM→SIGKILL; **intrinsic crash detection**; **cross-process adopted
    stop** via persisted pid/pidfile; `unref()` + log-fd stdio so nodes
    survive CLI/API exit, daemon-style).
  - `rpc/client.ts`: `@polkadot/api` WsProvider client: typed snapshots
    (chain/name/version/health/sync/header/runtime incl. spec 1002),
    best-effort `system_peers` + raw `system_localPeerId` + finalized head,
    head subscriptions, structured `RPC_CONNECTION_FAILED`/`RPC_ERROR`.
  - `network/service.ts`: create (key generation, chain-spec generation for
    two-node, static bootnodes from real peer ids), start (health-gated via
    HTTP `system_health`, rollback on failure), stop (dependent-first order,
    adopted stops), inspect (live snapshot per node), remove (running-guard),
    full operation history.
  - `engine.ts`: `createEngine()` factory wiring store/manager/networks and
    crash → DB-status detection.
- **`packages/cli`**: commander CLI over the same engine (in-process):
  `setup`, `status`, `network create|list|start|stop|status|remove`, `--json`
  everywhere, structured errors, meaningful exit codes.
- **`apps/api`**: Fastify + Zod: REST mirroring engine ops, structured
  error envelopes, WS `/api/events` broadcasting engine events, bound to
  127.0.0.1:4310. **No setup endpoint** (binary acquisition stays a CLI
  decision). Routes registered in a plugin scope so `@fastify/websocket`'s
  `onRoute` hook applies (see bug 6 below).
- **`apps/web`**: Phase 1 ships only the Vite+React scaffold page (real UI
  is Phase 2+; nothing mocked, nothing faked: DEC-009).

### 2. Verification (commands → actual results)

- `npm run typecheck` → clean; `npm run lint` → clean; `npm run build` →
  clean (engine→cli→api→web).
- `npm test` → **32/32 unit tests pass** (6 files).
- `KAIZEN_TEST_LIVE=1 npm run test:integration` (final run) →
  **16/16 live tests pass, 5/5 files, 96 s**:
  - `binary.int` (1): fresh download+verify+smoke; idempotent re-run.
  - `process.int` (4): start/health/duplicate-refusal/SIGTERM-stop with no
    orphans; invalid flag → `STARTUP_FAILED` + log tail; cross-process
    adopted stop (second manager instance, idempotent re-stop); external
    SIGKILL → `crashed` + SIGKILL recorded + restart recovers chain DB
    (height before ≥ after restart).
  - `rpc.int` (5): real snapshot (Development, `portaldot@1002`, real
    `12D3KooW…` peer id, finalized ≤ head, peers `[]` on solo dev);
    subscription delivers advancing heads; dead port → structured
    `RPC_CONNECTION_FAILED`; `readSnapshot` one-shot; node stop+restart →
    same client reconnects and reads resume (T-1.5 restart AC).
  - `network.int` (2): single-node lifecycle incl. finalized read +
    history + no orphans; **two-node: `peers ≥ 1` both, bidirectional
    peer-id cross-check, AUTHORITY roles, identical best hash, equal
    progressing finalized heights** (T-1.6 "peers and finalizes" AC).
  - `api.int` (4): health, Zod 400 envelope, real create/list delegation,
    WS hello + engine events.
- CLI smoke (13/13 steps, `/tmp/opencode/cli-smoke.sh`): fresh setup
  download → status → create → duplicate/invalid-name errors with correct
  exit codes + JSON envelope → list → start → status (real RPC height/
  peers/spec; `process=running` cross-process) → parseable `--json` →
  stop (adopted) → remove → empty list.
- Hygiene: `pgrep -ax portaldot_dev` after every suite → **no orphans**;
  secret/key scan over the diff → nothing (only doc comments); no `.kaizen/`,
  `*.db`, `*.nodekey`, or `dist/` tracked (`.gitignore` verified).

### 3. Problems encountered (all found BY the live layer, fixed, tested)

Recorded in `docs/TESTING.md` §4.4 with details; the significant ones:
`withTimeout` void-resolution broke every "graceful stop" check (false
`STOP_TIMEOUT` on success); `WsProvider(url, false)` never connects;
`key generate-node-key` prints peer id to stderr; `api.provider` is
undefined on @polkadot/api v17 (raw RPC via held provider reference instead);
`isPidAlive(0)` has process-group kill semantics; websocket routes registered
before the plugin loads are silently non-websocket; **short-lived CLI
processes could not stop daemon nodes, and the failed stop nulled the pid,
which let `remove()` delete a live node's data dir** (adopted stop + keep-
record-on-failure); crash-vs-stopped state depended on an `onExit` hook.

### 4. Decisions made (new; DEC-001…DEC-010 unchanged)

- Child stdio → log file descriptors + `child.unref()`: nodes are daemons
  that outlive CLI/API processes; stop works across processes via persisted
  pid (proven by test). Rationale recorded in code comments + TESTING §4.4.
- `node:sqlite` DatabaseSync chosen over better-sqlite3 (zero native deps,
  Node 24 built-in); TS pinned 5.9.3 (TS 7 too new for the toolchain).
- Engine accepts `binaryCacheDir` so tests share one binary cache per machine.
- Node keys are pre-generated at network **create** for both presets (stable
  peer id recorded in bootnodes; key material never in DB/logs/argv).
- Runtime-stall ("alive but wedged") detection split to T-2.4 monitoring
  (note † in IMPLEMENTATION_PLAN); Phase 1 covers crash/startup-failure
  detection.

### 5. Docs updated

`docs/IMPLEMENTATION_PLAN.md` (T-1.1…T-1.9 → VERIFIED + note †),
`docs/PROGRESS.md` (this entry), `docs/TESTING.md` (new §4: suite layout,
results, caught-bug ledger, skip semantics), `docs/TECHNICAL_RESEARCH.md`
(R-06 → VERIFIED: WS proven via @polkadot/api; R-04 evidence extended with
engine-native two-node convergence), `README.md` (Phase 1 status + real
install/CLI quickstart).

### 6. Remaining work / exact next step

**STOP after Phase 1** (per instruction). Next session starts Phase 2 with
**T-2.1**: inspect the Local Testnet genesis authority set from a real
exported spec (flip R-05), define topology presets as data: then T-2.2
ChainSpec service + T-2.3 4-validator/validator+fullnode presets, T-2.4
MonitoringService, T-2.5 web app scaffold over the existing WS event API.

## 2026-10-10: PHASE 2A: Topology Engine & Live Monitoring (T-2.1…T-2.4, T-2.8, T-2.9)

**Phase/Task IDs**: Phase 2A (split from Phase 2; UI tasks T-2.5…T-2.7 stay
NOT STARTED as Phase 2B: stopped here per instruction).
**Files created/modified**: engine `src/types.ts`, `src/errors.ts`,
`src/index.ts`, `src/engine.ts`, `src/events/bus.ts`, `src/state/store.ts`,
`src/network/service.ts`, NEW `src/network/topologies.ts`, NEW
`src/network/chainspec.ts`, NEW `src/monitor/{sampler,health,service}.ts`;
tests NEW `test/{topologies,chainspec,monitor,service}.test.ts` +
`test/store.test.ts`; API `apps/api/src/server.ts`; CLI
`packages/cli/src/index.ts`; live tests NEW
`test/integration/{topology,monitor}.int.test.ts` + extended
`test/integration/api.int.test.ts`; docs PLAN/RESEARCH/DECISIONS/RISKS/
ARCHITECTURE/TESTING/README + this entry + NEW `docs/PHASE_REPORT.md`.

### 1. T-2.1/T-2.2 live spike (before implementation; artifacts /tmp/opencode/t21)

- Local Testnet plain spec seeds exactly **two** genesis authorities (Alice
  `5GrwvaEF…`, Bob `5FHneW46x…`, `staking.validatorCount=2`); Charlie/Dave/Eve
  are funded in genesis balances but are NOT authorities.
- Key derivation verified by reproducing Alice's/Bob's genesis entries with
  `key inspect`: babe/imOnline/authDiscovery = sr25519(//X); **grandpa =
  ed25519(//X)**.
- Patched plain spec (4 authorities in session.keys/stakers/invulnerables,
  validatorCount=4) → `build-spec --chain <file> --raw` → live 4-node
  network: **full mesh (peers=3 on every node)**, identical genesis hash
  `0x2b9bd419…`, **all four authored blocks** (alice=36, bob=58, charlie=50,
  dave=42 after ~8 min), GRANDPA finality advancing (finalized 12 vs best 14).
- 5th keyless full node: peers=4, synced to network best (95=95),
  `isSyncing=false`, 0 blocks authored.
- R-05 and R-10 flipped to VERIFIED with this evidence.

### 2. Implementation (engine owns everything; CLI/API stay thin)

- `topologies.ts`: 5 presets as data (single/two-node/four-validator/
  validator-fullnode custom) + pure `resolveTopology()` custom validation
  (unique names, unique well-known keys for validators only, ≥1 validator,
  ≤8 nodes): runs before any dir/port/process side effect.
- `chainspec.ts`: ChainSpecService: plain spec → typed authority patch with
  keys derived from the binary at create time (DEC-011) → raw rebuild →
  `chain-spec.genesis.json` audit sidecar; unpatched spec for topologies
  whose authorities are already in stock (alice+bob).
- `service.ts`: topology-driven create with **partial-create rollback**
  (dirs removed, ports released, no debris), ordered start/stop, per-node
  `startNode/stopNode`, `purgeChain` (refuses while any node alive; wipes
  chain DBs; keeps identity/ports/spec), expected-peers wiring.
- `monitor/`: HTTP JSON-RPC sampler (parallel single-method POSTs,
  per-method tolerance), pure `evaluateNodeHealth()` (states
  unknown/healthy/unhealthy/unavailable/stale; process liveness checked
  first: see §4.1), MonitoringService (one job per network, in-flight
  guard, unref'd timers, auto-attach/detach via `network.status` events,
  `snapshotNow()` on demand).
- `state/store.ts`: migration v4/v5: `nodes.started_at` (sticky via
  COALESCE) and `nodes.expected_peers`; idempotent `close()`.
- `events/bus.ts`: `network.created`, `monitor.sample/health/peers/error`,
  `operation.completed` gains nodeId.
- API: custom topology body, purge/monitor/node-detail/node-start/node-stop
  routes, structured codes (404 NODE_NOT_FOUND, 409 NODE_NOT_RUNNING, …).
- CLI: `--preset` (all 5), `--nodes` custom spec, `network purge`,
  `network monitor`, `node list/get/start/stop`.

### 3. Gates (commands + actual results)

- `npm run typecheck` → clean; `npm run lint` → clean; `npm run build` → ok.
- Unit `npm test`: **81/81 pass (10 files)** (Phase 1 had 32).
- Live `KAIZEN_TEST_LIVE=1 npm run test:integration`:
  - first full run: 23/25: two failures, both real findings (§4);
  - after fixes: api 6/6, monitor 1/1 re-run green;
  - final full run: **25/25 pass (7 files), 213 s**: topology (4-validator,
    validator+fullnode, custom, invalid-topology-no-debris,
    purge+restart-from-genesis, concurrent creation), monitor (real samples,
    crash → unhealthy, peers 1→0 transition, cleanup on stop, on-demand
    snapshot honesty), api (validation 400s, node ops, monitor honesty on a
    stopped network, purge refusal, WS typed events), plus Phase 1's
    binary/process/rpc/network suites;
  - `pgrep -ax portaldot_dev` after the suite → no orphans.
- Secret scan of `git diff` (keys/mnemonics/64-hex) → no matches; new files
  carry no key material; `.kaizen/` remains gitignored.

### 4. Bugs the new tests caught (fixed; regression-tested)

1. **Health precedence**: the process-death check ran AFTER the RPC-failure
   branch, so a never-started or dead node reported `unknown`/`unavailable`
   instead of `unhealthy` (a dead process can never answer RPC: process
   evidence must win). Fixed + unit test; live API test now sees
   `unhealthy` for non-running nodes.
2. **Stdio drain race**: `runBinaryCapture`/chainspec `run`/version smoke
   resolved on `child.on('exit')`, which can precede stdio drain: under
   concurrent key generation the peer-id line (stderr) was occasionally
   lost (`Could not parse peer id …: <empty>`). Fixed everywhere: `close`
   event + signal-aware error text. Caught by the concurrent-creation live
   test (a previously green test).
3. Earlier in-phase unit-test fixes: `lastHeadAdvanceAt` closure bug
   (health), `PromiseFulfilledResult.value` misuse (sampler), non-idempotent
   `StateStore.close()`.

### 5. Decisions made (new; DEC-001…DEC-010 unchanged)

DEC-011 (authority patching derives keys from the binary: never hardcoded
chain data), DEC-012 (monitoring = HTTP RPC sampling + pure health machine),
DEC-013 (uptime/expected-peers persisted; chain data disposable via purge),
DEC-014 (custom topology validation rules), DEC-015 (event-driven monitor
lifecycle + on-demand snapshots).

### 6. Remaining work / exact next step

Phase 2B web UI (T-2.5 scaffold → T-2.6 dashboard over the typed WS stream →
T-2.7 log tail): deliberately NOT started; this phase stops at the engine/
API/CLI boundary per instruction. Next session begins T-2.5.

## 2026-10-12: PHASE 2B: Web UI & Live Operations Dashboard (T-2.5, T-2.6, T-2.7, T-2.10)
**Phase/Task IDs**: Phase 2B (web UI over the Phase 2A API/engine; Failure
Lab / K8s NOT started: recorded as remaining work).
**Files created/modified**:
- `apps/web/`: NEW src tree: `api/{types,client,events}.ts`, `state/
  {useAsync.ts,EventsContext.tsx}`, `components/{Layout,States,StatusBadge,
  ConfirmDialog,OperationButton,fmt}.tsx|ts`, `pages/{Overview,Networks,
  CreateNetworkForm,NetworkDetail,NodeDetail,Events}Page.tsx`, `App.tsx`,
  `main.tsx`, `styles.css`; tests NEW `src/**/*.test.{ts,tsx}` +
  `src/test-utils/{fake,fixtures,render}`; `index.html`, `tsconfig.json`,
  `vite.config.ts`, `package.json` (react-router-dom, testing-library, jsdom).
- `apps/api/src/server.ts`: NEW `GET …/nodes/:nodeId/logs` (Zod query);
  node-detail route now samples on demand when no snapshot is stored (DEC-017).
- `packages/engine/src/network/service.ts`: NEW `nodeLogTail()` (read-only
  tail of a node's captured log via the engine's existing `readLogTail`).
- root `package.json` (typecheck now covers `apps/web`), `vitest.config.mts`
  (web tests included), `test/integration/webclient.int.test.ts` (NEW live),
  `test/integration/api.int.test.ts` (contract update for DEC-017),
  `docs/{ARCHITECTURE,DECISIONS,IMPLEMENTATION_PLAN,RISKS,TESTING,README}` +
  this entry + NEW `docs/PHASE_REPORT.md` (2A report archived to
  `docs/reports/PHASE_02A_REPORT.md`).

### 1. What was built (screens + integration)

Five screens, all rendering real API/WS data only (DEC-009), desktop +
mobile responsive, keyboard/focus styles, confirmation modals for
purge/remove:

- **Overview**: fleet metrics DERIVED from `GET /api/networks` +
  per-running-network `GET …/monitor` (networks/running/unhealthy/total
  nodes), per-network health rollups, recent event feed, empty/loading/
  error/disconnected states.
- **Networks**: list (name/topology/status/node count/created) with client
  filter, create form for all 5 presets incl. a custom node editor; server
  validation errors (code + per-field issues) rendered verbatim.
- **Network detail**: identity/persistence facts, nodes table (role/status/
  key/ports/expected peers), live monitoring table (health + reasons, peers
  n/expected, best/finalized, sync, uptime, sample age; `unreachable` cells
  when RPC is down; "monitoring runs while running" note when stopped),
  lifecycle controls (start/stop; purge/remove behind confirm + disabled
  while running), per-network recent events.
- **Node detail**: identity/process (pid, started, ports, bootnodes), live
  chain data with explicit `RPC unreachable` state (error text shown, no
  invented numbers), connected-peers table, real log tail (auto-refresh
  while running), node start/stop.
- **Events**: app-wide feed from the single WS (kind filter, timestamps,
  ids, payload disclosure), reconnect banner that states missed events are
  NOT replayed, clear-view control.

Integration layer: one typed `KaizenApiClient` (base URL, timeouts: 300s
start / 120s stop, structured `ApiError` with issues) + one
`KaizenEventStream` in React context (capped backoff + jitter reconnect,
last-unsubscribe teardown, `resync` → pages refetch REST). Engine models
imported `import type`-only. Bounded polling: monitor 5s (running only),
logs 10s (running only), overview 10s (active only), networks 3s
(starting/stopping only). Browser never launches processes (FR-1).

### 2. Gates (commands + actual results)

- `npm run typecheck` → OK (now includes `tsc -p apps/web --noEmit`).
- `npm run lint` → OK (0 problems).
- `npm run build` → OK; web bundle 304.15 kB (93.28 kB gzip). Rolldown
  emits a benign `use client` directive warning from react-router: not
  our code, bundle works.
- `npm test` → **113 passed (17 files)** = 81 pre-existing (unchanged) +
  32 NEW web tests (client, events stream, 6 page/component suites).
- `KAIZEN_TEST_LIVE=1 npm run test:integration` → full suite
  **30 tests / 8 files, 224.79s**: 1 failure was api.int asserting the
  pre-DEC-017 node-route contract (`sample: null`); test updated to the
  new contract and re-run green (api.int 6/6, webclient 5/5). Final state:
  all 8 live files pass.
- `pgrep -ax portaldot_dev` after suites → no orphans.
- CLI smoke not re-run: CLI untouched this phase; engine change is
  additive-only (`nodeLogTail`) and all engine tests are green.

### 3. Real-backend verification vs component tests (explicit boundary)

`test/integration/webclient.int.test.ts` (LIVE) runs the ACTUAL
`KaizenApiClient` + `KaizenEventStream`: the exact code the browser
executes: against a real API server + engine + real `portaldot_dev`
network: health & structured validation errors through the client; network
create + `network.created` observed on the UI's stream; health-gated start;
monitor shows `healthy` with peers 0/0, real head, `0x…` genesis; values
CROSS-CHECKED against an independent raw RPC read (head within drift,
peer count equal, real `12D3KooW…` peer id); real log bytes via the new
logs endpoint; stop → honest `unhealthy`/unreachable; typed
`network.status running/stopped` events seen; cleanup via client.
**Boundary**: jsdom component tests verify rendering/state logic with
fixtures only; there is NO real-browser E2E in this phase (no Playwright in
the repo): recorded as RSK-23, not claimed as verified.

### 4. Bugs the new tests caught (fixed)

1. **Node-detail route returned null sample/health** in the window between
   start and the first stored snapshot, even for a verifiably running node
   (caught LIVE by webclient; invisible to mocked tests). Fixed: route now
   uses `getLatest() ?? snapshotNow()` like the monitor route (DEC-017);
   api.int contract updated accordingly.
2. **Client error classification**: a failed request with a non-JSON body
   reported `BAD_RESPONSE` instead of `HTTP_<status>`; fixed so status-based
   classification wins for non-2xx (unit test).
3. **Event stream teardown**: `manuallyClosed` made the socket unreopenable
   after StrictMode's subscribe→cleanup→subscribe cycle; replaced by
   subscriber-count-based teardown (unit-tested: reconnect works, no leak).
4. **Status listener echo**: `onStatus` emitted the initial state twice when
   `connect()` produced a transition; fixed (unit-tested exact sequence).

### 5. Decisions made (new; DEC-001…DEC-015 unchanged)

DEC-016 (thin typed web client over existing API; single shared WS with
resync-refetch; engine types import-type-only; bounded polling, never
optimistic), DEC-017 (node detail samples on demand when no snapshot is
stored).

### 6. Remaining work / exact next step

- Not in this phase (per instruction, NOT started): Failure Lab/scenarios
  (Phase 3), incident timelines (Phase 4), validator transactions (Phase 5),
  Docker/K8s deployment (Phase 6), real-browser E2E (RSK-23).
- UI refinements deferred: WS log streaming with since-timestamp tailing
  (DEC-016 alternative), pagination for very large event feeds.
- Next: Phase 3: start with T-3.1 (failure-mechanism feasibility spike,
  DEC-008 gate intact).

## 2026-10-12: PHASE 3A: Fault Mechanism Study (T-3.1)

**Phase/Task IDs**: Phase 3A / T-3.1 only. FailureInjector, scenario
engine, and Failure Lab UI were explicitly NOT started (T-3.2 next). All
faults ran against freshly created disposable Kaizen-managed networks with
`designatedTest === true` verified before every fault (DEC-008 intact).
Privileged experiments (iptables/netns) ran only after explicit operator
authorization (DEC-018).
**Files created/modified**:
- `test/experiments/t31-spike.mjs`: NEW standalone experiment harness
  (imports built engine helpers only; argv-only spawns; SIGSTOP-PID
  registry; firewall/netns/cgroup rollback registered on every exit path;
  emergency cleanup on SIGINT/SIGTERM). Subcommands: `a-pause`, `b-peer`,
  `b-peer-reserved`, `c-partition[-reserved|-mdns]`, `c-iptables[-cgroup]`,
  `c-netns`, `d-terminate`, `rpc-probe`.
- `eslint.config.mjs`: Node globals declared for `test/**/*.mjs` (the new
  harness tripped `no-undef` on `process`/`console`/`fetch`/timers).
- `docs/TECHNICAL_RESEARCH.md`: NEW entry **R-22** (capability matrix +
  environment facts + reproduction), summary matrix rows R-21/R-22.
- `docs/DECISIONS.md`: NEW **DEC-018** (kernel-level fault operations:
  authorization, scope, rollback verification).
- `docs/{IMPLEMENTATION_PLAN,RISKS,ARCHITECTURE,TESTING}` updated (see §5),
  `docs/PHASE_REPORT.md` rewritten (2B report archived to
  `docs/reports/PHASE_02B_REPORT.md`).

### 1. Mechanisms proven (evidence in `/tmp/opencode/t31-*.log`, matrix in R-22)

- **A: pause/resume (VERIFIED)**: `t31-a-full.log`. SIGSTOP on alice →
  PID alive, RPC times out → health `unknown` → `unavailable`; bob
  half-rate production (head 1→3/36 s), finality stalled (2/2), libp2p
  connection held (peers 1/1). SIGCONT → RPC <3 s, sync 0→4 in 3 s,
  finality resumed to #5 in ~20 s, both healthy, no restart.
- **B1: reserved-peer RPC on a normal connection (PARTIAL, negative)**:
  `t31-b.log`, `t31-b2.log`. Bare peer-id add fails (`2002
  MultiaddrParse`), multiaddr add/remove changes `system_reservedPeers`,
  but the live connection never dropped (60 s, 20 samples, both sides,
  both runs). This RPC is set-membership only.
- **B2: disconnect on a reservation-bound connection (VERIFIED)**:
  `t31-b3.log`. On a `--reserved-only` node, `removeReservedPeer(alice)`
  → reserved set emptied, victim peers 1→0 at t=0 s, alice lost it by
  t=3 s, sustained 60 s.
- **C1: proxy cut alone (PARTIAL, negative)**: `t31-c2/c3/c5.log`.
  `ss` proved the proxied leg carried the connection and the group-kill
  severed it instantly (0.014 s): but the mesh reconverged in ~1 s with
  mDNS on and ~15 s with `--no-mdns` (identify-learned direct addresses).
  mDNS (default ON for non-dev chains) bypasses bootnode wiring entirely.
- **C2: reserved-only + proxied reserved-nodes, unprivileged (VERIFIED)**:
  `t31-c4.log`. Victim peers → 0 at t=0.006 s, sustained 90 s; alice/bob/
  keep mesh intact; reconnect on proxy restore.
- **C3: static port-scoped iptables (PARTIAL, negative)**: `t31-f2/f4.log`.
  Isolation until ~50 s, then escape via fresh ephemeral ports and IPv6
  (`[::1]`); `-i lo` additionally missed eth0 (`10.0.4.11`) legs.
- **C4: ip{,6}tables + cgroup process scoping (VERIFIED)**: `t31-f6.log`.
  Both families, no interface scoping: port rules + per-established-socket
  seals + `OUTPUT -m conntrack --ctstate NEW -m cgroup --path /t31-*`
  with the victim in that cgroup. Alice dropped bob at 50 s; sustained
  t=55→145 s (alice={keep}, keep={alice}, victim peers=0, victim RPC up);
  reconverge ≤10 s after removal; firewall (v4+v6) byte-identical to
  baseline; cgroup removed (`leftovers: []`); zero delete failures.
- **C5: netns + veth (VERIFIED)**: `t31-g.log`. Dedicated `10.77.53.0/24`
  link; host-side link-down → ns peers=0 with ns RPC up and **ns head
  frozen at 1 while alice advanced to 16**, zero host `ss` legs, alice↔bob
  intact; link-up → reconnected ≤5 s; netns+veth removed (verified).
- **D: terminate + restart (VERIFIED)**: `t31-d.log`. Engine stop →
  `unhealthy` "process is not running (status: stopped)": distinct from
  pause's `unavailable`; start → new PID, peers back <1 s, chain resumed
  0→3 → finality #1, final heads 10→12 healthy.

### 2. Commands actually run (with results)

- Experiments: `KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode
  node test/experiments/t31-spike.mjs <subcommand>`: 10 recorded runs
  (a×1, b×3, c×5, d×1, plus `rpc-probe` inventory).
- Micro-tests isolating kernel semantics: cgroup rule (BLOCKED + counter
  incremented), `--ctdir ORIGINAL` (counter 0, bytes flowed → inert).
- Gates: `npm run typecheck` ✅, `npm run lint` ✅ (after the eslint globals
  fix), `npm run build` ✅, `npm test` ✅ **113/113 (17 files)**,
  `KAIZEN_TEST_LIVE=1 npm run test:integration` ✅ **30/30 (8 files,
  226 s, real `portaldot_dev 2.0.0`)**.
- Leak checks after every privileged run: `pgrep portaldot_dev` none,
  `socat` none, `ip netns list` empty, `vt31a` gone, iptables/ip6tables
  INPUT/OUTPUT empty (Docker chains untouched), no `/sys/fs/cgroup/t31-*`,
  no leftover data dirs.

### 3. Problems encountered (honest record)

1. **Harness bugs fixed during the spike**: missing `engine.networks.start()`
   in setup; `system_peerId` → `system_localPeerId`; `key generate-node-key`
   prefix + peer-id regex; `engine.binaries.nodePath()`; single-node preset
   has no spec file (C switched to two-node + keyless manual peers).
2. **socat listener kill left forked children** holding established
   connections → fixed with `detached:true` + process-group SIGKILL.
3. **Firewall rule leak (incident, fixed)**: the first `-D` construction
   dropped the chain name (`iptables -D 1 …`) so deletion failed silently
   and rules remained. Detected by the harness's own final-state log, the
   rules were deleted manually (verified empty) and the harness now builds
   exact `-D <chain> <rule-spec>` commands and logs every delete failure.
4. **Two kernel surprises that invalidated rule sets** (documented in R-22):
   `--ctdir ORIGINAL` inert (0 packets matched) and IPv6/eth0 bypasses of
   IPv4/loopback-scoped rules. Only the empirically re-verified rule set
   (C4) is claimed.
5. **Live-process cgroup move-back fails EBUSY** in this container →
   cleanup kills nodes first, then removes the cgroup (verified empty).

### 4. Verification boundary (no overclaiming)

- "Partition succeeded" claims are only made where the connectivity change
  AND unaffected connectivity were both observed (peer sets on every node +
  `ss` + head/finality progression), never from the target's silence.
- No claim is made about monitor/UI behavior during faults: health values
  cited are direct RPC reads (`system_health`, `system_peers`).
- Long-horizon (>90 s) reconvergence and partial-authority finality under
  isolation were not measured (RSK-12 stays open).

### 5. Decisions & doc status flips

- **DEC-018** added (kernel-level fault operations: authorization, narrow
  scope, rollback verification).
- **RSK-09** → MITIGATED (mechanisms evaluated empirically; two unprivileged
  and two privileged routes proven, limitations recorded).
- **RSK-24** added (injector bypass via discovery/address leakage: mDNS,
  ephemeral ports, dual-stack/multi-homed: with the R-22-derived
  mitigations).
- ARCHITECTURE §6 gains the fault-injection lifecycle note; TESTING §10
  records reproduction commands; T-3.1 → VERIFIED in IMPLEMENTATION_PLAN.

### 6. Remaining work / exact next step

- Stop here per instruction: FailureInjector/scenario engine NOT started.
- Next: **T-3.2**: FailureInjector with the DEC-008 gate, dry-run preview,
  timeouts and guaranteed cleanup, using R-22's recommended unprivileged
  defaults (SIGSTOP, engine stop/start, reserved-only+proxy) and DEC-018's
  discipline for any kernel-level fault; re-verify each chosen mechanism
  inside the injector's own lifecycle.

---

## 2026-10-12: PHASE 3B: FailureInjector Foundation (T-3.2)

### 1. What was built

A typed, safely-gated FailureInjector inside the shared engine
(`packages/engine/src/fault/`), integrated via `engine.faults`: the same
service both frontends will consume (the Failure Lab UI is explicitly NOT
built here; T-3.3+ and T-3.6 own scenarios/CLI/UI).

- **Fault domain model** (`fault/types.ts`, `fault/lifecycle.ts`): 11-state
  machine (`requested → validating → (rejected | ready → executing →
  verifying → cleaning-up → completed | failed | cancelled |
  cleanup-failed)`); illegal transitions throw; results separate the claims
  applied / effectObserved / faultRemoved / recovered / recoveryVerified
  (never one "success" flag) with structured before/apply/effect/remove/
  recovery evidence (timestamps, pids, RPC observations).
- **Narrow adapters** (`fault/adapter.ts`, `fault/adapters/*`): each declares
  type, privileges, preflight checks, bounded execution, expected effect,
  verification, timeout behaviour, cleanup, and failure semantics. NO
  generic shell/signal/executable/firewall surface exists.
  - `pause`: SIGSTOP/SIGCONT on a re-verified managed PID (R-22 A).
  - `terminate`: engine `stopNode`/`startNode`; restore verified with a NEW
    pid (R-22 D).
  - `peer-disconnect`, `partition`: registered as explicit BLOCKED adapters:
    typed `FAULT_NOT_SUPPORTED` results with precise unblock paths (reserved-
    only topology wiring; DEC-018 operator authorization); the R-22 negative
    mechanisms are never substituted.
- **Injector** (`fault/injector.ts`): dry-run is the default surface;
  `execute()` is a separate explicit action that REVALIDATES the whole
  boundary with fresh reads: DEC-008 `designatedTest` + local chain, node ∈
  network, engine-managed running process, stable identity (pid +
  `kaizen-node.pid` agreement: reused/ambiguous processes are refused, never
  signalled), one active fault per node, quarantine check. Bounded durations
  + per-step timeouts (wrap backstop above each adapter's own bound);
  cancellation exits holds promptly and ALWAYS runs cleanup; cleanup-failed ⇒
  honest `inconclusive` outcome + high-severity `fault.cleanup-failed` event
  + target quarantine until `reconcile()` proves the effect gone;
  `engine.close()` cancels in-flight faults and SIGCONT-sweeps pause records.
- **Audit trail**: SQLite `faults` table (migration 6–8, schemaVersion 8) :
  accepted, rejected, executed, verified, cleaned-up requests all recorded
  with actor, state, plan, preflight report, evidence, error; every
  transition persisted AND emitted as `fault.state`; operations table rows
  (`fault.execute`) too. Evidence passes through key-aware redaction.
- **API surface** (`apps/api/src/server.ts`): `POST …/faults/preflight`,
  `…/dry-run`, `…/execute` (requires literal `mode:"execute"`), `GET
  …/faults`, `GET /api/faults/:id`, `…/cancel`, `…/reconcile`; Zod-validated;
  403 (gate), 404, 409 (conflict/unsupported) mappings; fault events flow
  through the existing typed WS fanout.

### 2. Mechanism statuses (final)

| Mechanism | Status | Basis |
|-----------|--------|-------|
| pause | VERIFIED (implemented + live re-verified through the injector) | R-22 A + `faults.int.test.ts`: test-side polling observed the outage ≥5 s and recovery; same pid; chain resumed |
| terminate | VERIFIED (implemented + live re-verified) | R-22 D + live: old pid dead, NEW pid serving RPC, peers reconverged, head advanced |
| peer-disconnect | BLOCKED (adapter registered, typed unsupported) | R-22 B1/B2: only `--reserved-only` targets disconnect; no topology produces them and spawn mode is not persisted on NodeConfig: unblock path recorded (live: REST execute → 409) |
| partition | BLOCKED (adapter registered, typed unsupported) | R-22 C2 (needs same wiring) / C4/C5 (need DEC-018 operator authorization + privileged path that T-3.2 deliberately does not implement) (live: REST execute → 409) |

### 3. Gates (commands + actual results)

| Command | Result |
|---------|--------|
| `npm run typecheck` | pass (engine, cli, api, web) |
| `npm run lint` | pass |
| `npm run build` | pass |
| `npm test` | **136/136 passed** (18 files, 68 s): 113 prior + 23 new fault unit tests |
| `KAIZEN_TEST_LIVE=1 npm run test:integration` | **35/35 passed** (9 files, 268 s): 30 prior + 5 new fault live tests, real `portaldot_dev 2.0.0` (sha256 `9df4d6332e84…`) |
| post-suite hygiene | no orphan `portaldot_dev`, no netns, no t31/flt firewall rules (checked) |

### 4. Bugs the new tests caught (fixed; regression-tested)

1. Adapter preflight check failures were recorded but did NOT add to
   `blockingReasons`: a pause could have executed with an unreachable
   baseline. Fixed: adapter checks block like gate checks.
2. Rejection codes collapsed to `FAULT_NOT_ALLOWED`: conflicts and blocked
   mechanisms now map to `FAULT_CONFLICT` / `FAULT_NOT_SUPPORTED`.
3. Error paths jumped straight to terminal states from `executing`/
   `verifying` (illegal transition, state machine caught it). Fixed: every
   terminal transition routes through `cleaning-up`.
4. `persist()` dropped the `reconciled` flag: quarantine could never be
   released. Fixed + tested.
5. The wrap timeout equaled the adapters' internal poll budget and raced it
   (spurious `OPERATION_TIMEOUT` on legitimate cleanup-failure paths). Fixed:
   wrap = adapter bound + 3 s backstop.
6. `redactDeep` scrubbed string values but not secret-NAMED keys
   (`{ mnemonic: "…" }` survived). Fixed: key-aware redaction.
7. `listFaults` ignored `nodeId` when `networkId` was also set (API filter
   mismatch). Fixed before it could ship.

### 5. Decisions made (new; DEC-001…DEC-018 unchanged)

- **DEC-019**: injector boundary: engine-internal ops on DEC-008 targets;
  dry-run default; REST execution consistent with the existing loopback-trust
  model (equal-or-lesser power to stop/purge; JSON-only + no CORS blocks
  browser-page invocation); privileged fault execution deliberately NOT
  implemented until an operator-authorization model exists; any future
  non-loopback binding requires authorization first (RSK-26).
- **RSK-25** (cleanup-failed pause needs operator reconciliation: mitigated
  by quarantine/reconcile/shutdown-sweep), **RSK-26** (loopback API auth
  posture), **RSK-27** (fault-record retention) added; **RSK-24** mitigation
  updated (injector refuses the bypass-prone mechanisms).

### 6. Remaining work / exact next step

- Stop here per instruction: Failure Lab UI, scenario engine (T-3.3/T-3.4),
  diagnostics, recovery orchestration (T-4.4), validator ops, and K8s are
  NOT started.
- Next: **T-3.3**: scenario model + authoring (ordered actions, delays,
  conditions; CRUD + validation) building on `engine.faults` +
  `engine.networks` operations; keep the same dry-run/gate discipline.

## 2026-10-14: PHASE 3C: Scenario Model & Authoring Foundation (T-3.3)

### 1. What was built

The Failure Lab's authoring foundation in the shared engine
(`packages/engine/src/scenario/`), surfaced as `engine.scenarios` with a
minimal REST surface. Everything here is DATA + VALIDATION: there is no
execution path anywhere: CRUD and validate never touch a process, never
emit a fault event, never create a fault record (asserted by tests), and a
saved scenario never auto-runs. Scenario execution is T-3.4 (ScenarioEngine)
and the Failure Lab UI is T-3.6; neither was started.

- **Scenario model** (`scenario/types.ts`): versioned
  (`SCENARIO_SCHEMA_VERSION = 1`) definitions with stable ids
  (`scn-…`), name/description/tags, explicit target requirements
  (designatedTest enforced true: DEC-008; optional preset/minNodes/
  capabilities), ordered steps (stable `step-…` ids, explicit `order` =
  array position), typed operations, bounded delays
  (0..300 000 ms), per-step timeouts (5 s..15 min; a pause step's timeout
  must cover its hold + 60 s cleanup/recovery headroom), typed
  pre/postconditions, and explicit failure/cancellation semantics as
  persisted enums (`onPreconditionFailed: skip-step|abort-run|cancel-run`,
  `onStepFailed: abort-run|continue|cancel-run`,
  `onVerificationInconclusive: fail-step|warn-and-continue`,
  `onStepTimeout: fail-step|cancel-run`, and the fixed safe pair
  `onCleanupFailed: cancel-run` / `cancellation: cleanup-then-stop`).
  Conditions are typed inspectable data: never executable strings: with
  per-kind evaluability: `rpc-reachable`, `process-state`, `health-state`,
  `peers`, `syncing`, `chain-progress`, `recovery-verified` are supported;
  `finality-progress` and `runtime-event` are declared but marked
  `planned` and REJECTED by validation (never pretended to be checkable).
- **Safe operation registry** (`scenario/operations.ts`): descriptive
  only, built at runtime from the injector's new
  `describeMechanisms()` (static `AdapterSupport` added to each adapter;
  blocked adapters' preflight now reads the same reason/unblock consts :
  single source of truth). `pause`/`terminate` = supported;
  `peer-disconnect`/`partition` = BLOCKED with the adapters' unblock paths
  verbatim (never shown executable); `node-restart` = planned. Each
  definition exposes display metadata, strict Zod config schema, required
  target capabilities, safety flags (designatedTest required, DEC-018
  authorization for privileged), timeout envelope, and supported
  conditions. No arbitrary shell/signal/firewall/executable surface exists.
- **Deterministic validation** (`scenario/validate.ts`): pure (no clock,
  no store, no UI); identical input + registry ⇒ byte-identical structured
  `ScenarioValidationResult` (stable code, severity, path, message,
  remediation; no timestamps inside). Catches: unknown/blocked/planned
  operations, invalid/strict-config violations, missing fault preconditions,
  missing-postcondition warnings, contradictory/impossible conditions
  (opposite booleans, disjoint state sets, unsatisfiable peer bounds,
  stopped-but-RPC-reachable, recovered-but-RPC-down), non-evaluable
  condition kinds, condition/label/timeout/delay bounds,
  `TIMEOUT_TOO_SHORT_FOR_HOLD`, worst-case duration > 30 min, step id and
  ordering mistakes, designatedTest=false, capability gaps (severity tracks
  operation status: error for supported, warning for blocked/planned),
  preset ↔ node-label mismatches (custom topologies warn), schemaVersion
  mismatch, and secret-shaped content anywhere it would persist (reusing
  the injector's redaction patterns). Zod `strict()` schemas reject
  unknown fields, including secret-named keys.
- **Persistence** (`state/store.ts`, migrations 9–10, schemaVersion 8→10):
  `scenarios` table (UNIQUE name, JSON columns for tags/requires/steps/
  execution/validation, recency index); atomic insert/replace (single
  statements; UNIQUE → `SCENARIO_ALREADY_EXISTS`; update with 0 rows →
  `SCENARIO_NOT_FOUND`); restart-reload byte-identical; rows this build
  cannot parse or with a newer schemaVersion are surfaced as structured
  per-row `malformed` entries (`SCENARIO_MALFORMED` /
  `SCENARIO_VERSION_UNSUPPORTED`), never silently dropped or half-parsed.
- **Service** (`scenario/service.ts`): `list` (q/tag/status filters +
  limit/offset paging + total), `get`, `create`, `update` (patch merged
  over the stored record and re-validated WHOLE: a patch cannot smuggle
  an invalid end state; provenance preserved), `remove`, `validate`
  (validate-without-save), `describeOperations` (JSON-safe registry for
  authoring clients). Emits `scenario.created|updated|deleted` audit
  events (actor included). The registry is injected from the live
  injector in `engine.ts`: the service cannot disagree with the injector.
- **API** (`apps/api/src/server.ts`): `GET /api/scenarios` (filters +
  paging), `GET /api/scenarios/operations` (registry),
  `POST /api/scenarios/validate` (200 + validity: a query, not an
  operation), `POST /api/scenarios` (201), `GET/PUT/DELETE
  /api/scenarios/:id`; `SCENARIO_INVALID`→400 (structured issues in
  details), `SCENARIO_NOT_FOUND`→404, `SCENARIO_ALREADY_EXISTS`/
  `SCENARIO_VERSION_UNSUPPORTED`→409; malformed JSON now honors Fastify's
  4xx classification (400 + structured envelope, was 500). There are NO
  execute/run/replay routes (404 by absence, test-asserted). DEC-019
  posture unchanged (loopback-only, JSON-only; scenario endpoints add no
  host-execution power). Typed scenario methods added to the shared web
  client contract (`apps/web/src/api/client.ts` + types) for future CLI/UI
  consumption: no UI was built (T-3.6).

### 2. Gates (commands + actual results, 2026-10-14)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 202/202 passed (21 files): 136 prior + 66 new:
                         #   scenario.test.ts 32, scenario-store.test.ts 11,
                         #   apps/api/test/scenarios.test.ts 18 (new suite),
                         #   client.test.ts +4, fault.test.ts +1
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 35/35 passed (9 files, 346 s): full regression;
                         # T-3.2 live fault suites intact
```

No live-node work was needed for T-3.3 (authoring is pure data + SQLite);
the live run is regression evidence only. Hygiene after the run: no
orphaned `portaldot_dev` processes, no leftover netns/iptables rules
(the live suites assert this themselves and passed).

### 3. Files

- New: `packages/engine/src/scenario/{types,operations,validate,service}.ts`;
  `packages/engine/test/{scenario,scenario-store}.test.ts`;
  `apps/api/test/scenarios.test.ts` (+ vitest include);
  `docs/reports/PHASE_03B_REPORT.md` (3B archived verbatim).
- Modified: `fault/{adapter,injector}.ts` + `adapters/{pause,terminate,
  blocked}.ts` (additive: static support + describeMechanisms, single-
  source reason/unblock consts); `state/store.ts` (migrations 9–10 + CRUD);
  `errors.ts` (5 SCENARIO_* codes); `events/bus.ts` (3 scenario events);
  `engine.ts` (scenarios wiring); `index.ts` (exports); `apps/api/src/
  server.ts`; `apps/web/src/api/{client,types}.ts` + client tests;
  `packages/engine/package.json` + lockfile (zod ^4.6.5: project-standard
  boundary validation, same version as the API, workspace-hoisted);
  `store.test.ts` (schemaVersion 10), `fault.test.ts` (+1 mirror test).

### 4. Problems, decisions, and remaining work

- **Decisions made** (all recorded in DEC-020): registry derives from the
  injector's actual adapters (never a parallel list); blocked/planned ops
  authorable only as warnings; un-evaluable conditions are errors;
  designatedTest enforced at authoring with safe default true; explicit
  step `order` that contradicts position is an error (position is
  authoritative), not silently normalized; validate results carry no
  timestamps (determinism beats convenience). `TARGET_NODE_UNVERIFIABLE`
  (custom presets) is deliberately a warning: labels resolve at run time.
- **zod added to the engine**: justified by the repo-wide Zod-at-boundaries
  rule (AGENTS.md); identical version to apps/api; lockfile updated.
- **Not started (per the phase boundary)**: T-3.4 ScenarioEngine
  execution/recording, T-3.5 replay, T-3.6 CLI/UI surfaces, diagnostics,
  recovery orchestration. RSK-28 records that authoring-time validation is
  inert until T-3.4's executor revalidates through the injector gates.
- Next: **T-3.4**: ScenarioEngine execution with per-action recording and
  cancellation, reusing this model unchanged and executing ONLY through
  the FailureInjector's existing gates (dry-run→execute discipline).

---

## 2026-10-16: PHASE 3D: Scenario Execution Engine (T-3.4)

**Phase/Task IDs**: Phase 3D: T-3.4 only. Replay (T-3.5), CLI/UI
surfaces (T-3.6), Failure Lab UI, diagnostics (Phase 4), K8s: explicitly
NOT started, roadmap untouched.

### 1. What was built

- **`ScenarioEngine` (`packages/engine/src/scenario/runner.ts`, new)** :
  `engine.scenarioRuns`: `execute()` / `get()` / `list()` / `cancel()` /
  `wait()` / `active()` / `reconcileOnStartup()` / `close()`. Sequential
  execution of a validated scenario snapshot **only** through the
  FailureInjector (preflight → execute; no parallel execution path, no
  weakening of T-3.2 controls). Per-step pipeline: persist `running` →
  bounded cancel-aware delays → preconditions (independent observations,
  honest satisfied/not-satisfied/inconclusive with per-condition budgets)
  → failure policy → injector preflight → `injector.execute` → record
  evidence → postconditions → verification → cleanup → persist. Cancellation
  interrupts only via `injector.cancel` inside a bounded wait; cleanup runs
  on every finish path; unconfirmed cleanup → `cleanup-failed` + high-sev
  event + quarantine (never claimed recovered); step/run deadlines report
  `STEP_TIMEOUT` honestly.
- **`scenario/run-types.ts` (new)**: 13 run states / 11 step states with
  full legal-transition maps + predicates, `ScenarioRunRecord` /
  `ScenarioStepRun` (per-condition verdicts, claims, policy applied,
  warnings, error taxonomy incl. `INTERNAL`), `ScenarioRunReconcileReport`,
  `toRunSummary`. No secrets in records (redaction at persistence).
- **`scenario/conditions.ts` (new)**: run-time condition evaluators:
  rpc-reachable, process-state (alive pid), health-state (monitoring
  snapshot; inconclusive when monitoring is inert: never guessed),
  peers/syncing (inconclusive when RPC down), chain-progress (head increase
  / documented 15 s stall window), recovery-verified (reads the executed
  fault record's own claims); 1 s poll cadence (`SCENARIO_CONDITION_POLL_MS`).
- **Pre-execution gates (fail closed, evaluated before leaving
  `validating`)**: fresh revalidation of the stored definition (RSK-28),
  operation support (blocked/planned refused), exact target resolution,
  designatedTest/chain/preset/minNodes/capability checks, label→managed-
  node resolution for every operation+condition target, quarantine,
  conflict checks (no concurrent run per target/scenario; no active fault
  on a target). A refusal **persists a `rejected` run with its precise
  structured error first**, then throws.
- **Persistence (`state/store.ts`)**: migration 11 (schemaVersion
  **15**): `scenario_runs` + `scenario_run_steps` tables with JSON rows,
  atomic state transitions through the single writer, paginated
  list/filter with per-row `SCENARIO_RUN_MALFORMED` entries; raw
  `updateScenario`/`insertFault` helpers for crafted test/reconcile rows.
- **Crash reconciliation**: `injector.recoverInterrupted()` (new):
  execute-mode stuck faults → SIGCONT sweep where needed → terminalized →
  `reconcile()` only releases on fresh proof; dry-run records untouched.
  `ScenarioEngine.reconcileOnStartup()` (idempotent, non-rejecting)
  terminalizes unfinished runs as `INTERRUPTED` (never resumes them) and
  quarantines unproven cleanup failures. `engine.close()` order: runs
  closed (bounded cancel of in-flight faults) → faults.shutdown() →
  monitoring → store.
- **API (`apps/api/src/server.ts`)**: `POST /api/scenarios/:id/execute`
  (202 + run; body requires literal `mode:"execute"` + explicit target),
  `GET /api/scenarios/runs/:runId`, `GET /api/scenarios/runs`
  (filters + limit/offset/total + malformed), `POST /api/scenarios/runs/
  :runId/cancel`; `statusFor` gained 403/404/409 codes. Web client gained
  typed `executeScenario` / `getScenarioRun` / `listScenarioRuns` /
  `cancelScenarioRun` methods + response types: **no UI built** (T-3.6).
- **Errors/events**: new `SCENARIO_RUN_NOT_FOUND` (404),
  `SCENARIO_RUN_CONFLICT` (409), `SCENARIO_EXEC_NOT_ALLOWED` (403),
  `FAULT_INTERRUPTED`; typed `scenario-run.created|state|step|verification|
  cancelled|cleanup-failed|finished` events mirroring every transition.
- **Run authorization** recorded as **DEC-021**: DEC-019 loopback trust +
  literal mode marker + explicit target + engine-side fail-closed gates;
  authenticated non-loopback identity remains T-7.3 (RSK-26 untouched).

### 2. Gates (commands + actual results, 2026-10-16)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 248/248 passed (23 files): 202 prior + 46 new:
                         #   packages/engine/test/scenario-run.test.ts 37,
                         #   apps/api/test/scenario-runs.test.ts 9;
                         #   per-layer: engine 185, api 27, web 36
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 43/43 passed (10 files, 317 s): 35 prior + 8 new
                         # live scenario-run checks; T-3.2 fault suites intact
```

Live evidence (8/8 in `test/integration/scenario-runs.int.test.ts`,
real `portaldot_dev` two-node network, independent test-side observation
for every claim): pause run w/ effect observed while held + independent
recovery (same pid, RPC back, head advanced); two sequential steps with
distinct fault records; precondition abort (zero faults, node untouched);
live skip-step continuing to a real execution; cancellation during the
hold via `injector.cancel` w/ verified rollback; STEP_TIMEOUT with no
fault created; phantom non-designated/mainnet targets refused fail-closed
with persisted rejections; unresolvable label refused. CLI: no new CLI
surface (T-3.6 owns it); no orphaned `portaldot_dev` processes after the
run.

### 3. Files

- New: `packages/engine/src/scenario/{runner,run-types,conditions}.ts`;
  `packages/engine/test/scenario-run.test.ts`;
  `apps/api/test/scenario-runs.test.ts`;
  `test/integration/scenario-runs.int.test.ts`;
  `docs/reports/PHASE_03C_REPORT.md` (3C archived verbatim);
  `docs/PHASE_REPORT.md` overwritten with the 3D report.
- Modified: `fault/injector.ts` (`recoverInterrupted`);
  `state/store.ts` (migration 11 + run CRUD + raw update/insert);
  `scenario/validate.ts` (`scenarioRecordToInput` exported);
  `errors.ts` (4 codes); `events/bus.ts` (7 scenario-run events);
  `engine.ts` (wiring + eager reconcile + close order); `index.ts`
  (exports); `apps/api/src/server.ts` (4 routes + statusFor);
  `apps/web/src/api/{client,types}.ts`; `apps/api/test/scenarios.test.ts`
  (posture updated for T-3.4: no implicit execution, execute demands
  marker+target, refusal persists a rejected run);
  `packages/engine/test/store.test.ts` (schemaVersion 15);
  docs (PLAN/RISKS/ARCHITECTURE/TESTING/DECISIONS/PROGRESS).

### 4. Problems, decisions, remaining work

- **Defect found & fixed in the new executor**: `execute()`'s catch block
  overwrote the gate's structured error (e.g. `UNSUPPORTED_OPERATION`
  with step details) with a generic mapping of the thrown code
  (`GATE_REFUSED`): fixed to preserve `record.error` set by the gates;
  regression-covered by the gate tests asserting exact codes.
- **Validation facts pinned down by tests** (no spec change): every fault
  step requires BOTH `rpc-reachable{expect:true}` and
  `process-state{expect:['running']}` baselines for its target (error if
  absent), preset membership uses `nameSuffix` labels (two-node =
  alice/bob), scenario names reject parentheses: the T-3.4 tests were
  authored to the real rules rather than relaxing them.
- **Poll semantics**: a conclusively-false precondition keeps polling
  until its authored budget (that is correct: states recover); tests
  therefore author tight condition budgets (e.g. 300–500 ms) instead of
  waiting out the 30 s default.
- **Run record's `faultId` is persisted after the fault finishes**, so
  live tests observe in-flight faults through `injector.activeFaults()`
  (the live truth channel) rather than the record: documented in the
  test comments; no schema change was needed.
- **DEC-021** recorded (see above); no existing decision changed.
- **Not started (per instruction)**: T-3.5 replay, T-3.6 CLI/UI surfaces
  (Failure Lab UI), diagnostics, K8s: the roadmap is unchanged and no
  phase report claims them.
- Next: **STOP after T-3.4** per instruction. When resumed, the next
  roadmap task is T-3.5 (replay), which must reuse
  `engine.scenarioRuns.execute()` and never add a second executor.

## 2026-10-18: PHASE 3E: Scenario Replay (T-3.5)

**Phase/Task IDs**: Phase 3E: T-3.5 only. CLI/UI surfaces (T-3.6),
Failure Lab UI, diagnostics (Phase 4), recovery orchestration, K8s :
explicitly NOT started, roadmap untouched.

### 1. What was built

- **`ScenarioEngine.replay()`** (`packages/engine/src/scenario/runner.ts`)
 : re-executes a finished run's RECORDED actions as a NEW run by
  re-entering the same internal run-start path as `execute()`
  (`startRun()`: one executor, one gate chain, one injector pipeline;
  no second execution subsystem). The new run's snapshot is the SOURCE
  run's immutable snapshot (never the scenario's possibly edited or
  deleted current definition); unusable snapshots (missing/empty steps)
  are refused with `SCENARIO_RUN_NOT_REPLAYABLE` before any run record
  exists. `scenarioReplayRequestSchema`: `{ runId, networkIdOrName,
  mode: 'execute', requestedBy? }`: the target is explicit, never
  inherited; DEC-021 posture unchanged.
- **Eligibility + provenance** (`scenario/run-types.ts`) :
  `REPLAYABLE_SCENARIO_RUN_STATES` (completed / completed-with-warnings
  / failed / cancelled / cleanup-failed; `rejected` and unfinished
  states refused with actionable messages) and `replayOfRunId: string |
  null` on the run record + summary, persisted in a new indexed column
  `scenario_runs.replay_of_run_id` (migration 12, schemaVersion 16→17)
 : append-only: replay never rewrites the source row;
  `list({ replayOf })` / `?replayOf=` queries every attempt from a
  source. `scenarioRunReplayNote()` + the 202 response's `replayNote`
  state the honest contract in the API itself (replay repeats ACTIONS,
  identical outcomes are NOT guaranteed, evidence is freshly observed);
  a clean replay still reaches plain `completed` (the note does not
  ride the `warnings` channel).
- **API + typed client**: `POST /api/scenarios/runs/:runId/replay`
  (202 `{ ok, run, replayNote }`; errors: 400 INVALID_INPUT, 404
  SCENARIO_RUN_NOT_FOUND/NETWORK_NOT_FOUND, 403 SCENARIO_EXEC_NOT_ALLOWED,
  409 SCENARIO_RUN_NOT_REPLAYABLE/SCENARIO_RUN_CONFLICT: new error
  code mapped in `errors.ts` + `statusFor`); run-history query param
  `replayOf`; web client `replayScenarioRun()` +
  `ScenarioReplayResponse` type. Read-only requests never execute.
- **Tests**: engine `scenario-replay.test.ts` 10 (harness extracted to
  `test/scenario-harness.ts`, shared with the 37 T-3.4 tests, unchanged
  in behavior); API +4 (=13); LIVE +1 (=9/9 in the file, 44/44 suite).

### 2. Evidence (commands actually run, 2026-10-18)

- `npm run typecheck` / `npm run lint` / `npm run build`: PASS (exit 0).
- `npm test`: **262/262 (24 files)**: engine 195 (scenario-run 37,
  scenario-replay 10, scenario 32, fault 24, monitor 21, topologies 17,
  remaining 54), api 31 (scenarios 18, scenario-runs 13), web 36.
  (T-3.4 baseline was 248; +10 engine replay, +4 API replay.)
- `KAIZEN_TEST_LIVE=1 KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode
  npm run test:integration`: **44/44 (10 files, 337 s)** against real
  `portaldot_dev`; the new replay check (14.6 s) independently sampled the
  replay's effect (victim unreachable while held), asserted a fresh fault
  id + fresh claims, re-verified recovery itself (same pid, RPC back),
  confirmed the source run byte-identical, queried provenance, and
  confirmed ineligible/unknown-target refusals. T-3.2/T-3.3/T-3.4 suites
  intact; `pgrep -af portaldot` after → no orphans.
- Docs updated: this log, IMPLEMENTATION_PLAN (T-3.5 → VERIFIED),
  ARCHITECTURE §6 (replay contract), DECISIONS (**DEC-022**), TESTING §14;
  the Phase 3D report archived verbatim at
  `docs/reports/PHASE_03D_REPORT.md`; the new report is
  `docs/PHASE_REPORT.md`. RISKS: no new risk; RSK-26 still covers the
  replay endpoint's loopback-only posture (T-7.3 owns auth).

### 3. Problems, decisions, remaining work

- **Design iterations pinned by failing tests (fixed, not weakened)**:
  (a) seeding the honesty note into `warnings` downgraded every clean
  replay to `completed-with-warnings`: moved to `replayOfRunId` +
  `replayNote` (DEC-022); (b) a crafted test snapshot dropped the
  mandatory rpc-reachable baseline and was correctly refused by the
  existing validation: the test was authored to the real rule;
  (c) `insertScenarioRun` now requires `replayOfRunId`: the T-3.4
  reconcile-test helper was updated (schema change is intentional,
  migration 12).
- **DEC-022** recorded; no existing decision changed; T-3.2/T-3.3/T-3.4
  safety behavior verified intact by their unchanged suites.
- **Not started (per instruction)**: T-3.6 CLI/UI surfaces (Failure Lab
  UI), diagnostics, recovery orchestration, K8s: roadmap unchanged.
- Next: **STOP after T-3.5** per instruction. When resumed, the next
  roadmap task is **T-3.6** (Failure Lab CLI/API and UI integration
  surfaces), which must call `engine.scenarioRuns.execute()` /
  `.replay()` exactly like the API does.

## 2026-10-19: PHASE 8 (partial): Portaldot V3 Connectivity Probe (T-8.1)

**Phase/Task IDs**: Phase 8: T-8.1 ONLY. Contract deployment, registry
contracts, wallet authorization, later T-8.x tasks, T-3.6 CLI/UI
surfaces, Phases 4–7: explicitly NOT started, roadmap untouched.

### 1. What was built

- **V3 endpoint configuration** (`packages/engine/src/v3/config.ts`):
  official V3 endpoints as overridable DEFAULTS :
  `V3_ENDPOINT_DEFAULTS` (substrate `wss://test-node-v3.portaldot.dev`,
  EVM `https://test-evm-rpc-v3.portaldot.dev`, explorer
  `https://node-console.portaldot.dev`, expected EVM chain id
  **420420777**, 15 s probe deadline); `resolveV3Config()` resolves
  explicit > `KAIZEN_V3_*` env > default with Zod validation that names
  failing KEYS, never values; `redactEndpointUrl()` reduces any URL to
  its origin (userinfo/path/query/fragment stripped) for every result,
  log, and message.
- **Typed probe service** (`v3/probe.ts`, `v3/types.ts`):
  `V3ConnectivityProbe` (+ `probeV3Connectivity()`) probes three
  endpoints INDEPENDENTLY in parallel with per-endpoint hard deadlines
  (AbortController race bounds even non-cooperating transports) and
  never rejects. Per-endpoint typed statuses:
  `ok | unavailable | timeout | protocol-error | malformed-response |
  mismatch`; `healthy` only when all three are `ok`; unobserved values
  are `null`, never guessed. Substrate: connect → chain name + system
  health + best header (height/hash validated, partial observations
  preserved). EVM: JSON-RPC envelope + response-id validation, hex
  quantity parsing, chain id compared to configuration (HTTP 200 alone
  is never success; wrong id → `mismatch`); `web3_clientVersion` is
  optional: its absence is a warning, never a failure. Explorer:
  availability-only (status/content-type/bounded 2 KiB title prefix) with
  the scope limitation recorded in the result's own `warnings`.
- **Transports** (`v3/transports.ts`): DI interfaces + real
  implementations reusing existing stacks: `readProbeState()` on the
  existing `PortaldotRpcClient` (`@polkadot/api`, DEC-001; new
  `probeReads()` three-parallel-read method + one-shot helper with
  guaranteed close) for WS, and the engine's `fetch` HTTP stack for
  JSON-RPC/HTTP (AbortSignal.any deadline+abort; Content-Type only: no
  auth headers ever). No new dependency; no EVM library.
- **Redaction**: result sanitization replaces configured URLs with
  origins, strips URL userinfo generically, and applies the shared
  `redactSecrets` scrubber: credential-bearing URLs cannot leave the
  config object (unit-tested with `user:pass@host/path?apikey=` cases).
- **Safety posture (DEC-023)**: read-only by construction (EVM allowlist
  `eth_chainId`/`eth_blockNumber`/`web3_clientVersion` with empty params;
  substrate reads only; explorer GET only); NO API route, NO UI, NO
  caller-supplied URL anywhere: configuration is the only target source.
- **Tests**: `packages/engine/test/v3-probe.test.ts` (21 tests, all
  fakes, offline) covering the required matrix; live env-gated
  `test/integration/v3-probe.int.test.ts` (own gate `KAIZEN_TEST_V3=1`).
- **Docs**: IMPLEMENTATION_PLAN new Phase 8 section + T-8.1 row
  (VERIFIED); TECHNICAL_RESEARCH **R-23** (V3 endpoints VERIFIED) +
  **R-24** (explorer PARTIALLY VERIFIED) + summary-matrix rows;
  ARCHITECTURE (component table row + §5 V3 boundary bullet);
  DECISIONS **DEC-023**; RISKS **RSK-29**; TESTING §15; the Phase 3E
  report archived verbatim at `docs/reports/PHASE_03E_REPORT.md`
  (byte-identical, `cmp` clean); `docs/PHASE_REPORT.md` is now the
  T-8.1 report. `docs/EVIDENCE.md` was NOT created: it does not exist
  and AGENTS.md fixes research facts in TECHNICAL_RESEARCH.md; live vs
  mocked evidence is separated in the phase report + TESTING §15.

### 2. Verification (commands + actual results, 2026-10-19)

- `npm run build` → PASS (exit 0).
- `npm run typecheck` → PASS (exit 0).
- `npm run lint` → PASS (exit 0).
- `npm test` → first run 282/283 with ONE failure in
  `scenario-run.test.ts` ("stand-in node could not listen on 34741" :
  transient local port-bind contention in the T-3.4 harness, no V3 code
  involved); isolated re-run of that file → 37/37 PASS; second full run
  → **283/283 (25 files) PASS**.
- Live check, ungated: `1 skipped` (a skipped check is never reported as
  passed).
- Live check: `KAIZEN_TEST_V3=1 npx vitest run --config
  vitest.integration.config.mts test/integration/v3-probe.int.test.ts`
  → **1/1 PASS** (exit 0, 3.1 s). Observations (2026-10-19T17:51Z,
  `[v3-live]` log line): substrate `ok`: chain **"PortaldotV3 Test"**,
  health {peers: 2, isSyncing: false, shouldHavePeers: false}, best
  **#106135** (hash `0x30c7b266…08cab66`), 3130 ms; EVM `ok` :
  `eth_chainId` **420420777** (= configured expectation; `0x190f1ca9`),
  block **#106135** (same height as Substrate head: one chain, two
  surfaces), client `eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/
  rustc1.98.0`, 1553 ms; explorer `ok`: HTTP 200, text/html, title
  "Portaldot Node Console" (bounded 2 KiB read), 888 ms;
  **healthy: true**; endpoints origin-redacted, zero credentials.
- Hygiene: `pgrep -af portaldot` after the live run → none (the probe
  closes its own WS/HTTP connections deterministically).

### 3. Problems, decisions, remaining work

- **Supplied-vs-observed match**: the brief's expected chain id
  420420777 was CONFIRMED by the live read (not assumed); block heights
  advance between runs (#105907 manual pre-check → #106135 at probe
  time): recorded as live-chain evidence, not a discrepancy.
- **Test-authoring fix (not a code fix)**: two suite failures were my own
  hex arithmetic (`0x19db3` = 105907, not 172723) and a fake-factory
  signature bug; both corrected in the test file: no production code was
  weakened to pass.
- **DEC-023** recorded; no existing decision changed. `docs/EVIDENCE.md`
  intentionally not created (see §1). No `PHASE_8_PLAN.md` existed to
  integrate: the Phase 8 section records the task exactly as briefed.
- **Not started (per instruction)**: contract deployment / registry /
  wallet authorization / later T-8.x (undefined without a brief), T-3.6
  CLI/UI surfaces, Phases 4–7.
- Next: **STOP after T-8.1** per instruction. When resumed, the next
  roadmap task is **T-3.6** (Failure Lab CLI/API and UI integration
  surfaces), which must call `engine.scenarioRuns.execute()` /
  `.replay()` exactly like the API does.

## 2026-10-21: PHASE 3F (partial): Failure Lab CLI/API Integration (T-3.6A)

**Phase/Task IDs**: Phase 3F: T-3.6A ONLY (CLI surface + API audit).
The web-UI integration surface (T-3.6B) is explicitly NOT started
(imported UI wiring pending); Phases 4–7, contracts/registry/wallet,
K8s/Helm: untouched.

### 1. What was built

- **CLI scenario/run command groups** (`packages/cli/src/program.ts`,
  new; `packages/cli/src/index.ts` rewritten as a thin wrapper):
  - `kaizen scenario (list | get <id> | create <file> | validate <file>
    | operations)`: authoring over the shared engine.
  - `kaizen run (execute <scenarioId> | replay <runId> | list |
    get <runId> | cancel <runId>)`.
  - `execute`/`replay` REQUIRE explicit `-n, --network <idOrName>`
    (never inferred) and accept bounded `--timeout <ms>` (default
    300000; cancel 60000). Exit codes: completed* → 0; rejected/failed/
    cancelled/cleanup-failed/timeout → 1; validate 0/1; `run cancel`
    exits 0 only when the run was OBSERVED reaching `cancelled` (or
    completed*), else 1. Engine refusals surface typed errors + the
    persisted `rejectedRunId` with a `kaizen run get <id>` hint.
  - `buildProgram(deps?: { engineFactory })` DI: the CLI constructs the
    engine exactly like the bin does (DEC-002: one engine, two
    frontends); it NEVER re-implements gates/execution (DEC-024).
- **API audit: zero changes.** Existing typed routes already cover
  scenario CRUD/validate/operations and runs execute(202)/list/get/
  cancel/replay(202 + replayNote); no route duplicated, no contract
  touched.
- **Cross-process run-control fixes** (engine; each driven by a REAL
  observed failure, DEC-025):
  - `pause.ts` `nodeAlive()`: liveness accepts a fresh running record
    with a live OS pid: the pause preflight no longer refuses nodes
    running in another process (was: in-memory-only view → "paused node
    looks dead").
  - Durable cross-process cancel: `cancel()` persists for any
    non-terminal run (no local entry; still no second executor); a 400ms
    watcher around the in-flight fault honors the persisted request via
    the SAME `faults.cancel` mechanism, once; the store's
    `cancellation` UPDATE is write-once (`COALESCE`) so a stale
    full-row rewrite can never clobber a foreign request (live-observed
    lost update); a pending cancellation that lands while the
    interrupted fault ends failed/rejected records the run `cancelled`
    (never misattributed; `cleanup-failed` still quarantines).
  - `executor_pid` stamped once at insert (migration #13, v18;
    never updated, like `replay_of_run_id`); startup reconcile DEFERS
    (honest `deferred` report entry) while the owner pid is alive :
    it no longer terminalizes other processes' live runs as
    `INTERRUPTED` (live-observed).

### 2. Verification (commands + ACTUAL results, 2026-10-21)

- `npm run typecheck` ✓ clean; `npm run lint` ✓ clean; `npm run build`
  ✓ (rolldown notice only).
- `npm test` → **323/323 pass (26 files)**: includes CLI
  `scenario-commands.test.ts` **36/36** (help surface, parsing,
  validation, JSON envelopes, exit codes, timeout/cancel honesty,
  rejected-run surfacing) and `scenario-run.test.ts` **41/41** (new:
  cross-process cancel, write-once cancellation guard, live/dead-owner
  reconcile behavior).
- Ungated `npm run test:integration` → all 50 skipped (cli-scenario
  **5 skipped**: never reported as passed).
- `KAIZEN_TEST_LIVE=1` `cli-scenario.int.test.ts` → **5/5 pass**
  (authoring; real run with SAME-pid + RPC/head independent
  observations; replay with provenance + honesty note + distinct fault;
  **REAL cross-process cancel**: execute in a child process, cancelled
  by a separate `run cancel`, honest `cancelled` outcome + node
  recovery; gate refusals persisted & surfaced).
- Regression re-runs (engine touched): `scenario-runs.int.test.ts`
  **9/9**, `faults.int.test.ts` **5/5** (live).
- Hygiene: `pgrep -af portaldot` clean after live runs; no secrets in
  the diff; `.kaizen/` untouched.

### 3. Problems, decisions, remaining work

- Three engine defects were found ONLY because the live cross-process
  test exercised a topology the in-process tests could not (fix → live
  proof → regression test, each time); one test-harness race (in-process
  concurrent CLI runs sharing global spies) was fixed by running the bg
  execute as a REAL child process: which also made the test honest
  cross-process evidence.
- One stale assertion (`store.test.ts` schemaVersion 17 → 18) updated
  for migration #13: the only pre-existing test change; no test
  weakened anywhere.
- **DEC-024** (CLI design) and **DEC-025** (cross-process run control)
  recorded; `docs/PHASE_REPORT.md` replaced (Phase 3F) with the T-8.1
  report archived byte-identical to
  `docs/reports/PHASE_08A_REPORT.md`.
- **Remaining for full T-3.6**: T-3.6B web-UI integration surface
  (imported UI wiring to the existing API/typed client: not designed,
  generated, or restyled here); T-3.6 stays PARTIAL until the UI flow
  exists.
- Next: **T-3.6B: wire the imported web UI to the Failure Lab API**
  (typed-client compatibility only; no fabricated data), or the next
  roadmap task as directed.

## 2026-10-21: PHASE 8B: V3 On-Chain Run Anchoring (T-8.2) + PHASE 3G: Console Integration (T-3.6B)

### 1. What was done

- **T-8.2 (commits 633d144, 3516bc5, 667d051)**: KaizenRunRegistry
  contract + reproducible build; engine `V3AnchorService` (canonical run
  hash, ABI codec, env-only signer, runtime dry runs, persist-first anchor
  records, verify); SQLite migrations 19–22; CLI `kaizen v3 probe|status|
  deploy-registry|import-deployment|hash|anchor|anchors|verify`; API
  `/api/v3/*`; console **Portaldot V3** screen (probe cards, signer/registry
  status, anchored runs with node-console block links, per-anchor Verify,
  Anchor run with confirm: remark default, contract shows the deposit
  warning). Decisions DEC-026 / DEC-027.
- **Live on PortaldotV3 Test (chain id 420420777)**: registry
  `0x08fdadd1ebe16234c03b723255cc12fd98a5ef07` deployed at block 136822
  (tx `0x2fa1c5ae2de79d71ca663d7e7050cc9995e4803b234ade6dd916bc3a8d5eff30`);
  contract anchors block 136899 (tx
  `0xa06abaa085c59486bd2a8d8e4d593b30a9a6e521c7908c6de4b3bdbb70f8c5b7`) and
  136919 (tx `0x8ae9cfc07d559c9dc058472869ae6daa1c364d8965f597704bcc44893abd4df9`);
  remark anchors block 136940 (tx
  `0xa9b15505f07d72738159fb24af61f9959319f7e241125c4b1e82d1c8ab1173ff`) and
  136947 (tx `0x84027d2397efce0930e1a5abd49b77a741a8820f4373ebb8dc9c97f7fd774f49`).
  The anchored runs were real Failure Lab runs on a local two-node
  `portaldot_dev` network, executed on the arm64 sandbox under qemu-user
  x86_64 emulation (RSK-31). Evidence: `docs/evidence/`,
  `docs/assets/node-console-block-136899.webp`.
- **T-3.6B (commit e34635f)**: the imported framer-motion console replaces
  the Phase 2B pages; every screen on the typed client + WS (Overview live
  topology, node drawer, Failure Lab, Scenarios, Incidents evidence,
  Deployments, Validators, Settings); unbuilt features disabled + labelled
  (DEC-028).

### 2. Verification (commands + ACTUAL results, 2026-10-21)

- `npm run typecheck` ✓, `npm run lint` ✓, `npm run build` ✓.
- Unit suite in chunks (120 s command cap): web 55/55 (7 files), api+cli
  79/79 (5), engine 60/60 + 134/134 + 41/41 + 10/10 → **379/379 (29
  files)**.
- Live re-verification against the public V3 endpoints with the API on
  the evidence data dir: probe healthy 3/3 (best #137255, EVM chain id
  match, node console HTTP 200); status → registry from deployment,
  signer ≈3.15 tPOT; verify → all four finalized anchors `verified`.

### 3. Problems, decisions, remaining work

- Costs observed (RSK-30): ≈85 tPOT deploy, ≈4 tPOT per contract anchor,
  ≈0.02 tPOT per remark; one contract attempt failed honestly with
  `StorageDepositNotEnoughFunds` and is recorded as `failed`.
- The qemu workaround was not present in the docs/UI session, so the new
  console was NOT driven against a live network or in a real browser
  (RSK-23); T-3.6B stays IMPLEMENTED and T-3.6 PARTIAL.
- Next: live UI smoke on an x86_64 host (create → monitor → Failure Lab
  pause → V3 remark anchor → verify); refund the deployer; Phase 4.


---

## 2026-10-22: T-3.6C: console + landing match the original design

**Files**: `apps/web/**` (styles, fonts, Landing, shell, Overview, Failure Lab, Incidents, Deployments, Networks, Topology, tests, `scripts/screenshots.mjs`), `packages/cli` (`kaizen up` + tests, root launcher), `README.md`, `docs/assets/ui/*.webp`, `docs/IMPLEMENTATION_PLAN.md`.

**Work**: The running console had drifted from the intended design (missing landing sections; headings fell back to a system serif because fonts were not loaded). Rebuilt the landing and console layouts against the design pages, keeping all real API/WS wiring. Added a real `kaizen up` command so the landing's hero command is truthful; Docker/Kubernetes targets are refused with a Phase 6 message. Deliberate differences: one "Recover node" action (engine has a single rollback), real peer/incident numbers, Docker/K8s marked soon.

**Results**: typecheck, lint, build green; web jsdom suite green (61); flaky Scenarios replay test fixed by waiting for the Replay button to enable (network loads async): 5/5 consecutive passes. Screenshots rendered in headless Chromium against fixture API data; no horizontal overflow at 1280/1440px.

**Status**: IMPLEMENTED, not VERIFIED: not yet driven against a live portaldot_dev network; `kaizen up` not run live (arm64 sandbox, RSK-31).

**Next step**: live smoke in Codespaces (`npx kaizen up`, then API + web), then record the demo.

---

## 2026-10-24: Phase 9: Proof-of-Resilience step 1 (T-9.1 – T-9.5)

**Branch / PR**: `feat/proof-of-resilience`, draft PR #3. Decision DEC-029; spec `docs/RESILIENCE_SCORE.md`.

**Work**:
- T-9.1 chain-bound evidence (`packages/engine/src/resilience/evidence.ts`, `rpc.ts`, `verify.ts`): best/finalized heads (number + hash) from a non-target observer before/during/after the fault; pure recovery metrics; verify re-fetches every hash (offline → `unverifiable`, difference → `mismatch`).
- T-9.2 certificates (`certificate.ts`, `signer.ts`): SHA-256 over canonical `{kaizenCertificate:1, runHash, run, chain}`, sr25519 signature over `kaizen:certificate:v1:<fp>`; signer from `KAIZEN_RESILIENCE_SIGNER_SURI` / `_FILE` (refused inside the working tree); public `//Alice` only with `--dev-key` on local designated-test networks, labelled.
- T-9.3 score v1 (`score.ts`) + spec with worked examples; trust model v2 (future-block-hash-seeded drills, BABE authorship + GRANDPA finality, evidence-class weighting) recorded as PLANNED (§7).
- T-9.4 `contracts/KaizenResilienceRegistry.sol` + reproducible build + committed artifact + codec; in-memory EVM test script.
- T-9.5 `engine.resilience` (opt-in capture via `KAIZEN_RESILIENCE_EVIDENCE=1`), CLI `certify / certificates / score / verify-certificate`, read-only `/api/resilience/*`, migrations 23–25, live test `test/integration/resilience.int.test.ts`, workflow `.github/workflows/resilience-live.yml` (x86_64, RSK-31).
- README headline: "Monitors tell you a validator is up. Kaizen proves it survives going down." with the three pillars marked by verification status.

**Verification (actual results)**:
- `npm run typecheck` ✓, `npm run lint` ✓, `npm run build` ✓ (arm64 sandbox).
- Unit (chunked, 120 s cap): web 61/61, CLI 50/50 (47 + 3 new), API 41/41 (37 + 4 new) → 152; engine 220 + 34 + 41 = 295 (includes 50 new resilience tests; store schema 25).
- `node contracts/test-resilience-registry.mjs` (optional `@ethereumjs/evm@10` + `solc@0.8.28`, `--no-save`): 6/6.
- **LIVE on x86_64 GitHub Actions**: run [40042905143](https://github.com/Shaydez-Defi/kaizen/actions/runs/40042905143) (commit 05984e4): real two-node `portaldot_dev` 2.0.0, 15 s pause of `bob`; evidence 5 observations / 0 gaps (finalized stalled at #2 during the fault, advanced to #3 after); metrics recovered, ttr 2 020 ms, finality gap 3, blocks missed 2; dev-key certificate `0x517b2ffb…2e33`; verify online `verified` (11 hashes match), after stop `unverifiable: network offline`; score 35 (one run, confidence 0.39). Artifacts copied to `docs/evidence/resilience/`. First CI run (40042658799) failed honestly on scenario validation (missing `process-state` precondition): fixed in the test.
- V3 deployer `5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR`: **3.1519 tPOT** free at block #167144 (read-only query, 2026-10-24 ~00:58 WAT).

**Not done / decisions**: `KaizenResilienceRegistry` NOT deployed (≈3.15 tPOT vs ≈85 tPOT for the last deploy, RSK-30). Pillar 1 (seeded drills) and BABE authorship / evidence-class weighting are roadmap (T-9.6, T-9.7). The v1 score still weights the operator-measured recovery time most.

**Next step**: T-9.6 commit-reveal drill scheduling; fund the deployer before any registry deploy.

---

## 2026-10-24 — T-9.8: KaizenResilienceRegistry live on the V3 test network

**Branch / PR**: `feat/v3-resilience-deploy` from `main` @ 35241cf (main frozen until the 2026-10-26 admin review; not merged).

**Work**:
- `packages/engine/src/resilience/onchain.ts` — `ResilienceRegistryService`: `deploy()` (committed artifact via `revive.instantiateWithCode`), `anchor(cert, score)` (offline sr25519 + address check, free `recorded(fingerprint)` pre-check, `record()` via `revive.call`, requires the `CertificateRecorded` log with validator + fingerprint topics), `read(validator)` (free `getScore` / `getLatest` / `recorded` dry runs). Persist-first journal hook (DEC-026): an entry is written BEFORE signing, then `included` or `failed`; balance before/after recorded; every error scrubbed of the signer secret. `encodeRecordedCall` added to the codec.
- CLI: `kaizen v3 deploy-resilience-registry [--journal]`, `kaizen v3 anchor-certificate <file> --score <n> [--registry] [--journal]`, `kaizen v3 resilience-score <validator> [--registry] [--fingerprint]` (registry also from `KAIZEN_V3_RESILIENCE_REGISTRY_ADDRESS`).
- Pre-deploy check: `contracts/compile-resilience-registry.mjs` (solc 0.8.28) reproduced `KaizenResilienceRegistry.artifact.json` and `registry-artifact.ts` byte-for-byte; `contracts/test-resilience-registry.mjs` 6/6. Interface already had `getScore(bytes32)`; no contract change.
- Signer: same env-signed path as T-8.2 (`KAIZEN_V3_SIGNER_SURI`, testnet-only burner kept outside the repo). @polkadot/api runs natively on the arm64 sandbox; no qemu needed (qemu was only for the `portaldot_dev` binary, RSK-31).

**Live results (PortaldotV3 Test, genesis 0xd4f9…83bd, EVM chain id 420420777)**:
- Balance before: 383.1519 tPOT.
- Deploy: contract `0x8ec2b52a5e407926309f983f6e7d019d66da764a`, tx `0x88bdae46743bbf059150a16d705ebe955dd3b91a8b8b34eb91d7ecb9cc0dd9e9`, block **167466** (`0x78c5ca87…c5b859`), finalized. Spent 261.7186 tPOT = 195.18 code-upload deposit + 66.204 storage deposit (both held) + 0.3346 fee. `eth_getCode` equals the artifact's deployedBytecode (3183 bytes).
- Anchor: CI certificate `0x517b2ffb81ec129c8efd61f234662ca492bf75829b3c3ce30575d912551e2e33` (run 40042905143, validator `res-it-bob` → key `0xbf1486bb…e0f0`, DEV key, evidenceFlags 3), score 35. tx `0x905f964cb7ca45c9d1ed630084595b7b8b934c0288216fdc5252436e0d86fee3`, block **167478** (`0xfbe64ed2…73f6`), finalized; `revive.ContractEmitted` topics = [CertificateRecorded, validator key, fingerprint, signer key]. Spent 30.7890 tPOT = 30.732 storage deposit + 0.0570 fee.
- Read-back: `getScore` → `(35, 1792801920, 1)` (certifiedAt = block 167478 timestamp), via both the runtime API dry run and `eth_call` on the EVM RPC; `getLatest` returns the fingerprint, run hash, signer key, ttr 2020 ms, finality gap 3, missed 2; `recorded(fp)` = true.
- Re-anchoring the same certificate → `V3_ALREADY_ANCHORED` from the free pre-check; nothing submitted.
- Balance after: 90.6442 tPOT. Total 292.5076 tPOT, of which 0.3916 fees and 292.1160 held deposits.
- Evidence: `docs/evidence/v3-resilience-registry.json` (includes the persist-first journal; no secrets).

**Verification**: `npm run typecheck` ✓, `npm run lint` ✓, `npm run build` ✓, `npm test` 40 files / 462 tests ✓ (new: engine `resilience-onchain.test.ts` 11, CLI `v3-resilience-registry-commands.test.ts` 4).

**Limits (claimed exactly)**: the anchored certificate comes from a CI drill on a local two-node `portaldot_dev` network, not a drill on V3; it is DEV-key signed (integrity, not identity); the score is operator-computed v1 and only stored on chain; test network, not mainnet. Seeded drills (T-9.6) and BABE authorship + score v2 (T-9.7) remain roadmap. Real costs are far above the run-registry estimates (≈261.7 vs ≈85 to deploy, ≈30.8 vs ≈4 per record, RSK-30): ~2 more records fit in the remaining balance.

**Next step**: review/merge this PR after 2026-10-27; T-9.6 commit-reveal drills; consider a cheaper certificate layout (event-only storage) before recording many certificates.

## 2026-10-24 03:00 WAT — T-9.6 step 1: seeded drill derivation (short session, daily usage cap)

- Added `deriveDrill` (packages/engine/src/resilience/drill-seed.ts): blake2_256 over a
  domain tag, length-prefixed validator id and a future block hash picks the fault
  (default catalogue: real-node-verified `pause`, `terminate`), start offset and duration.
- Tests: `resilience-drill-seed.test.ts` (4 pass); engine typecheck and lint clean.
- Branch `feat/commit-reveal-drills` (off PR #4); main untouched (freeze until 2026-10-27).
- Next: on-chain commit of target block N, reveal once N is finalized, certificate
  `drill` field + verifier mismatch check, then T-9.7 BABE authorship.

## 2026-10-24 22:00 WAT session: lite registry (plan item 1)

- `KaizenResilienceRegistry` rewritten to two storage slots per anchor (certHash -> score/block marker; validator latest score/block/count). Everything else is in `CertificateRecorded`. Runtime 1586 bytes vs 3183 (v1). Verified by in-memory EVM test (6 pass), engine vitest, tsc, eslint.
- Codec: `getLatest`/`certificateCount` removed, `certOf(fingerprint)` added; `getScore` now returns (score, block, count).
- NOT deployed: V3 dry run says `revive.StorageDepositNotEnoughFunds`. v1 cost 195 tPOT code deposit for 3183 bytes plus 66 tPOT instantiate; signer holds 90.64 tPOT. Needs a tPOT top-up (Portaldot Discord ticket), est. ~150 tPOT. v1 stays the live registry until then; v1 evidence kept as `docs/evidence/v3-resilience-registry-v1.json`.

## 2026-10-25 01:00 WAT session: lite registry live on V3 (plan item 1 done)

- Deployed lite `KaizenResilienceRegistry` at `0xb743ea9d9176e6a010b23887000b2a5d14574d8f` (block 181490, finalized, tx 0xa8a0a990...5e86). Cost 136.99 tPOT (v1: ~261).
- Anchored the CI-drill certificate `0x517b2ffb81ec...2e33` (block 181495, tx 0x7f49e28c...6117), 7.74 tPOT per anchor (v1: ~30.8). Read back via `kaizen v3 resilience-score`: score 35, block 181495, count 1, cert recorded.
- Evidence: `docs/evidence/v3-resilience-registry-lite.json`. Signer balance after anchor about 262 tPOT minus 7.7.
- Next: ink! twin (item 2), then monitoring (item 3).

## 2026-10-25 04:00 WAT
- ink! registry twin (contracts/ink-registry, CI ink-registry.yml, PR #6). CI result and V3 instantiate pending.

## 2026-10-25 10:50 WAT: ink! twin built, V3 deploy blocked on deposit (plan item 2)

- CI run 40180350016 green (cargo test, clippy, `cargo contract build --release` on Rust 1.85.0, cached cargo-contract); artifact: 6,848-byte Wasm (7,708 before trimming).
- V3 `contractsApi.uploadCode` dry run: `Contracts.StorageDepositNotEnoughFunds`. `depositPerByte` is 0.06 tPOT, so the upload needs about 411 tPOT held; the signer has 254.9. Logged as RSK-32. Needs about 180 more tPOT; nothing spent.
- Deploy/anchor/read-back script is ready: `contracts/ink-registry/deploy.mjs` (dry-run with KAIZEN_DRY_RUN=1).

## 2026-10-26 (evening)
- A5: added `scripts/v3-balance.mjs` (working V3 balance check). Signer 5HSwNU… holds 465.8364 tPOT; ink! deploy still ~100 tPOT short (RSK-32), deploy-pending.

## 2026-10-26 20:30 WAT: ink! twin live on V3 (A5 done)
- Deployed the 6,848-byte ink! registry at `5DZ2aWJK6gupeHNj9FhAuHWZjtTMirFes75uXeZEWa2ipkiw` (block 207418). Outlay 547.71 tPOT (includes refundable deposits). Anchored certificate 0x517b2ffb81ec... (block 207421, tx 0x512d4803...95d3), 1.416 tPOT per anchor vs 7.74 on the EVM lite registry. Read back (35, 207421, 1). Evidence `docs/evidence/v3-ink-registry.json`.
- Next: A1 combined-evidence CI drill.

## 2026-10-27 01:00 WAT
- T-9.6 step 2: `DrillRecord` build/check (drill-record.ts, 5 tests). Next: embed in certificate fingerprint, then A1 CI drill.

## 2026-10-27 04:00 WAT
- 7b2b37e: certificates optionally carry a drill record (in fingerprint); verifyCertificate checks it; 3 tests. Next: CI drill script combining drill+BABE+GRANDPA evidence (A1).

## 2026-10-27 07:00 WAT
- feat(resilience): BABE pre-digest authorship decoder + 3 tests (A1 step). Next: wire author into ChainEvidence observations and CI drill.

## 2026-10-27 10:00 WAT
- BABE author now attached to observed block refs by the HTTP chain reader (+1 test). Next: CI drill combining drill + BABE + GRANDPA evidence (A1).

## 2026-10-27 13:00 WAT
- 5f8aadc: certifyRun accepts a drill record; live CI drill test binds drill + BABE author. resilience-live run 40500819745 green on x64. Next: GRANDPA finality evidence in certificate, then A2.

### 2026-10-27 16:15 WAT
- test(resilience): live drill test now also asserts GRANDPA finality evidence (finalized head advances, finality gap measured) alongside drill + BABE author (A1). Next: A2.

### 2026-10-27 20:30 WAT
- resilience-live (x64) green on d792e36: drill + BABE author + GRANDPA finality assertions pass in one live run (A1 test-level; a single exported certificate artifact for `kaizen verify` is still outstanding).
- 74975be: `computeResilienceScore` applies the optional evidence-class factor (v1 inputs unchanged); `classifyEvidence` helper (+3 tests).
- 1af610b: anchor path sets evidenceFlags bits 2 (seeded drill) and 3 (BABE author observed) only when the certificate carries them (+2 tests). Attestation spec and signed attestations are not built yet. Next: export certificate artifact from live drill + verify (A1), then A3.

### 2026-10-27 22:00 WAT
- A1: `kaizen export-certificate <fingerprint> --out file` writes a portable bundle (certificate + the run its fingerprint covers); `kaizen verify-certificate --bundle file [--rpc url]` verifies it with no local state: fingerprint, sr25519 signature, drill record, then block hashes re-fetched from the RPC (no `--rpc` → `unverifiable`, never upgraded). 3 CLI tests cover verified, unverifiable, chain mismatch, edited bundle, malformed input. Still outstanding for A1: have the x64 live drill write the bundle and run this verify against the live node in CI.
- A1 verified: resilience-live run 40584394253 (x64, cf01ae6) is green and uploads `certificate.bundle.json`: one certificate with the drill record, BABE author on 5 observations, GRANDPA finality gap (4 blocks) and 11 block hashes re-fetched from the live node → `verified`.
- A2 (partial): `engine.resilience.scoreV2` and `kaizen score --v2 [--verify-chain]` weight each certified run by its evidence class (the signed certificate is the attestation; chain re-verification lifts signed-local 0.7 to signed-chain-verified 1.0; an unreachable network never upgrades). Not built yet: third-party attestations signed by someone other than the certificate signer, and the attestation spec document.

## 2026-11-01 01:00 WAT
- Merged origin/main (web deploy fixes, mobile UX, replay-mode console) into feat/ink-registry; conflicts in certificate/verify (kept metadata check plus drill check), README and docs (kept the newer branch text). tsc clean, certificate tests 12/12. Next: A3 live-first web app.
