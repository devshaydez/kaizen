# Decision Records (DEC)

Format: context → decision → alternatives → consequences. Newest entries appended.

---

## DEC-001: TypeScript monorepo for engine, API, CLI, and UI

- **Date**: 2026-10-09 (Phase 0)
- **Context**: Kaizen needs a shared operations engine consumed by both a CLI
  and a web UI, plus an RPC client for a Substrate-based chain (Portaldot,
  metadata V13, spec 1002: R-15). Environment has Node 24, Python 3.14,
  Go 1.27; no Rust toolchain.
- **Decision**: One TypeScript codebase on Node.js 24, npm workspaces monorepo:
  `packages/engine`, `packages/cli`, `apps/api`, `apps/web`. RPC via
  `@polkadot/api`; API via Fastify + Zod; storage via SQLite
  (`better-sqlite3`); UI via React + Vite.
- **Alternatives considered**:
  - Python backend + official Python SDK: rejected: documented signing bug of
    `substrate-interface` on Portaldot V13 metadata (pallet-scoped Balance
    type, R-16), and it splits the stack (two languages for engine + UI).
  - Go backend: rejected: no mature Substrate client; hand-rolled SCALE codec
    is unjustified risk.
  - Rust engine: rejected: no toolchain in env; slowest iteration; CLI/UI
    would still need a second language.
- **Consequences**: fastest iteration path; one type system end-to-end; the
  ecosystem quirk risk concentrates on `@polkadot/api` (mitigated by T-1.5
  proving WS + metadata against the real node early).

## DEC-002: CLI calls the engine in-process; Web goes through the API

- **Date**: 2026-10-09
- **Context**: "Shared engine" requirement (spec FR-2) could be satisfied by
  CLI-over-HTTP or CLI-over-in-process imports.
- **Decision**: CLI imports `packages/engine` services directly; the API is a
  thin transport over the same service objects.
- **Alternatives**: CLI as HTTP client of a running API: rejected: forces a
  daemon for simple CLI use, adds failure modes, no logic-sharing benefit.
- **Consequences**: single-source operation logic preserved; CLI works with no
  server running; API and CLI share types and error shapes by construction.
  Caveat: concurrent CLI + API runs must not corrupt SQLite (mitigate with
  WAL mode + busy timeout, T-1.2).

## DEC-003: REST commands + WebSocket events (no polling-only, no gRPC)

- **Date**: 2026-10-09
- **Context**: UI needs live monitoring (block height, peers, health,
  scenario progress, incidents).
- **Decision**: HTTP REST for commands/queries, single WS endpoint for the
  engine event bus.
- **Alternatives**: pure polling (janky, wasteful), gRPC (overkill, browser
  friction), SSE (fine, but WS is needed anyway for @polkadot/api patterns).
- **Consequences**: one realtime channel to secure and test; event schema is a
  versioned contract in `packages/engine`.

## DEC-004: Process orchestration safety model

- **Date**: 2026-10-09
- **Context**: The engine spawns host processes; the frontend must never
  execute arbitrary commands (FR-1).
- **Decision**: spawn only via argv arrays from an internal node-spec builder
  (no shell strings); per-node base-path under `.kaizen/networks/<id>/`;
  centralized port allocator (p2p/http/ws/prometheus per node); SIGTERM →
  grace period → SIGKILL; all stdout/stderr captured to per-node log files.
- **Consequences**: no shell-injection surface; port collisions prevented;
  log evidence available for incidents; requires explicit port-range config
  (default pool documented in README).

## DEC-005: SQLite for persistent metadata and history

- **Date**: 2026-10-09
- **Context**: Networks, scenario definitions, run history, incidents must
  survive restarts; no external infra allowed.
- **Decision**: SQLite via `better-sqlite3`, WAL mode, single file in
  `.kaizen/kaizen.db`, versioned migrations.
- **Alternatives**: JSON files (no queryability, race-prone), Postgres
  (infra burden).
- **Consequences**: zero-infra persistence; backups are file copies; concurrent
  access limited to same-host (acceptable: localhost-first product).

## DEC-006: Deployment behind a single adapter interface

- **Date**: 2026-10-09
- **Context**: Local, Docker, and K8s/Helm targets must coexist; K8s is the
  P2 wow-factor but must not block the core.
- **Decision**: `DeploymentAdapter` interface (deploy/status/logs/destroy/
  recover); Local first, Docker second, K8s/Helm third; UI/CLI consume only
  the interface.
- **Consequences**: core features ship without waiting for K8s; K8s risk is
  isolated to one package; a genuine K8s blocker degrades the wow-factor but
  cannot break the P0 core (per spec §6.6).

## DEC-007: Node binary acquisition: pinned download + TOFU hash manifest

- **Date**: 2026-10-09
- **Context**: Upstream (`portaldotVolunteer/Portaldot-node`) publishes
  tarballs but no checksums or signatures (RSK-07).
- **Decision**: BinaryManager downloads from the official URL on first use,
  computes SHA-256, stores it in a local manifest, and refuses to run a cached
  binary whose hash later changes without explicit user action. Hash surfaced
  in UI/CLI.
- **Alternatives**: vendor binaries in-repo (bloats repo, still unsigned);
  build from source (no Rust toolchain, huge build).
- **Consequences**: reproducible per-machine; supply-chain gap documented
  honestly rather than hidden.

## DEC-008: Failure operations gated to designated test networks

- **Date**: 2026-10-09
- **Context**: Failure Lab kills/pauses/disconnects nodes; operating against
  the wrong network would be destructive.
- **Decision**: every failure/destructive operation requires the target
  network to be flagged `designatedTest: true` AND to be of chain type
  Local/Development (verified via `system_chainType`). Engine refuses
  otherwise with an explicit error.
- **Consequences**: mainnet-touching features stay impossible by construction
  until an explicit future decision; aligns with spec FR-5 and §9.

## DEC-009: No fabricated data, ever

- **Date**: 2026-10-09
- **Context**: Hackathon dashboards often mock data; the spec forbids it.
- **Decision**: UI/CLI render only engine-provided real data; features not yet
  implemented are hidden behind explicit "not implemented" states; incident
  analysis is labeled symptom/evidence, never invented root cause.
- **Consequences**: slower to fill the UI, but every demo claim is backed by a
  real operation: this is the product's core credibility.

## DEC-010: Phased delivery with documented gates and evidence

- **Date**: 2026-10-09
- **Context**: Multi-phase hackathon build with heavy verification burden.
- **Decision**: work strictly per `docs/IMPLEMENTATION_PLAN.md` phases;
  IMPLEMENTED and VERIFIED are distinct; evidence lands in `docs/PROGRESS.md`;
  AGENTS.md binds future sessions to this process.
- **Consequences**: progress is auditable; scope drift is detectable; chat-only
  claims are not acceptable evidence.

## DEC-011: Genesis authority patching derives keys from the binary (no hardcoded chain data)

- **Date**: 2026-10-10 (Phase 2A, T-2.1/T-2.2)
- **Context**: The embedded Local Testnet spec seeds exactly TWO genesis
  authorities (Alice, Bob; `staking.validatorCount=2`, verified live: R-05).
  Launching four validator processes does NOT make a four-validator network:
  Charlie/Dave would never author or vote. A genuine N-validator network
  requires editing the plain spec (session.keys, staking.stakers,
  staking.invulnerables, validatorCount) and rebuilding the raw spec.
- **Decision**: ChainSpecService generates every network's spec at create time.
  Authority key material is derived from the real binary at creation time
  (`key inspect //X` for the sr25519 account, `key inspect --scheme ed25519 //X`
  for the grandpa key: the derivation was verified by reproducing the genesis
  entries of Alice and Bob). The patched plain spec is written to the network
  dir, converted with `build-spec --chain <file> --raw --disable-default-bootnode`,
  and a `chain-spec.genesis.json` audit sidecar records which authorities were
  baked in. The two-node preset keeps the UNMODIFIED spec (proven in Phase 1).
- **Alternatives**: hardcoded Charlie/Dave keys in source: rejected (fabricated
  chain data, breaks if the binary's dev keys ever change); running non-authority
  "validators": rejected (four processes ≠ four authorities; would be dishonest
  labeling); per-network ad-hoc keystore injection: rejected (spec surgery is
  the chain-correct mechanism and was proven live).
- **Consequences**: networks are self-contained artifacts (spec + sidecar in the
  network dir); creation costs a few extra binary invocations; validator
  custom topologies are capped at six (alice…ferdie): the only keys with
  verifiable derivations from this binary.

## DEC-012: Monitoring = periodic HTTP JSON-RPC sampling + a pure health state machine

- **Date**: 2026-10-10 (Phase 2A, T-2.4)
- **Context**: Live monitoring must distinguish unhealthy / unknown /
  unavailable / stale, never fabricate values, and never overlap polls. The
  node serves HTTP JSON-RPC and its legacy WS surface; @polkadot/api adds heavy
  subscriptions per sample.
- **Decision**: MonitoringService polls each node every 2s with lightweight
  parallel HTTP POSTs (system_health, chain_getHeader, system_peers,
  system_syncState, chain_getFinalizedHead, genesis hash cached per node). A
  pure `evaluateNodeHealth()` function maps (sample, process liveness,
  previous state) → one of `unknown | healthy | unhealthy | unavailable |
  stale` with evidence-based reasons: process dead/crashed, RPC failures ≥3,
  chain stalled (head frozen while RPC answers), peer shortfall past a 60s
  startup grace, stale sample gaps. One job per network with an in-flight
  guard (a slow tick skips rather than overlaps); jobs stop automatically on
  network stopping/stopped/error events and unref'd timers never hold the
  process open.
- **Alternatives**: WS subscription per sample: rejected for polling (heavier,
  reconnect storms corrupt state machines); DB-persisted samples: rejected
  (write amplification for observational data); trusting `process status`
  alone as health: rejected by design (a running process is not evidence of a
  functioning node, Phase 0 DB-wedge lesson).
- **Consequences**: monitoring data is in-memory (latest snapshot per network
  retrievable via API/CLI while the engine runs); the health machine is fully
  unit-testable without nodes; per-method RPC failures degrade one sample's
  field to null + warning instead of failing the node's health instantly.

## DEC-013: Node identity, uptime, and peer expectations are persisted; chain data stays disposable

- **Date**: 2026-10-10 (Phase 2A, T-2.3/T-2.4)
- **Context**: Monitoring needs uptime and expected peer counts; purge must
  reset chains without destroying the network definition; node-level
  start/stop must work across short-lived CLI runs (adopted processes).
- **Decision**: schema migration adds `nodes.started_at` (sticky: set on
  start, preserved across later status updates) and `nodes.expected_peers`
  (full-mesh expectation = nodeCount − 1, computed from the topology at
  create). `purgeChain()` refuses while any node process is alive, then
  deletes each node's base dir (chain DB, keystore, peers cache) while keeping
  node keys, ports, chain spec, and records: the next start boots from
  genesis with the same peer ids. Node records that are crashed/stale are
  reset to `stopped` during purge.
- **Alternatives**: store health/samples in SQLite: see DEC-012; recreate the
  network on purge: rejected (destroys audited spec + identity history).
- **Consequences**: restart-after-purge is deterministic and cheap; a network's
  lifecycle (define → start → stop → purge → start) is fully repeatable from
  CLI/API; uptime math survives CLI restarts because started_at lives in the
  store, not in process memory.

## DEC-014: Validator custom topologies require well-known keys; full nodes take none

- **Date**: 2026-10-10 (Phase 2A, T-2.1)
- **Context**: Custom topologies must be validated before anything is
  created; arbitrary key material cannot be invented (DEC-011).
- **Decision**: a custom topology is an ordered node list; every `validator`
  node must carry a unique well-known key from {alice…ferdie} (those become
  genesis authorities via the patched spec), every `full` node must carry
  none, at least one validator is required, and node names must be unique and
  well-formed. Validation is a pure function (`resolveTopology`) that runs
  before any directory, port, or process is touched; failures carry
  per-problem details. The first node in the list is the bootnode seed.
- **Alternatives**: generate fresh keypairs per validator: rejected (would
  require the binary to insert session keys pre-genesis; not verifiable here);
  allow validators without keys: rejected (a keyless "validator" cannot be a
  genesis authority and would be a misleading label).
- **Consequences**: topology validation is unit-testable in isolation; the
  6-validator ceiling is explicit and produces an actionable error instead of
  a broken network.

## DEC-015: Monitoring auto-lifecycle is event-driven; CLI/API can also sample on demand

- **Date**: 2026-10-10 (Phase 2A, T-2.4/T-2.8)
- **Context**: Polling must start when a network runs and stop when it stops,
  without every caller wiring it manually; short-lived CLI runs must still be
  able to show a real snapshot.
- **Decision**: MonitoringService subscribes to `network.status` events:
  `running` → start polling that network; `stopping`/`stopped`/`error` → stop
  and drop transient state. `snapshotNow()` performs a one-shot sample +
  health evaluation on demand (used by `kaizen network monitor` and the API
  `GET /api/networks/:id/monitor` when no job is live). WS clients receive
  typed `monitor.sample` / `monitor.health` / `monitor.peers` / `monitor.error`
  events with timestamps and node ids; REST exposes the latest or on-demand
  snapshot. Both surfaces only ever show engine-produced data (DEC-009).
- **Alternatives**: manual start/stop only: rejected (UI would have to wire
  it and the CLI could never observe); persistent daemon requirement :
  rejected (breaks DEC-002's CLI-without-daemon model).
- **Consequences**: any surface that can start a network automatically gets
  monitoring; the event stream is the single source of realtime truth for the
  future web UI (Phase 2B).

## DEC-016: Web UI is a thin typed client over the existing API; one shared WebSocket; engine types are import-type-only

- **Date**: 2026-10-10 (Phase 2B, T-2.5/T-2.6/T-2.7)
- **Context**: The operations console had to render only real backend data
  without growing a second business-logic layer, duplicating engine models, or
  leaking sockets/timers on navigation.
- **Decision**:
  - A single typed API client (`apps/web/src/api/client.ts`) owns base-URL
    handling, JSON envelopes, structured `ApiError` translation, timeouts, and
    abortability; components never call `fetch()` directly. Lifecycle ops use
    long timeouts (start 300s / stop 120s) because they are health-gated.
  - The UI's model types are `import type`-only from `@kaizen/engine`: zero
    runtime coupling, zero drift from the shared models. The web bundle never
    executes engine code.
  - ONE `KaizenEventStream` for the whole app (React context): auto-reconnect
    with capped backoff + jitter, last-unsubscribe teardown, and a `resync`
    callback after every reconnect: the server does not replay missed events,
    so pages refetch REST state instead of pretending the gap never happened.
  - Live tables poll REST at a bounded cadence (5s while running; paused when
    not running or nothing to show) and refetch on WS-driven invalidation.
    Live data is never optimistic: values come from engine reads only.
  - Node log tail is a real read of the node's captured log file via the API
    (`nodeLogTail` in the shared engine); the pane auto-refreshes (10s) while
    the node runs. No shell access from the browser (FR-1).
- **Alternatives**: per-page fetch calls: rejected (scattered error/timeout
  handling, drift); Redux-style global store: rejected (overkill for five
  screens; the event ring buffer + page-local async state suffice); true WS
  log streaming: deferred (bounded refresh covers the P1 need without a
  second protocol; revisit with since-timestamp tailing if demanded).
- **Consequences**: every UI number is traceable to an API response; the same
  client layer is testable in Node against the real backend
  (`test/integration/webclient.int.test.ts`), which is how the UI's data path
  was verified against real Portaldot nodes in this phase.

## DEC-017: Node detail route samples on demand when no monitoring snapshot is stored yet

- **Date**: 2026-10-10 (Phase 2B bug found by the live web-client test)
- **Context**: `GET /api/networks/:id/nodes/:nodeId` returned
  `sample: null, health: null` in the window between a network start and the
  monitoring loop's first stored snapshot, even though the node was verifiably
  running: the UI would show "no sample yet" against real evidence.
- **Decision**: the node route now mirrors the monitor route's fallback:
  `getLatest(networkId) ?? snapshotNow(networkId)`. An on-demand sample costs
  one bounded RPC read and reports honest unreachable data when the node is
  down (process evidence stays decisive per the Phase 2A health machine).
- **Alternatives**: leave it and let the UI poll: rejected (first paint after
  start would lie by omission; the fallback already existed one route above).
- **Consequences**: node detail is correct at any moment; caught live by
  `webclient.int.test.ts` (would have been invisible to mocked tests).

## DEC-018: Kernel-level fault operations are operator-authorized, narrowly scoped, and rollback-verified

- **Date**: 2026-10-12 (Phase 3A, T-3.1: informed by experiments C3–C5)
- **Context**: Proving sustained network partition on a single host required
  elevated mechanisms (iptables/ip6tables, network namespaces). Static
  port-scoped rules were shown to leak (fresh ephemeral source ports, IPv6
  loopback, eth0 legs), and one harness iteration silently failed to delete
  its rules: i.e. the dangerous part of privileged fault injection is not
  the cut, it is the residue.
- **Decision**: any future Kaizen operation that touches kernel state
  (firewall rules, netns, cgroups) must: (1) obtain explicit operator
  authorization before the run; (2) target only a designated test network
  (DEC-008 `designatedTest` pre-check, unchanged); (3) be scoped to a single
  process or link (cgroup/port rules on both IP families with no interface
  scoping, or a dedicated per-node link): never host-global firewall
  changes and never FORWARD/DOCKER chains; (4) capture the rule/netns
  baseline before and verify byte-identical restoration after, with rollback
  registered on every exit path (including crashes); (5) record the exact
  commands and evidence in the run log.
- **Alternatives**: unprivileged-only injector (reserved-only + proxy
  rewiring, SIGSTOP): retained as the default for T-3.2; kernel-level
  mechanisms remain the authorized fallback for cutting arbitrary nodes.
  Host-global firewall edits: rejected outright (would affect unrelated
  traffic, violates the experiment charter).
- **Consequences**: FailureInjector kernel faults are explicit, reversible,
  and auditable; evidence of isolation always includes unaffected-node
  checks (peers/head on non-targets) so a "partition" claim is never made
  from the target's silence alone.

## DEC-019: FailureInjector boundary: engine-internal, dry-run default, loopback-trust execution

- **Date**: 2026-10-12 (Phase 3B, T-3.2)
- **Context**: The injector must be callable programmatically (and via the
  API for the future Failure Lab UI) while keeping fault injection far
  narrower than the engine's raw power: no generic shell/signal/executable
  surface, no privilege escalation, no production targets. The API has no
  authentication beyond binding to 127.0.0.1 (ARCHITECTURE §8): the same
  trust model under which `stop`/`purge` lifecycle endpoints already run.
- **Decision**:
  1. Faults are engine operations (`engine.faults`), gated on DEC-008 and
     revalidated with fresh reads at execution time; the REST layer is a
     thin typed transport (Zod + engine calls) with the same gate: there
     is no remote-execution endpoint.
  2. Dry-run is the default surface (`dryRun()`/`POST …/faults/dry-run`);
     execution is a separate explicit action (`execute()` / `POST …
     /faults/execute` with a literal `mode:"execute"` body marker) that
     re-runs the entire safety boundary.
  3. Only unprivileged adapters (pause, terminate) can execute. Privileged
     fault execution (DEC-018 kernel-level mechanisms) is deliberately NOT
     implemented in the engine or API: it requires an operator-
     authorization model that does not exist yet, and the engine must never
     escalate privileges on its own.
  4. REST fault execution is consistent with the existing loopback-trust
     model (equal or lesser power than the already-exposed stop/purge
     endpoints); JSON-only parsing + no CORS headers mean browser pages
     cannot invoke it cross-origin. If Kaizen ever binds the API beyond
     loopback (Failure Lab remote access), an authorization model must land
     first: tracked in RSK-26.
- **Alternatives**: keep REST execution blocked entirely (engine/CLI only) :
  rejected because the endpoints carry no power beyond existing lifecycle
  routes and the future UI needs the same contract; bearer tokens on a
  localhost API: rejected as security theater without a user model.
- **Consequences**: fault execution over REST is as trustworthy as node
  stop/purge already are; unsupported mechanisms (peer-disconnect,
  partition) fail with typed `FAULT_NOT_SUPPORTED` results naming the
  unblock path, and cleanup-failed targets stay quarantined until
  reconciled: the injector cannot report success over an unproven rollback.

## DEC-020: Scenario authoring: descriptive registry, deterministic validation, no execution surface

- **Date**: 2026-10-14 (Phase 3C, T-3.3)
- **Context**: The Failure Lab needs reusable scenarios (ordered actions
  with timing, conditions, and explicit failure semantics) that authors
  can create/validate/save today, while execution (T-3.4 ScenarioEngine)
  does not exist yet. Two dangers: (a) authoring surfaces drifting from
  what the FailureInjector actually supports (e.g. making partition look
  executable), and (b) a "saved scenario" quietly gaining execution power
  before its executor and its gates exist.
- **Decision**:
  1. The **safe operation registry is derived at runtime from the
     injector's `describeMechanisms()`** (static adapter `support`
     declarations added for this): never a hand-maintained list. Blocked
     mechanisms (peer-disconnect, partition) appear with status `blocked`
     plus the adapters' unblock paths verbatim; `node-restart` is listed
     as `planned`. The registry is descriptive: it cannot grant execution,
     and T-3.4 must still revalidate through the injector's gates.
  2. **Blocked/planned operations are authorable only as warnings**
     (scenario saves with `validationStatus: 'warning'`); unknown
     operations, invalid configs, contradictory/impossible conditions,
     and un-evaluable condition kinds are errors (not savable). Conditions
     the architecture cannot yet evaluate (finality progression, runtime
     events) exist in the model with evaluability `planned` and are
     rejected: the model never pretends a condition is checkable.
  3. **Designated-test targeting is enforced at authoring time**
     (`requires.designatedTest=false` → `SAFETY_DESIGNATED_TEST_REQUIRED`
     error; the default is true): scenarios are DEC-008 artifacts by
     construction, and the executor re-checks at run time.
  4. **The authoring surface has zero execution affordance**: no
     execute/run/replay routes exist (asserted by test), CRUD and
     validate-only never emit fault events or create fault records, and a
     saved scenario never auto-runs. Validation is a pure engine function
     (deterministic, timestamp-free results) shared by API/CLI.
  5. Scenario authoring inherits the DEC-019 loopback-trust posture
     unchanged: it carries no more power than existing lifecycle routes
     (it cannot touch processes at all). RSK-26 still gates any future
     non-loopback exposure.
- **Alternatives**: letting scenarios store raw command/script steps :
  rejected (unreviewable, unauditable, breaks the engine-operations-only
  boundary); eagerly marking blocked mechanisms as savable-without-status
 : rejected (would misrepresent the injector); auto-normalizing explicit
  step `order` fields silently: rejected (position is authoritative and
  a mismatch is an authoring error, not something to guess about).
- **Consequences**: what an author can express is exactly what the engine
  can eventually execute through its existing services; drift is
  impossible by construction (registry mirrors adapters). The cost is
  deliberate friction: draft scenarios may save with warnings, and new
  operation types must be added to the engine (registry + typed union)
  before any scenario can reference them.

## DEC-021: Scenario run authorization: DEC-019 loopback trust + explicit mode + server-side gates

- **Date**: 2026-10-16 (Phase 3D, T-3.4)
- **Context**: T-3.4 adds the first way to make a saved scenario *do*
  something: `POST /api/scenarios/:id/execute`. Execution faults real
  (designated-test) processes, so the question is not only "does the
  engine gate it?" (DEC-008/DEC-020 cover that server-side) but "who may
  ask for it, and can they ask by accident?". The API today has no
  authentication: it trusts loopback (DEC-019), equal-or-lesser power to
  the existing stop/purge/fault routes.
- **Decision**:
  1. **A run request must carry the literal marker `mode: "execute"` and
     an explicit target** (`networkIdOrName`). Anything else is a 400
     `INVALID_INPUT` before any run record exists. Preview/save/validate
     shapes cannot be coerced into execution by adding fields, and
     execution cannot happen implicitly against "the only network".
  2. **Authorization equals DEC-019 loopback trust plus the engine's
     server-side gates**: the API layer does no permission logic of its
     own; it forwards the request and the ScenarioEngine enforces, fail
     closed: fresh revalidation of the stored definition (RSK-28),
     operation support, exact target resolution, designatedTest/chain/
     preset/minNodes/capability checks, label→node resolution,
     quarantine, and conflict checks: in that order: BEFORE the run
     record may reach `running` (the rejected record is persisted first
     as audit).
  3. **The missing control (authenticated non-loopback identity) stays
     out of scope and visible**: RSK-26 remains OPEN and T-7.3 owns the
     audit/authorization model. Nothing in T-3.4 widens DEC-019: the new
     endpoints expose exactly one power (run scenarios on designated-test
     networks) that the loopback surface already had via fault routes.
- **Alternatives**: an ad-hoc role/token check just for execute: rejected
  (two half-trust models, still nothing for non-loopback); requiring CLI
  attestation or a confirmation token in the body: rejected (the API
  server cannot distinguish a CLI from any other local client; theater,
  not control); defaulting execute to dry-run unless overridden :
  rejected (a "dry-run mode" for whole-scenario execution does not exist
  in the model; fake states are worse than absent ones).
- **Consequences**: local callers get one unambiguous, explicit, fully
  audited way to run a scenario; every refusal still leaves a persisted
  `rejected` run with its gate error. Until T-7.3, anyone with local HTTP
  access to the loopback port can start a run on a designated-test
  network: identical to the existing stop/purge posture, documented in
  RSK-26.

## DEC-022: Replay re-executes a run's snapshot through the same executor; provenance is not authorization

- **Context**: T-3.5 adds replay: re-executing the action sequence
  captured in an earlier run. Two failure modes had to be designed
  away: (a) replay silently substituting the scenario's CURRENT
  (edited/deleted) definition, and (b) a historical run acting as
  implicit authorization to fault a target again. Blockchain outcomes
  are not deterministic, so "replay" must also never imply identical
  results.
- **Decision**:
  1. **Replay = re-execution from the source run's immutable snapshot
     via the same internal run-start path as `execute()`**: one
     executor, one gate chain, one injector pipeline. If the snapshot
     lacks the information needed for a safe replay (missing/empty
     steps), the request is refused (`SCENARIO_RUN_NOT_REPLAYABLE`)
     rather than inventing values or falling back to the current
     definition.
  2. **Provenance is not authorization.** The replay request repeats
     the execute posture exactly (literal `mode: "execute"` + an
     explicit `networkIdOrName`); targets are never inherited from the
     source run, and every gate is re-evaluated with current state :
     current registry support, DEC-008 target posture, label
     resolution, quarantine, conflicts. Prior success grants nothing.
  3. **Eligible sources are terminal execution states only**
     (`completed`, `completed-with-warnings`, `failed`, `cancelled`,
     `cleanup-failed`). `rejected` never executed an action (execute
     the scenario instead); unfinished states are never resumed or
     replayed (crash-interrupted runs are reconciled to a terminal
     state first).
  4. **Replay is honest about semantics**: it repeats ACTIONS, not
     outcomes. `replayOfRunId` provenance + the explicit `replayNote`
     in the 202 response state this in the API itself; no source-run
     evidence is copied (fresh step records, fault ids, and
     verification), and a clean replay still reaches plain
     `completed` (the note does not ride the `warnings` channel).
- **Alternatives**: a dedicated replay executor/pipeline: rejected
  (duplicate safety logic is exactly the bug class this project
  forbids); defaulting the replay target to the source run's network :
  rejected (implicit authorization; DEC-008 posture could have changed
  since); replaying `rejected` runs "for convenience": rejected (no
  recorded actions exist; the honest surface is `execute()`); seeding
  the honesty note into `warnings`: rejected (would force every clean
  replay to `completed-with-warnings`, degrading honest reporting).
- **Consequences**: one unambiguous, fully audited replay surface
  (engine `replay()`, API route, typed client method) whose refusals
  are as explicit as executions'; original-vs-replay relationships are
  queryable (`?replayOf=`) without rewriting history; the DEC-019/DEC-021
  authorization posture is unchanged (RSK-26/T-7.3 still own
  authenticated non-loopback identity).

## DEC-023: V3 connectivity probe: configuration is the only target source; engine-service surface; honest, availability-scoped checks

- **Context**: T-8.1 adds connectivity checks against the official
  Portaldot V3 endpoints. The design risks were: (a) a probe that accepts
  arbitrary URLs becoming an SSRF-style scanning surface; (b) credential-
  bearing endpoint URLs (env overrides) leaking into results/logs;
  (c) overclaiming explorer "health" by attributing RPC semantics to an
  HTML site; (d) treating HTTP 200 or an expected-looking response as
  "healthy" without validating the protocol answer.
- **Decision**:
  1. **Official endpoints are configuration defaults, never immutable
     constants: and configuration is the only target source.**
     `V3_ENDPOINT_DEFAULTS` (substrate `wss://test-node-v3.portaldot.dev`,
     EVM `https://test-evm-rpc-v3.portaldot.dev`, explorer
     `https://node-console.portaldot.dev`, expected chain id 420420777)
     are overridable per-call (explicit options win) and per-environment
     (`KAIZEN_V3_*`). The probe has **no route, no request input, no URL
     parameter**: nothing can steer it at arbitrary destinations; any
     future surface must keep the config-only posture.
  2. **One small typed engine service with injected transports.**
     `V3ConnectivityProbe` (DEC-002 package boundaries; `v3/` module)
     depends on transport interfaces; unit tests inject fakes. Real
     transports reuse existing compatible clients: `PortaldotRpcClient`
     (`@polkadot/api`, DEC-001) for Substrate WS via the new read-only
     `readProbeState()`, and the engine's `fetch` HTTP stack for
     JSON-RPC/HTTP. No new dependency (no EVM library needed for three
     hex-quantity reads).
  3. **Honest status model.** Per-endpoint typed results with
     `ok | unavailable | timeout | protocol-error | malformed-response |
     mismatch`; `healthy` only when all three are `ok`. EVM identity is
     proven by reading `eth_chainId` and matching configuration: HTTP 200
     alone is never success; a wrong chain id is `mismatch`, never a pass;
     unobserved values are `null`, never guessed; a hard per-endpoint
     deadline bounds even non-cooperating transports, and the abort signal
     drives deterministic cleanup.
  4. **Explorer check is availability-only, by scope.** It verifies only
     what the public HTTP response shows (status, content type, bounded-
     prefix document title) and records that limitation in the result's
     own `warnings` (R-24: PARTIALLY VERIFIED). No scraper, no headless
     browser, no RPC semantics attributed to the console.
  5. **Redaction by construction.** Results/logs carry origin-only
     endpoints (`redactEndpointUrl` strips userinfo/path/query/fragment);
     message sanitization replaces configured URLs with their origins,
     strips URL userinfo generically, and applies the shared secret
     scrubber; config validation errors name KEYS, never values.
  6. **Live checking is environment-gated** (`KAIZEN_TEST_V3=1`, its own
     gate); the unit suite stays fully offline; a skipped gate is reported
     as skipped, never as passed (RSK-29).
- **Alternatives**: a probe API route (UI-facing): rejected for T-8.1
  scope; if ever added it must remain config-only (no caller-supplied
  URL); adding ethers/viem for the EVM read: rejected (dependency
  discipline; the read is three validated JSON-RPC calls); scraping the
  explorer UI / headless browser: rejected (fragile, new dependency,
  out of scope); immutable endpoint constants: rejected (staging/testnet
  overrides and honest config-vs-observation comparison need overrides);
  throwing from the probe on failure: rejected (per-endpoint typed
  results preserve sibling evidence and make partial outages visible).
- **Consequences**: an auditable, credential-free connectivity surface
  that later V3 tasks can build on; the first live run CONFIRMED the
  supplied expectation (chain id 420420777, R-23) instead of assuming it;
  no API/UI surface exists yet (by design); research facts live in
  `docs/TECHNICAL_RESEARCH.md` (R-23/R-24) per AGENTS.md rather than a new
  `docs/EVIDENCE.md` (which does not exist and was not created: the
  phase report separates live vs mocked evidence).

## DEC-024: Failure Lab CLI: two command groups over the shared engine, explicit target selection, honest exit codes

- **Context**: T-3.6A adds the operator-facing CLI surface for scenarios
  and runs (authoring, execution, replay, inspection, cancellation).
  The design risks were: (a) a second execution path in the CLI that
  bypasses the engine's gates; (b) silent target inference (a run landing
  on the wrong network); (c) misleading exit codes (a cancelled or
  rejected run reported as success); (d) duplicating operation logic that
  the engine already owns (DEC-002).
- **Decision**:
  1. **Two command groups, one shared engine.** `kaizen scenario
     (list | get <id> | create <file> | validate <file> | operations)`
     and `kaizen run (execute <scenarioId> | replay <runId> | list |
     get <runId> | cancel <runId>)`. Every command calls the SAME engine
     pathways the API uses (`engine.scenarioRuns.execute()`, `.replay()`,
     `.cancel()`, …) through a DI factory (`buildProgram(deps?)`): the
     CLI never re-implements gates, validation, target resolution, or
     execution; a refusal is the engine's typed error, surfaced verbatim.
  2. **Explicit target selection, never inferred.** `execute` and
     `replay` REQUIRE `-n, --network <idOrName>`; the engine's gates
     (designated test networks, DEC-008) still apply server-side. Replay
     re-confirms the network explicitly: it is never inherited from the
     source run.
  3. **Honest exit-code contract.** Terminal states `completed` /
     `completed-with-warnings` → 0; `rejected` / `failed` / `cancelled` /
     `cleanup-failed` → 1; `scenario validate` → 0 valid / 1 invalid;
     `run cancel` exits 0 only when the run was OBSERVED reaching a
     terminal state (`cancelled`, or completed*) and 1 otherwise. A wait
     timeout is reported as `OPERATION_TIMEOUT` ("the run keeps
     executing"), never as success; a cancellation nobody observed is
     never reported as success.
  4. **Rejected runs are surfaced, not swallowed.** When the engine
     refuses an execution (gate rejection), the CLI reports the typed
     error AND, when a persisted rejected run matches the attempt window,
     its id with a `kaizen run get <id>` hint: it never guesses.
  5. **Bounded waits only.** `--timeout <ms>` (default 300000 for
     execute/replay; 60000 for cancel) bounds every wait; there is no
     `--detach` (the engine's `close()` cancels locally-owned runs, so a
     detached mode would lie about ownership).
- **Alternatives**: one flat `kaizen lab …` command tree: rejected
  (scenario authoring is not lab-specific); inferring the network from
  the scenario or the last run: rejected (silent targeting is exactly
  the failure mode DEC-008 exists to prevent); `--detach`: rejected for
  now (would require a durable executor-ownership story; the CLI polls a
  bounded wait instead).
- **Consequences**: a scriptable, auditable operator surface with no
  second executor; mocked coverage in
  `packages/cli/test/scenario-commands.test.ts` (36) and live coverage in
  `test/integration/cli-scenario.int.test.ts` (5, incl. a REAL
  cross-process cancel where the execute runs in a child process); the
  web UI surface remains pending and must call the same engine/API
  pathways.

## DEC-025: Cross-process run control: durable cancellation is write-once; the executor honors foreign requests; reconcile defers to live owners

- **Context**: making `run cancel` work across processes (the cancelling
  process is not the executor) exposed three real defects, each observed
  live before it was fixed: (a) the pause adapter's liveness check used
  an in-memory-only view, so a node RUNNING IN ANOTHER PROCESS looked
  dead and the pause preflight refused; (b) the executor's own full-row
  persistence could overwrite a durable cancellation written by another
  process back to `null` (lost update): the owner then never observed
  the request; (c) every engine creation ran startup reconciliation,
  which terminalized still-live runs owned by other processes as
  `INTERRUPTED`.
- **Decision**:
  1. **Liveness is process-scoped, not engine-scoped.** `nodeAlive()`
     (pause adapter) accepts a fresh running record whose OS pid is
     alive (`isExternalPidAlive`): the same rule stop/terminate/network
     services already used. Identity for signalling stays on the
     verified pid.
  2. **Cancellation is durable and write-once.** `cancel()` persists a
     request for any non-terminal run (no local entry required: never a
     second executor; the request travels through the store only). The
     `scenario_runs.cancellation` column is append-only: the UPDATE uses
     `COALESCE(?, cancellation)` so a stale full-row rewrite can never
     clobber a persisted request back to null.
  3. **The executor honors foreign requests.** A 400 ms watcher around
     the in-flight fault polls the persisted flag once per run
     (`interruptIssued`) and interrupts through the SAME supported
     mechanism the local path uses (`faults.cancel`), once. A pending
     cancellation that lands while the interrupted fault ends
     `failed`/rejected (e.g. its hold-effect verification observes the
     recovering node) records the step/run as `cancelled`: the
     operator's request is the truth and the interruption is never
     misattributed to a genuine fault failure. `cleanup-failed` still
     quarantines (an unverified recovery is never hidden).
  4. **Ownership is stamped, and reconcile defers to live owners.** Each
     run records `executor_pid` once at insert (migration #13; never
     updated: like `replay_of_run_id`). Startup reconciliation defers
     (no write, honest `deferred` report entry) when the owner pid is
     alive, and terminalizes only dead-owner or pid-less orphans as
     before.
  5. **Terminal-state honesty is unchanged.** Cancelling a terminal run
     is still `SCENARIO_RUN_CONFLICT`; the CLI cancel polls until the
     run reaches a terminal state or the bounded timeout expires.
- **Alternatives**: refusing cross-process cancel (status quo: rejected:
  the API/CLI cancelling process is normally not the executor); a
  separate cancellation table/journal: rejected (one write-once column
  on the run row keeps the audit trail in one place); excluding the
  owner's own pid from the reconcile defer: rejected (the rule is
  simply "owner alive → defer", which is correct for every process,
  including the reconciling one).
- **Consequences**: cancellation and ownership now hold across real
  process boundaries (proven live: the CLI execute child process is
  cancelled by a separate `run cancel` and reports the honest
  `cancelled` outcome); regressions are pinned by unit tests
  (`scenario-run.test.ts`: write-once guard, cross-process cancel,
  live/dead-owner reconcile) and the live cancel test.

## DEC-026: V3 anchoring writes are explicit, operator-signed, env-only, and persisted before submission

- **Context**: T-8.2 makes Kaizen's first WRITES to an external chain (the
  Portaldot V3 TEST network, chain id 420420777). Writes cost real testnet
  funds (RSK-30), need a signing key, and must never be confused with
  successful anchoring when they fail.
- **Decision**:
  1. **Explicit only.** An anchor is written only on an explicit request :
     `kaizen v3 anchor <runId>`, or `POST /api/v3/anchors` with
     `mode:"execute"` (the web console adds a confirm dialog). Nothing
     anchors automatically when a run finishes. Registry deployment is
     CLI-only (`kaizen v3 deploy-registry`), not exposed over HTTP.
  2. **Only finished runs.** The anchored value is the deterministic run
     hash: SHA-256 of the canonical JSON of the persisted run record
     (`computeRunHash`), anchorable only for completed runs. `verify`
     recomputes it from SQLite and compares.
  3. **Env-only signer.** The secret URI is read only from
     `KAIZEN_V3_SIGNER_SURI`; it is never accepted over HTTP/argv, never
     persisted, and scrubbed from every message (redaction patterns in
     `fault/redact.ts`). Only the public SS58 address is stored/returned.
  4. **Persist first, then let the chain decide.** The anchor row is written
     `pending` BEFORE submission; tx hash / block / events from the chain
     flip it to `in-block` / `finalized`. A runtime dry run precedes every
     write so unaffordable or reverting calls fail before submission. Any
     submission whose expected evidence (RunAnchored log or Remarked event)
     is missing is recorded `failed` with a sanitized reason: never as
     anchored.
- **Alternatives**: auto-anchor on run completion (rejected: spends funds
  without consent); browser-side signing with a wallet extension (deferred:
  wallet authorization is an unbriefed T-8.x task); storing the key in
  SQLite (rejected: secrets never at rest in runtime state).
- **Consequences**: failed attempts are part of the evidence (two failed
  contract attempts are listed in `docs/evidence/v3-anchors.json`); the
  console can show anchors and verify them without ever holding a key.

## DEC-027: KaizenRunRegistry contract is the primary anchor; `remarkWithEvent` is an explicit, never-silent fallback

- **Context**: the V3 runtime exposes pallet-revive with EVM bytecode
  allowed, so a Solidity registry gives a queryable on-chain index
  (`anchoredAt(runHash)`) and an EVM-visible event; but contract calls
  reserve a storage deposit (≈4 tPOT per anchor observed, RSK-30), which a
  lightly funded operator account cannot sustain.
- **Decision**: `contract` (KaizenRunRegistry.anchor(runHash, meta) via
  `revive.call`) is the default whenever a registry is known
  (`KAIZEN_V3_REGISTRY_ADDRESS` or a recorded deployment on this chain).
  `remark` (`system.remarkWithEvent("kaizen:v1:<runHash>:<runId>")`) is
  available only when the caller chooses it explicitly (`--method remark`,
  `method:"remark"`, or the console's method selector, which defaults to
  remark to protect a low balance: the choice is always visible). There is
  no automatic fallback from a failed contract call to a remark.
- **Alternatives**: remark-only (rejected: no on-chain index, no EVM
  visibility); silent fallback (rejected: the evidence type must be what
  the operator asked for).
- **Consequences**: both methods are live-proven (contract: blocks 136899,
  136919; remark: 136940, 136947) and both are verified by `verify`
  (contract: block hash + `anchoredAt` + `eth_getCode`; remark: block hash
  + payload).

## DEC-028: Imported console design: real data only, unbuilt features disabled and labelled

- **Context**: T-3.6B ports a new framer-motion console design whose
  original ran on a simulated in-browser store (fake nodes, scripted
  incidents, generated Kubernetes manifests, staking).
- **Decision**: keep the design's look and motion; replace the simulated
  store with `ConsoleProvider` (REST state, WS events as invalidation, a
  bounded 3 s monitor poll while running). Every simulated affordance that
  has no backend is kept **disabled** with its phase label (`Planned`
  chip): node restart (planned engine op), peer-disconnect / partition
  (engine-blocked, R-22), incident detection (Phase 4), staking / session
  keys (Phase 5), Docker / Kubernetes deploy and cluster connect
  (Phase 6), custom ring/star wiring. Destructive actions (fault execute,
  scenario run/replay, stop/purge/remove, V3 anchor) always pass a confirm
  dialog. The legacy Events page was dropped; recent events live on
  Overview and the fault/run screens.
- **Alternatives**: keep the old Phase 2B pages alongside (rejected: two
  UIs over one API); hide unbuilt features (rejected: the design's
  lifecycle story is the product, and labelling is more honest than
  omission).
- **Consequences**: UI never shows a number the API did not return
  (":" for unobserved); browser-level verification is still pending
  (RSK-23).

## DEC-029: Proof-of-Resilience: chain-bound evidence, operator-signed certificates, open score; trustless drills are the stated goal

- **Context**: monitoring proves a validator is up; Kaizen's differentiator is
  proving it survives going down. A score anyone should rely on cannot rest
  on the operator's word alone, but the full trustless model (seeded drills,
  BABE authorship evidence) is more than one session of work.
- **Decision**:
  1. **Evidence is chain-bound.** Each run's evidence records best and
     finalized heads (number + hash) from an observer node that is not the
     fault target, before/during/after the fault. Recovery is declared only
     when finality advances past its pre/during-fault maximum. Metrics are a
     pure function of the observations (`computeRecoveryMetrics`).
  2. **Certificate = SHA-256 over canonical JSON** of `{kaizenCertificate:1,
     runHash, run, chain}` (same encoder as T-8.2), signed sr25519 over
     `kaizen:certificate:v1:<fingerprint>`. Signer from
     `KAIZEN_RESILIENCE_SIGNER_SURI` or `_FILE` (refused inside the working
     tree); the public `//Alice` key only with explicit `--dev-key` on a
     local designated-test network, labelled `dev: true` everywhere.
  3. **Verification never upgrades.** Integrity (fingerprint + signature)
     and chain binding (re-fetch every hash) are both required for
     `verified`; offline is `unverifiable: network offline`, a missing block
     is `unverifiable`, any difference is `mismatch`.
  4. **Capture is opt-in** (`KAIZEN_RESILIENCE_EVIDENCE=1`), certification is
     explicit and CLI-only (no HTTP signing route); the HTTP surface is
     read-only.
  5. **Score v1** is the documented pure function in docs/RESILIENCE_SCORE.md.
     The contract stores the operator-computed score next to its inputs; it
     does not compute it.
  6. **Trust model v2 is the stated direction** (RESILIENCE_SCORE.md §7):
     future-block-hash-seeded drills, BABE authorship + GRANDPA finality as
     primary evidence, evidence-class weighting. v2 fields are optional
     additions, so v1 fingerprints stay valid.
- **Alternatives**: auto-certify on run completion (rejected: signing is an
  explicit operator act); on-chain scoring (rejected: no floats/sr25519 in the
  EVM, and deposits are costly, RSK-30); claiming trustlessness before v2
  (rejected: README marks each pillar by what is verified).
- **Consequences**: v1 certificates prove integrity and chain binding, not
  that the drill was unpredictable; the README headline states this per
  pillar. `KaizenResilienceRegistry` is not deployed (deployer ≈3.15 tPOT).

## DEC-030: Approved Kaizen positioning line in project copy

- **Date**: 2026-10-30
- **Context**: A single consistent positioning statement is needed across the README, web landing experience and project specification. `docs/PROJECT_SPEC.md` is marked LOCKED and requires an explicit decision for any modification.
- **Decision**: Use this exact line as Kaizen's positioning statement: "Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake." Place it once in each requested copy slot, replacing similar landing copy where applicable. This is a copy-only change and does not change product behavior or scope.
- **Alternatives considered**: Add a separate new pitch without replacing existing UI text (rejected: it would stack messaging and violate the one-line-per-screen constraint).
- **Consequences**: The approved wording appears in the README, landing page, HTML title and meta description, footer, and PROJECT_SPEC introduction. These are positioning claims, not changes to implementation status.

## DEC-031: Registry ships on ink!/pallet-contracts; revive/PolkaVM documented as the bounded migration path

Date: 2026-10-31.

Context: mentors asked whether pallet-contracts is Portaldot's recommended production path or whether Kaizen should target the EVM/revive side, and noted the official ink! documentation has stated it will no longer be actively maintained or developed from January 2026. Measured costs on V3: registry (6.8 KB) upload plus instance deposit ~548 tPOT; certificate anchor ~1.4 tPOT via ink! vs ~7.7 tPOT on the equivalent EVM registry.

Decision: keep the registry on ink!/pallet-contracts for the hackathon scope. The choice is documented in the README and submission writeup with the cost comparison and the maintenance-horizon tradeoff. Because all anchoring goes through `V3AnchorService`, a future port to revive/PolkaVM is scoped as a change to that one service boundary. Cost logic reads live chain deposits at runtime; deposit levels are expected to continue being adjusted.
