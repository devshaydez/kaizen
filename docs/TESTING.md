# Testing Strategy & Evidence

## 1. Test Strategy

Kaizen's credibility depends on real operations, so testing is layered with a
hard rule: **the "real" layer always runs against an actual Portaldot binary,
never a mock.** Mocks exist only for pure-logic unit tests.

| Layer | Tool | Scope | Gated by |
|---|---|---|---|
| Unit | vitest | engine pure logic (topology models, port allocator, scenario validation, state machine, safeguards) | nothing: runs everywhere |
| Integration | vitest + real `portaldot_dev` | process manager, RPC client, network service, failure injection, incident detection, adapters | `KAIZEN_TEST_LIVE=1` + binary present in `.kaizen/bin` |
| E2E | scripted CLI/API flows (Playwright later for UI) | full lifecycle CREATE→MONITOR→BREAK→DIAGNOSE→RECOVER→DEPLOY | `KAIZEN_TEST_E2E=1` |
| Contract | supertest (API), JSON-schema of `--json` CLI output | API/CLI surface stability | runs with unit suite |

Conventions:
- Integration tests allocate ports from the engine's allocator (no hardcoded
  9933/9944) and use throwaway base-paths under the OS temp dir.
- Tests must clean up processes; a leaked `portaldot_dev` fails the suite.
- Every test that flips a RESEARCH status to VERIFIED records its evidence in
  `docs/PROGRESS.md` (command + actual result).

## 2. Environment Prerequisites

- Linux/macOS host, x86_64/arm64 (macOS binaries exist upstream; verify).
- Node.js 24+, npm 11+.
- Network access to `github.com/portaldotVolunteer/Portaldot-node` for first
  binary fetch (then offline-capable).
- ~1 GiB free RAM per running node process; ports from the configured pool.
- For P2 tests only: Docker daemon (T-6.1/6.2), minikube + kubectl + Helm 4
  (T-6.3/6.4).

## 3. Tests Executed in Phase 0 (evidence of environment/tech facts)

These are the sanctioned Phase 0 probes (read-only or ephemeral; run on
2026-10-09 in `/tmp/opencode/portaldot-probe`, all processes cleaned up).
Full detail in `docs/TECHNICAL_RESEARCH.md`.

| # | Test | Command essence | Actual result |
|---|------|-----------------|---------------|
| 1 | Artifact fetch | GitHub API listing + 29.6 MB tarball download | 4 tarballs exist; testnet-ubuntu = `portaldot_dev` + `subkey` |
| 2 | Binary version | `./portaldot_dev --version` | `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu` |
| 3 | CLI surface | `./portaldot_dev --help`, `build-spec --help`, `key --help` | full multi-node + key + spec toolset present (R-02) |
| 4 | Single dev node | `--dev --alice` with explicit ports | BABE blocks ~6 s; Prometheus on 9615 (R-03) |
| 5 | HTTP RPC | `system_health/chain/name/version/peers/localPeerId/syncState`, `chain_getHeader`, `state_getRuntimeVersion` | all returned real data; specName `portaldot` specVersion 1002 (R-07) |
| 6 | Chain spec export | `build-spec --chain local --raw --disable-default-bootnode` | 1,488,964-byte raw spec; Local Testnet; genesis includes babe/grandpa/staking/session/imOnline (R-10) |
| 7 | **2-node network** | Alice node + Bob node with `--bootnodes` | peered (`peers:1`, roles AUTHORITY), identical best block #7, finalized #5 on both (R-04) |
| 8 | Metadata version | `state_getMetadata` → magic/version bytes | magic `meta`, **V13** (R-15) |
| 9 | Graceful stop | `kill <pid>` (SIGTERM) on both nodes | clean exit; `pgrep` confirms no orphans (R-09) |
| 10 | Container feasibility | `file`/`ldd` on binary; `docker ps` | glibc dynamic binary (libstdc++/libz only); Docker daemon running (R-17) |
| 11 | K8s tooling | `kubectl cluster-info`, `helm list`, `which minikube` | clients present; no cluster reachable; minikube installed (R-18) |

Negative/edge findings recorded honestly:
- `--tmp` + `--base-path` are mutually exclusive (clap error): engine must
  never emit both.
- `pkill -f <pattern-that-matches-own-shell>` footgun during probes: noted for
  test-harness design (use exact-name kills).

## 4. Tests Executed in Phase 1 (unit + live suite + CLI smoke)

Run 2026-10-09 on the machine described above. Gates before any commit:
`npm run typecheck`, `npm run lint`, `npm test` (unit), `npm run build`, and
`KAIZEN_TEST_LIVE=1 npm run test:integration` (live suite). The live suites
**skip** (never report passing) without the env var.

### 4.1 Unit suite: `npm test` (no network, no binary, fast)

32 tests / 6 files in `packages/engine/test/` and `packages/cli/test/`:
`buildNodeArgs` + `assertSafeArgs` (forbidden `--tmp`/external-RPC flags),
StateStore (migrations, networks/nodes/operations CRUD, operation→network
linking), PortAllocator (probe-bind, range/stride behavior, exhaustion),
event bus (subscribe/unsubscribe), BinaryManager (TOFU manifest logic with
injected fetch/spawn: no real download), `isPidAlive` guard (pid ≤ 0 never
alive: 0/-1 have process-group kill semantics), log tail, pid file path.

### 4.2 Live suite: `KAIZEN_TEST_LIVE=1 npm run test:integration`

Real `portaldot_dev` processes; isolated temp dirs per suite
(`os.tmpdir()/kaizen-it/…`); ports from the engine allocator; shared binary
cache in `os.tmpdir()/kaizen-test-bin` (downloaded once per machine);
240 s per-test timeouts; `fileParallelism: false` to avoid port/CPU races.

| File | Tests | What it proves against the real binary |
|---|---|---|
| `binary.int.test.ts` | 1 | fresh download → SHA-256 verify → `--version` smoke; re-run idempotent (cached tarball re-verified) |
| `process.int.test.ts` | 4 | start → RPC-healthy → duplicate refused → SIGTERM stop, no orphans; invalid flag → `STARTUP_FAILED` + log tail; **cross-process adopted stop** (second manager instance stops the daemon via persisted pid); **external SIGKILL → `crashed` state + restart recovers chain DB (height not lost)** |
| `rpc.int.test.ts` | 5 | typed snapshot (chain `Development`, spec `portaldot@1002`, real libp2p peer id, finalized head); head subscription delivers advancing blocks; dead port → structured `RPC_CONNECTION_FAILED`; `readSnapshot` one-shot; **node stop+restart → same client reconnects and reads resume** |
| `network.int.test.ts` | 2 | single-node full lifecycle (create→start→real RPC inspect incl. finalized→stop→remove, history recorded, no orphans); **two-node: both `peers≥1` with AUTHORITY roles, cross-checked peer ids, identical best hash, finality progressing equally on both** |
| `api.int.test.ts` | 4 | `/api/health`; Zod validation → structured 400; network create/list delegates to the real engine; WS `/api/events` streams a hello + engine events |

Result: **16/16 live tests pass**; `pgrep -ax portaldot_dev` after the suite
→ no orphans.

### 4.3 CLI smoke (T-1.7, scripted shell)

`setup` (fresh 30 MB download + verify) → `status` → `network create` →
duplicate create → structured `NETWORK_ALREADY_EXISTS`, exit 1 → invalid
name → `--json` INVALID_INPUT envelope, exit 1 → `list` → `start` (health-
gated) → `status` (real RPC height/peers/spec via the API-inspect path) →
`--json status` parsed by a JSON consumer → `stop` (cross-process adopted
stop) → `remove` → `list` empty. **13/13 steps pass.**

### 4.4 Bugs the live suite caught (fixed; regression-tested)

Honesty demands recording these: the live layer earned its keep:

1. `withTimeout()` resolved `void`, so "graceful stop" checks were always
   falsy → every successful stop escalated to SIGKILL *and* reported
   `STOP_TIMEOUT`. Fixed + manager unit tests.
2. `new WsProvider(url, false)` disables auto-connect: `ApiPromise.create`
   hangs forever. Fixed (numeric retry delay).
3. `key generate-node-key` prints the peer id to **STDERR**; the engine
   parsed stdout only → two-node create failed. Fixed (parse both streams;
   never log the key file content).
4. `api.provider` is `undefined` on @polkadot/api v17: raw
   `system_localPeerId` always failed (surfaced as a `null` peer id with a
   warning). Fixed (client holds the `WsProvider` reference).
5. `isPidAlive(0)` → `kill(2)` pid 0 signals the whole process **group**;
   the pid ≤ 0 guard was missing. Fixed + unit test.
6. `@fastify/websocket` routes registered synchronously on the root instance
   *before* the plugin loads never get the `onRoute` hook → `websocket: true`
   silently ignored (handshake → 500). Fixed (routes in a plugin scope).
7. Cross-process gap: CLI processes are short-lived while nodes are daemons,
   but `stop()` refused nodes it didn't start: and the failed stop nulled
   the pid, letting `remove()` delete a **running** node's data dir. Fixed
   (adopted stop via persisted pid/pidfile; stop failure keeps the record
   intact) + live test.
8. Crash state (`crashed` vs `stopped`) incorrectly depended on an `onExit`
   notification hook being wired. Fixed (crash detection is intrinsic).
9. `network.create` operations weren't linked to the created network id
   (history filter missed them). Fixed (`attachOperationToNetwork`) + test.

### 4.5 Skipped-on-purpose (never reported as passing)

Without `KAIZEN_TEST_LIVE=1` the entire 4.2 table is skipped. `subkey` is
not exercised (bundled binary, no Kaizen feature needs it yet). PromQL
scrapes of Prometheus are not part of the suite (Phase 2 monitoring uses
RPC-first signals).

## 5. Tests Executed in Phase 2A (topologies, monitoring, API/WS, CLI)

Run 2026-10-10 on the same host. Gates before commit: `npm run typecheck`,
`npm run lint`, `npm test` (unit), `npm run build`, and
`KAIZEN_TEST_LIVE=1 npm run test:integration`.

### 5.1 Unit suite: `npm test`: 81 tests / 10 files (Phase 1: 32)

New coverage: topology presets + custom validation (duplicate names/keys,
keyless validators, >6 validators, missing validators, invalid input
rejected before side effects); ChainSpecService against a fake binary
(plain → patch → raw pipeline, authority parsing, key-derivation URIs,
genesis audit sidecar, key material never logged); health state machine
(process-death precedence over RPC failures, unavailability threshold,
stall, stale-data, peer grace); HTTP sampler against a live local stub RPC
server (parallel fan-out, per-method degradation to null + warning);
MonitoringService (in-flight overlap guard, `monitor.*` event payloads,
auto-stop on network stop events, `snapshotNow`); NetworkService with the
fake binary (four-validator build, unique ports, bootnode wiring,
partial-create rollback leaves no debris, purge semantics, recovery after
a failed create); store migrations v4/v5 (sticky `started_at`,
`expected_peers`, idempotent `close`).

### 5.2 Live suite: `KAIZEN_TEST_LIVE=1 npm run test:integration`

Real `portaldot_dev` processes; isolated temp dirs; engine-allocated ports;
shared verified binary cache; sequential files. Final run: **25/25 tests /
7 files in 213 s; `pgrep -ax portaldot_dev` → no orphans.**

| File | Tests | What it proves against the real binary |
|---|---|---|
| `topology.int.test.ts` | 6 | 4-validator: patched spec built from the binary, full mesh (peers=3), identical genesis hash on all four, blocks produced, GRANDPA finality; validator+fullnode: keyless node reaches network head, syncs, authors nothing; custom 3-node topology; invalid topology → structured error with zero debris (no dirs, no ports, no DB rows); purge → restart boots from genesis with the same peer ids; concurrent creates → unique identities/ports/specs |
| `monitor.int.test.ts` | 1 | auto-attach on `running`; real samples (heads, peers, genesis hash, uptime, expected peers); connectivity observed over RPC; external SIGKILL → `unhealthy` with crash evidence; survivor observes the 1→0 peer transition; polling stops with the network; on-demand snapshot honest for stopped nodes (`unhealthy`, never "healthy") |
| `api.int.test.ts` | 6 | custom-topology validation → structured 400 with per-problem details; node detail/list semantics; node ops on a non-running node → 409 `NODE_NOT_RUNNING`, unknown node → 404 `NODE_NOT_FOUND`; monitor endpoint honest on a stopped network; purge; WS streams typed `network.created` + `network.status` with timestamps and ids |
| `binary.int`, `process.int`, `rpc.int`, `network.int` (Phase 1) | 12 | Phase 1 coverage re-run green (unchanged) |

### 5.3 CLI smoke (scripted shell over the Phase 2A surface)

**21/21 steps** on a real four-validator network (script under
`/tmp/opencode/cli-smoke.sh`, data dir outside the repo, verified binary
cache reused): `status`; `network create --preset four-validator` (4 nodes
persisted + genesis audit sidecar present); health-gated `start`;
`network monitor` → all 4 reachable with real heads; second snapshot →
**full mesh observed over RPC (peers ≥ 3 on all four)**; `node list` all
running; `node stop`/`node start` on one validator; `purge` correctly
**refuses while nodes run**; `stop`; `purge`; restart → boots from genesis
(best #4 < 30); `remove`; list empty; `pgrep` → no orphans.

### 5.4 Bugs the Phase 2A tests caught (fixed; details in PROGRESS §4)

1. Health precedence: a dead/never-started node was mislabeled
   `unavailable`/`unknown` because RPC-failure counting ran before the
   process-liveness check. Fixed + unit test.
2. Stdio drain race: capturing subprocess output on `'exit'` instead of
   `'close'` occasionally lost the peer-id line under concurrent key
   generation (caught by the live concurrent-create test). Fixed in every
   capture path, with signal-aware error text.
3. Unit-level catches during development: head-advance closure bug,
   promise-result shape misuse, non-idempotent store `close`.

## 6. Known Limitations (current)

- No image built for Docker (T-6.1), no cluster started (T-6.3).
- Validator staking flows unexercised on-chain (Phase 5).
- Stall ("alive but wedged") detection is implemented in the health machine
  (chain-stalled reason, unit-tested) but was not induced against a real
  wedged node: that belongs to Phase 3 failure work.
- The `unavailable` state is unit-tested; the live suite exercises the
  stronger process-dead → `unhealthy` path (by design, process evidence
  takes precedence).
- Partial authority-set finality (e.g. 3-of-4 online) deliberately untested
  (Phase 3; RSK-12).
- Single-host partition fidelity depends on mechanism chosen (T-3.1, RSK-09).
- Live suite verified on linux-x64 only (macOS/WSL per R-20).

## 7. Reproduction Instructions for Phase 0 Probes

```bash
mkdir -p /tmp/portaldot-probe && cd /tmp/portaldot-probe
curl -sL -o portaldot-testnet-ubuntu.tar.gz \
  https://github.com/portaldotVolunteer/Portaldot-node/raw/main/portaldot-testnet-ubuntu.tar.gz
tar -xzf portaldot-testnet-ubuntu.tar.gz && cd portaldot-testnet-ubuntu && chmod +x portaldot_dev subkey
./portaldot_dev --version

# single node + RPC probes
mkdir -p /tmp/pd1
./portaldot_dev --dev --alice --base-path /tmp/pd1 --port 30343 \
  --rpc-port 19933 --ws-port 19944 --no-telemetry &
curl -s -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' http://127.0.0.1:19933

# 2-node local network
./portaldot_dev build-spec --chain local --raw --disable-default-bootnode > local-raw.json
./portaldot_dev --chain local-raw.json --alice --base-path /tmp/pdA --port 30353 \
  --rpc-port 19953 --ws-port 19964 --prometheus-port 9715 --name kaizen-A &
# read peer id from log: "Local node identity is: <PEER>"
./portaldot_dev --chain local-raw.json --bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<PEER> \
  --base-path /tmp/pdB --port 30354 --rpc-port 19954 --ws-port 19965 --prometheus-port 9716 --name kaizen-B &
# then: system_peers / chain_getHeader on both ports; kill both when done
```

## 8. Future Test Requirements (by phase)

- Phase 1: process-manager failure matrix (SIGTERM, SIGKILL, crash-on-start,
  port-in-use, disk-full base-path), RPC reconnect on node restart.
- Phase 2B: UI e2e: dashboard renders live WS data from a real network;
  no-mock-data assertion.
- Phase 3: each fault mechanism positive+negative test; scenario replay
  determinism check (same action sequence, recorded, not outcome-claimed);
  induced wedge → stall detection; partial-authority finality characterization.
- Phase 4: every signal collector induced-fire test; recovery outcome recorded.
- Phase 5: staking/session happy-path + permission-denied paths.
- Phase 6: image build, container network, helm install/upgrade/destroy on
  minikube, pod-kill recovery.
- Phase 7: full-lifecycle E2E from clean clone; security audit checklist.

## 9. Tests Executed in Phase 2B (web UI, client layer, logs endpoint)

### 9.1 Component/unit layer (mocked: fixtures only, never production)

`npm test` → **113 tests / 17 files pass** (81 pre-existing engine/CLI
unchanged + 32 new web tests, `apps/web/src/**/*.test.{ts,tsx}`):

- `api/client.test.ts` (7): success envelope; structured error → `ApiError`
  with code/status/issues; non-envelope failure → `HTTP_500`; non-JSON 2xx →
  `BAD_RESPONSE`; hung request → `TIMEOUT`; transport failure →
  `NETWORK_ERROR`; failed `OperationResult` returned as value (never thrown).
- `api/events.test.ts` (6): single socket for many subscribers; event fan-out
  + garbage frames ignored; reconnect with backoff → new socket → `resync`
  fires once; no reconnect with zero listeners; `close()` tears socket+timers;
  exact status transition sequence.
- `pages/OverviewPage.test.tsx` (4): metrics DERIVED from responses (not
  hardcoded); unhealthy counted from real health states; empty state; error +
  retry.
- `pages/NetworksPage.test.tsx` (4): list + client-side filter; create →
  navigate; API validation issues rendered; list failure error state.
- `pages/NetworkDetailPage.test.tsx` (4): nodes + live tables incl. honest
  `unreachable` cells; Start runs + refetches actual state; purge requires
  confirmation (cancel does nothing); not-found error state.
- `pages/NodeDetailPage.test.tsx` (3): live chain data + real log tail;
  explicit `RPC unreachable` state (no invented numbers); unknown-node error.
- `pages/EventsPage.test.tsx` (4): honest waiting state; one row per event
  delivery with real timestamp; reconnect banner + no replayed/fake events;
  kind filter.

jsdom environment; `src/test-utils/` holds the scripted `FakeWebSocket`,
record builders, and render wrapper (test-only).

### 9.2 Live suite: `KAIZEN_TEST_LIVE=1 npm run test:integration`

**30 tests / 8 files** (Phase 2A's 25 + webclient 5). Full-suite runtime
224.79s on this host. One failure during the phase was api.int asserting the
pre-DEC-017 node-route contract (`sample: null`); the contract intentionally
improved (on-demand sample of honest unreachable data) and the test was
updated: re-run green.

New file `test/integration/webclient.int.test.ts` runs the ACTUAL
`KaizenApiClient` + `KaizenEventStream` (the browser's code) against a real
API server + engine + real `portaldot_dev` network (single-node preset,
health-gated start → monitor → stop → remove):

1. health + structured `INVALID_INPUT` errors through the client;
2. create → detail (1 node) → `network.created` observed on the UI stream
   with a real timestamp; structured 404 for unknown ids;
3. start (health-gated) → monitor: `healthy`, peers `0/0`, real head number,
   `0x…` genesis; node detail carries the same live evidence; **cross-check
   vs an independent raw RPC read** (head within drift, peer count equal,
   real `12D3KooW…` peer id);
4. new logs endpoint → real log bytes from disk (`listening for new
   connections…`); invalid `maxBytes` → structured 400;
5. stop → `stopped` + honest `unhealthy`/unreachable; typed
   `network.status running/stopped` events seen on the stream; cleanup.

Reproduce:

```bash
npm run build
KAIZEN_TEST_LIVE=1 TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  npm run test:integration
pgrep -ax portaldot_dev   # must print nothing after the suites
```

### 9.3 Verification boundary (read this before citing evidence)

- **Real backend/infrastructure**: §9.2 only (REST/WS/engine/nodes/RPC +
  the UI's transport code end-to-end).
- **Mocks/fixtures**: everything in §9.1: rendering and state logic.
- **NOT done**: real-browser E2E (no Playwright in the repo): RSK-23. Do
  not describe Phase 2B as "browser-verified".

---

## 10. Experiments Executed in Phase 3A (fault-mechanism feasibility, T-3.1)

### 10.1 What ran

Standalone harness `test/experiments/t31-spike.mjs` (Node ESM; imports the
built engine only: run `npm run build` first). Every experiment creates a
**fresh disposable** Kaizen-managed network, verifies `designatedTest`
before faulting (DEC-008), and tears everything down (leak checks after
each run: no `portaldot_dev`/`socat`, empty netns, empty INPUT/OUTPUT
firewall, no `t31-*` cgroups, no leftover data dirs).

```bash
KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode \
  node test/experiments/t31-spike.mjs <subcommand>
```

| Subcommand | Mechanism | Result | Log |
|------------|-----------|--------|-----|
| `a-pause` | SIGSTOP/SIGCONT pause-resume | VERIFIED | `t31-a-full.log` |
| `b-peer` | reserved-peer RPC (normal connection) | negative (no disconnect) | `t31-b.log`, `t31-b2.log` |
| `b-peer-reserved` | removeReservedPeer on `--reserved-only` node | VERIFIED | `t31-b3.log` |
| `c-partition` | bootnode-proxy cut, `--no-mdns` | cut yes / reconverges ~15 s | `t31-c3.log` |
| `c-partition-mdns` | bootnode-proxy cut, mDNS left on | reconverges ~1 s (mDNS bypass) | `t31-c5.log`, `t31-c2.log` |
| `c-partition-reserved` | reserved-only + proxied reserved-nodes (unprivileged) | VERIFIED sustained ≥90 s | `t31-c4.log` |
| `c-iptables` | static port-scoped iptables (v4) | partial; escape via ephemeral/IPv6 | `t31-f2.log`, `t31-f4.log` |
| `c-iptables-cgroup` | ip{,6}tables + cgroup process scoping | VERIFIED sustained; baseline restored | `t31-f6.log` |
| `c-netns` | netns + veth link cut | VERIFIED; head frozen vs advancing | `t31-g.log` |
| `d-terminate` | engine stop/start | VERIFIED (health ≠ pause) | `t31-d.log` |
| `rpc-probe` | RPC method inventory (no faults) | method set recorded | any run log |

`c-iptables*` and `c-netns` are privileged (sudo) and require prior operator
authorization (DEC-018); they self-verify firewall/netns state before and
after.

### 10.2 Gates executed for T-3.1 (all green)

- `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run build` ✅
- `npm test` ✅: 113 tests / 17 files
- `KAIZEN_TEST_LIVE=1 npm run test:integration` ✅: 30 tests / 8 files
  (226 s, real `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu`)

### 10.3 Verification boundary

- Partition claims require observed connectivity change **and** unaffected
  connectivity on non-target nodes (peer sets + `ss` + head/finality), never
  the target's silence alone.
- Health values cited are direct RPC reads; no monitor/UI behavior during
  faults is claimed.
- Not covered: windows >90 s, partial-authority finality under isolation
  (RSK-12), real-browser anything (unchanged boundary, §9.3).

---

## 11. Tests Executed in Phase 3B: FailureInjector (T-3.2)

### 11.1 Unit layer (no portaldot; real stand-in processes)

`packages/engine/test/fault.test.ts`: **23 tests**. The stand-in "node" is
a tiny local HTTP RPC server run by `node -e`, so SIGSTOP/SIGCONT, TCP
reachability, pid files, and restart semantics are REAL: only the
blockchain is absent (that part is §11.2). Covered: lifecycle-machine
truth table; safety-gate rejection (unknown network/node, non-designated,
non-local chain, stopped node, ambiguous pid file, identity drift between
preflight and execution); dry-run default (plan + zero side effects);
verified pause and terminate flows with distinct claims; concurrent-fault
conflict; cancellation during hold; shutdown rollback (no paused process
leaks); cleanup-failure → quarantine → reconcile-on-proof; blocked adapters
(peer-disconnect/partition typed unsupported + unblock paths); scripted
adapter paths (apply timeout, unobserved effect, cleanup throw); secret
redaction (string + deep-by-key); event ordering and payload shape;
idempotent status queries.

### 11.2 Live integration (real `portaldot_dev`, disposable networks)

`test/integration/faults.int.test.ts`: **5 tests** against a Kaizen-created
two-node network (`designatedTest === true` asserted at creation: the
DEC-008 basis). Every live fault claim pairs the injector's result with an
INDEPENDENT observation from the test itself:

| Test | Claim | Independent evidence |
|------|-------|----------------------|
| pause | dry-run applies nothing; execute verified end-to-end | test's own 500 ms RPC polling saw the victim unreachable ≥5 s and reachable again; pid unchanged; `chain_getHeader` advanced past the pre-fault head |
| terminate | exit + restore verified | old pid dead, NEW pid serving RPC, `peers >= 1` on both nodes, head advanced |
| REST surface | dry-run default; execute needs `mode:"execute"`; blocked mechanisms → 409 `FAULT_NOT_SUPPORTED`; cancel of terminal → 409; unknown fault → 404 | `app.inject` against the real engine; `fault.state` events observed on the bus |
| escape-proof | node of another network → `NODE_NOT_FOUND`; that node untouched | other network's node status stayed `created` |
| audit hygiene | every record terminal; none stuck `cleanup-failed`; no key material in records | `engine.faults.list()` + serialized scan |

### 11.3 Commands and actual results (2026-10-12)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 136/136 passed (18 files, 68 s): 113 prior + 23 new
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 35/35 passed (9 files, 268 s): 30 prior + 5 new
```

- **CLI smoke**: no new CLI surface in T-3.2 (CLI/UI for faults is T-3.6);
  the CLI is unchanged and covered by the existing suites.
- **Harness**: the Phase 3A spike harness (`test/experiments/t31-spike.mjs`)
  was NOT duplicated: it remains the mechanism-research tool; the injector
  is the production path and shares no experiment code.
- Prerequisites: `npm run build` first (API typecheck consumes engine dist);
  the live suites need a binary cache (`KAIZEN_TEST_BIN_DIR`) and skip
  honestly without `KAIZEN_TEST_LIVE=1`.

## 12. Tests Executed in Phase 3C: Scenario Model & Authoring (T-3.3)

### 12.1 Unit layer (pure model + registry; no processes, no clock)

`packages/engine/test/scenario.test.ts`: **32 tests**. Registry built from
a REAL `FailureInjector.describeMechanisms()` (never a fixture list).
Covered: registry mirrors adapters (pause/terminate supported;
peer-disconnect/partition blocked with unblock paths verbatim;
node-restart planned; no shell/command/signal/env surface; strict config
schemas reject unknown keys); normalization (missing step ids → `step-N`,
order = array position, pause default timeout = hold + 60s headroom);
explicit order mismatch; duplicate/malformed step ids; schemaVersion;
unknown operation types; blocked/planned representability (warnings only,
`validationStatus: 'warning'`, never errors that would imply executability);
per-operation config validation (strict); fault precondition requirement +
missing-postcondition warning; planned-condition rejection
(`CONDITION_NOT_EVALUABLE`); contradictions/impossibilities (opposite
booleans, disjoint state sets, unsatisfiable peer bounds, exact-count
conflicts, stopped-but-RPC-reachable, recovered-but-RPC-down); condition
timeout/label bounds; delay/timeout bounds; `TIMEOUT_TOO_SHORT_FOR_HOLD`;
worst-case duration cap; DEC-008 designated-test enforcement; preset ↔
node-label checks (incl. custom-preset unverifiable warning); failure/
cancellation policy enums (including the fixed safe `cancel-run` /
`cleanup-then-stop` pair); names/tags/description/step-count limits;
secret-shaped content rejection (description + PEM in step descriptions);
structured issue shape (code/severity/path/message/remediation/stepId);
non-object input never throws; byte-identical deterministic results;
capability rules via an injected registry (supported op missing capability
→ error; declared → passes).

### 12.2 Persistence layer (real SQLite, incl. file-backed restart)

`packages/engine/test/scenario-store.test.ts`: **11 tests**. CRUD
round-trip with stable ids/timestamps; full restart reload (close + reopen
the same db file) byte-identical; duplicate names on create/update →
`SCENARIO_ALREADY_EXISTS`; duplicate ids at the store layer; NOT_FOUND on
get/update/delete; atomic updates (invalid update changes nothing, good
update writes everything with provenance preserved); q/tag/status filters
+ pagination + totals; malformed JSON row and schema-version-99 row
surfaced as per-row `malformed` entries while parseable rows still serve;
`validate()` persists nothing and emits nothing; CRUD emits
`scenario.created|updated|deleted` audit events and ZERO fault events or
fault records; delete semantics.

### 12.3 API layer (real Fastify app + real SQLite via app.inject)

`apps/api/test/scenarios.test.ts`: **18 tests** (new `apps/api/test/`
suite, added to `vitest.config.mts`). CRUD (201/200/200/404), structured
`SCENARIO_INVALID` 400 with per-issue code/severity/path/remediation,
unknown-operation 400, secret-content 400 (secret never echoed back),
duplicate-name 409, malformed-JSON 400 (no stack leaks), list filtering +
pagination + invalid query 400, validate-without-store-touch (totals
unchanged), registry endpoint statuses (blocked ops with unblock paths,
no command/shell/exec/signal fields), blocked-op drafts save as explicit
warnings, **no fault execution during CRUD/validate** (zero fault events,
zero fault records, zero active faults), **no execute/run/replay routes
exist** (404 by absence), DEC-019 posture (loopback host constant,
structured 400 for malformed JSON). `apps/web/src/api/client.test.ts` +
**4 tests** for the typed scenario client contract (list query params,
validate path/method, PUT/DELETE, SCENARIO_INVALID translation).
`packages/engine/test/fault.test.ts` + **1 test** asserting
`describeMechanisms()` mirrors the adapters.

### 12.4 Commands and actual results (2026-10-14)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass
npm run build            # pass
npm test                 # 202/202 passed (21 files): 136 prior + 66 new
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 35/35 passed (9 files, 346 s): full regression,
                         # T-3.2 injector/live fault suites intact
```

- **No new live-node work in T-3.3** (authoring is pure data + SQLite); the
  live run above is regression evidence that the injector, network, API,
  and web-client live suites all still pass with the scenario changes.
- **CLI smoke**: no new CLI surface (scenario CLI is T-3.6, per plan); CLI
  typecheck/build covered by the shared-engine suites.
- Prerequisite reminders: `npm run build` before typecheck (API consumes
  engine dist); `zod` is now an engine dependency (workspace-hoisted, same
  version as the API); the API test suite runs in the unit config (real
  Fastify app + temp SQLite: never spawns portaldot).

## 13. Tests Executed in Phase 3D: Scenario Execution Engine (T-3.4)

### 13.1 Engine unit suite: `packages/engine/test/scenario-run.test.ts`

**37 tests** (new), run against a real SQLite store, real EventBus, real
FailureInjector, and **real stand-in node processes** (fake JSON-RPC HTTP
servers, the same R-22 A pattern as `fault.test.ts`): no live portaldot,
no mocked injector. Covered:

- **State machines**: every legal run transition (13 states) and step
  transition (11 states) accepted; phase-skipping and terminal
  resurrection rejected; terminal-state classification.
- **Execution core**: steps run in declared order through the injector
  (exactly one execute-mode fault record per fault step: no bypass);
  full per-step evidence (pre/post verdicts with details, claims,
  outcome, verification, cleanup); immutable snapshot survives later
  authoring edits; run history survives store reopen; event ordering
  (`created` first, `finished` last, exact state-chain sequence).
- **All 10 pre-execution gates**, each asserted as a persisted `rejected`
  run with a precise error code (VALIDATION_FAILED / UNSUPPORTED_OPERATION
  / TARGET_UNRESOLVED / GATE_REFUSED / CONFLICT) and **zero fault
  records**: mode marker + unknown scenario, unregistered target,
  non-designated target, blocked/planned operations, unresolvable labels,
  preset mismatch, freshness (drifted definition), secret-tampered
  definition (secret never echoed into the record), concurrent/active
  conflicts, quarantine.
- **Preconditions/postconditions/failure policies**: skip-step records the
  reason and continues; abort-run stops with PRECONDITION_FAILED;
  cancel-run path; failed postcondition → verification failed → policy;
  INCONCLUSIVE postcondition is never fabricated (warn-and-continue →
  `completed-with-warnings`, fail-step → run failed); no authored
  postconditions → `not-required` + warning; policy validated at run time.
- **Timeouts**: condition budget exhaustion during preconditions →
  STEP_TIMEOUT (no fault created); in-operation step deadline via a slow
  scripted adapter.
- **Cancellation**: before side effects (no fault ever created), during
  the operation (via `injector.cancel` only, rollback verified), between
  steps, cancel of a finished run → SCENARIO_RUN_CONFLICT; persisted
  `cancel-requested`.
- **Cleanup failure**: unconfirmed cleanup → run `cleanup-failed` +
  `scenario-run.cleanup-failed` high-severity event + target quarantine
  blocking new runs + reconcile releasing only on proof; a lying observer
  keeps the quarantine.
- **Startup reconciliation**: unfinished runs terminalized as INTERRUPTED
  from every non-terminal state (NEVER resumed, steps untouched),
  stuck faults SIGCONT-swept then reconciled or quarantined, ready-state
  faults → `cancelled`, pre-execution interruptions emit no run events,
  idempotent across calls.
- **Shutdown**: `close()` cancels in-flight runs through the cleanup path
  and then refuses new runs.

### 13.2 API unit suite: `apps/api/test/scenario-runs.test.ts`

**9 tests** (new suite, real Fastify app + real SQLite via
`app.inject`, never spawns portaldot). Execute validation (missing mode
marker / target → 400, unknown scenario → 404 with no run persisted);
gate refusals as structured 4xx (403 non-designated, 404 unknown target)
**with the rejected run persisted as audit and zero fault events/records**;
the full 202 → background run → terminal flow through a legitimately
skip-step scenario (per-step evidence served over the wire,
`onPreconditionFailed=skip-step` recorded, skipped step never reaches the
injector); run status endpoint; paginated + filtered history (limit/
offset/total/malformed + invalid query → 400 + unknown run → 404
SCENARIO_RUN_NOT_FOUND); cancellation (202 → `cancel-requested` persisted
→ terminal `cancelled`, no side effects) and cancel of a finished run →
409 / unknown run → 404; DEC-019 posture (structured errors, no stack
leaks). The T-3.3 suite's "no execution routes" test was updated to its
T-3.4 truth: no implicit-execution/replay routes; execute demands the
explicit marker + target; refusal persists a rejected run.

### 13.3 LIVE integration: `test/integration/scenario-runs.int.test.ts`

**8/8 passed** against REAL `portaldot_dev` two-node network
(disposable, designatedTest: DEC-008; independent test-side RPC/process
observation for every claim):

1. **Pause run with independent verification**: victim unreachable while
   the run's fault is held (sampled by the test itself), then same pid +
   RPC back + head advanced; run `completed`, claims all true, cleanup
   verified, no quarantine, injector's active list empty.
2. **Two sequential pause steps** in declared order, distinct fault
   records, monotonic `requestedAt`, both terminal, independent recovery.
3. **Precondition failure aborts**: peers-gte-999 never holds → run
   `failed` with PRECONDITION_FAILED, `faultId` null, zero new fault
   records, node untouched (same pid, chain producing blocks).
4. **skip-step live**: unmet step skipped with its recorded reason while
   the next step executes FOR REAL (fault record exists, recovery
   verified): run `completed-with-warnings`.
5. **Cancellation during the hold**: fault observed active, victim
   unreachable independently, cancel requested → `cancelled` with
   `recoveryVerified: true`, cleanup verified, same pid, RPC back, chain
   resumed, no leaked/paused process.
6. **Step-deadline exhaustion**: authored condition budget (8 s chain-
   progress 'stalled') exceeds the step budget (5 s) → honest
   `STEP_TIMEOUT`, `faultId` null, zero faults, node never touched.
7. **Phantom targets fail closed**: directly-inserted non-designated
   network and simulated `mainnet`-chain network both refused
   (SCENARIO_EXEC_NOT_ALLOWED, messages cite the gate) with persisted
   rejected runs and zero faults.
8. **Unresolvable label**: scenario saved as a warning (no preset) is
   refused at run time with a persisted rejection; live nodes untouched.

### 13.4 Commands and actual results (2026-10-16)

```bash
npm run typecheck        # pass (engine, cli, api, web)
npm run lint             # pass (incl. new test files)
npm run build            # pass
npm test                 # 248/248 passed (23 files): 202 prior + 46 new:
                         #   scenario-run.test.ts 37, scenario-runs.test.ts 9
                         #   per-layer: engine 185, api 27, web 36
TMPDIR=/tmp/opencode KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin \
  KAIZEN_TEST_LIVE=1 npm run test:integration
                         # 43/43 passed (10 files, 317 s): 35 prior + 8 new
                         # scenario-run live checks; T-3.2 fault suites intact
```

- **CLI smoke**: no new CLI surface in T-3.4 (run commands are T-3.6,
  which will call `engine.scenarioRuns` exactly like the API does); CLI
  typecheck/build are covered by the shared gates.
- **Hygiene after the live run**: no orphaned `portaldot_dev` processes
  (the suites tear down their networks and assert cleanup themselves).
- **Not faked anywhere**: inconclusive conditions stay `inconclusive`,
  unproven cleanup stays `cleanup-failed` + quarantined, interrupted runs
  stay INTERRUPTED: no test asserts a recovery the engine did not
  observe.

## 14. Tests Executed in Phase 3E: Scenario Replay (T-3.5)

### 14.1 Engine unit suite: `packages/engine/test/scenario-replay.test.ts`

**10 tests** (new), on the shared harness (`test/scenario-harness.ts`,
extracted from `scenario-run.test.ts`): REAL stand-in node processes +
scripted FaultAdapter doubles. Covered:

- **Distinct run + provenance + freshness**: replay creates a new run
  id with `replayOfRunId`, the same snapshot (deep-equal), new fault
  ids, real claims/verification, verified cleanup; the source run
  record is byte-identical afterwards; provenance survives store
  reopen; the `scenario-run.created` event carries `replayOfRunId`;
  honesty is the `replayNote` helper, not a `warnings` entry.
- **Snapshot independence**: after the scenario is edited AND deleted,
  replay still executes the recorded snapshot (execute() of the
  deleted scenario throws SCENARIO_NOT_FOUND: contrast).
- **Eligibility**: `rejected` (message: never executed), unfinished
  (`running`), unknown run ids, and malformed snapshots (empty or
  missing steps) all refused without creating any run record.
- **Authorization posture**: missing `mode`/target → INVALID_INPUT
  (no run); unknown target → NETWORK_NOT_FOUND with a persisted
  rejected run carrying provenance; non-designated target (DEC-008)
  → SCENARIO_EXEC_NOT_ALLOWED, also with provenance.
- **Current gates re-evaluated**: an active same-scenario run →
  SCENARIO_RUN_CONFLICT; a cleanup-failed quarantine planted AFTER
  the source run → refused 'quarantined'; a snapshot containing a
  planned operation (`node-restart`) → UNSUPPORTED_OPERATION with
  `validation.valid=true` (authoring warns, run gates refuse).
- **Failure/cancel/timeout semantics reused**: replaying a failed
  source run fails again with the same VERIFICATION_FAILED code but
  fresh evidence; cancelling a replay mid-hold interrupts via
  injector.cancel with verified rollback (same pid, no leak); a 5s
  step deadline vs a 60s condition budget reports STEP_TIMEOUT with
  `faultId: null` and no fault.
- **Duplicates & read-only**: get/list never create runs; two
  synchronous replays → exactly one starts, the second throws
  CONFLICT; after terminal, a new replay is allowed; every attempt
  (including the refused one) is queryable via `list({ replayOf })`.

### 14.2 API suite: `apps/api/test/scenario-runs.test.ts` (now 13)

Four new tests on the real Fastify app + real SQLite (no injector):
202 replay with `replayNote` + source immutable over the wire +
`?replayOf=` history query + read-only requests never executing;
400 (missing mode/target) and 404 (unknown source); 409 ineligible
source (a persisted rejected run) and gate re-evaluation (unknown
target → 404 persisted rejection with provenance, non-designated →
403, both queryable via `?replayOf=&state=rejected`); concurrent
duplicate replays → exactly one 202 and one 409, and a new replay is
allowed once terminal.

### 14.3 LIVE integration: `test/integration/scenario-runs.int.test.ts` (now 9/9)

One new live check on a disposable designated-test `portaldot_dev`
network: a real pause run is executed, then replayed with an explicit
target + marker; the test independently samples RPC during the replay
(the victim stops answering while held), asserts a NEW fault record
and fresh claims, re-verifies recovery itself (same pid, RPC back),
confirms the source run is byte-identical, queries provenance, and
confirms ineligible sources (unknown id, persisted rejected run) and
unknown targets are refused before any side effect. Runs the full
suite: **44/44 across 10 files** (T-3.2/T-3.3/T-3.4 suites intact).

- **CLI smoke**: no new CLI surface in T-3.5 (run/replay commands are
  T-3.6, which will call `engine.scenarioRuns.replay()` exactly like
  the API does); CLI typecheck/build are covered by the shared gates.
- **Hygiene after the live run**: no orphaned `portaldot_dev`
  processes (`pgrep -af portaldot` → none).
- **Not faked anywhere**: mocked/scripted coverage is labeled unit;
  the live replay's effect and recovery are observed by the test
  itself, not read from the run record.

## 15. Tests Executed in Phase 8 (T-8.1): V3 Connectivity Probe

### 15.1 Engine unit suite: `packages/engine/test/v3-probe.test.ts` (21 tests, mocked transports: offline)

All three transports are injected fakes; the suite performs **no network
I/O**. Coverage (one `it` per requirement where applicable):

- configuration: official V3 defaults; env overrides
  (`KAIZEN_V3_*`); explicit > env > default precedence; invalid
  config rejected as `INVALID_INPUT` naming the KEY, never the value;
  `redactEndpointUrl` origin-stripping.
- independent success: all three endpoints `ok` with real observation
  shapes; default endpoints shown origin-redacted in results.
- independence: substrate down + EVM/explorer up; EVM down +
  substrate/explorer up; all three failing differently (unavailable /
  protocol-error / timeout): three results always returned, `healthy`
  false, no short-circuit, nothing suppressed.
- timeout + cleanup: a hung substrate transport yields `timeout` within
  the 500 ms deadline (elapsed bounded, latency ≥ 450 ms) and the
  transport's `AbortSignal` is observed fired (`signal.aborted`,
  abort-counter 1): deterministic cleanup path; transport-thrown
  `RPC_TIMEOUT`/`RPC_ERROR` are classified instantly (not by waiting for
  the deadline).
- malformed responses: HTTP 200 with non-JSON body →
  `malformed-response`; invalid hex `eth_blockNumber`; substrate header
  height/hash garbage and malformed health → `malformed-response` with
  the valid partial observations preserved; valid hex heights accepted.
- protocol errors: JSON-RPC error object with HTTP 200 →
  `protocol-error` (code + sanitized message); wrong `jsonrpc` version;
  response id mismatch; response with neither result nor error; non-2xx
  HTTP status.
- chain id: observed `0x64` (100) vs configured 420420777 → `mismatch`
  (never `ok`), observed id and expected id both reported.
- optional method: `web3_clientVersion` returning `-32601` records a
  warning and `clientVersion: null` while the probe stays `ok`.
- redaction: a credential-bearing config URL and a hostile transport
  message echoing it produce zero occurrences of userinfo/path/query
  material anywhere in the serialized report; endpoints appear origin-only.
- read-only: EVM methods limited to `eth_chainId`/`eth_blockNumber`/
  `web3_clientVersion` with empty params and no header/auth inputs;
  substrate transport input limited to url/timeouts/signal; no
  write/sign/authorization-shaped content anywhere.
- `RealSubstrateTransport` abort path exercised offline against a closed
  local port with a pre-aborted signal → rejects `RPC_TIMEOUT`.
- single-endpoint use: `probeEndpoint('evm-rpc')` honors the same contract.

### 15.2 LIVE integration: `test/integration/v3-probe.int.test.ts` (gated `KAIZEN_TEST_V3=1`)

Independent gate (not `KAIZEN_TEST_LIVE`): **without the gate the suite is
skipped: verified: running it ungated reports `1 skipped`, never passed**.
With the gate, the probe runs against the configured official V3 endpoints
and the test asserts `ok` on every endpoint with real observations, the
chain id exactly 420420777, block number > 0, a hash-shaped best-header
hash, HTTP 2xx + `html` content type + non-empty document title for the
explorer, `healthy: true`, and origin-redacted endpoints in the report.
The full sanitized report is logged as one `[v3-live]` JSON line for
evidence. Actual run (2026-10-19 17:51 UTC): substrate
`PortaldotV3 Test` / peers 2 / not syncing / best #106135 / 3130 ms; EVM
chain id 420420777 / block #106135 / client
`eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0` / 1553 ms;
explorer HTTP 200 `text/html` title "Portaldot Node Console" / 888 ms;
`healthy: true` (R-23/R-24).

- **CLI/UI surfaces**: none in T-8.1 by design (DEC-023): nothing to
  smoke; shared typecheck/build gates cover the engine package.
- **Hygiene after the live run**: the probe opens and closes its own WS/HTTP
  connections; `pgrep -af portaldot` after → none.

### 15.3 Commands and actual results (2026-10-19)

| Command | Result |
|---------|--------|
| `npm run build` | PASS (exit 0; engine/cli/api/web) |
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm test` | First full run: 282/283: one failure in `scenario-run.test.ts` ("stand-in node could not listen on 34741", a transient local port-bind contention in the harness, not V3 code); isolated re-run of that file: 37/37 PASS; second full run: **283/283 (25 files) PASS** |
| `npx vitest run --config vitest.integration.config.mts test/integration/v3-probe.int.test.ts` (no gate) | 1 skipped: the live check does not pass without its gate |
| `KAIZEN_TEST_V3=1 npx vitest run --config vitest.integration.config.mts test/integration/v3-probe.int.test.ts` | **1/1 PASS** (exit 0, 3.1 s probe; observations in §15.2 / R-23 / R-24) |

## 16. Tests Executed in Phase 3F: Failure Lab CLI/API Integration (T-3.6A)

### 16.1 CLI unit suite: `packages/cli/test/scenario-commands.test.ts` (36 tests, mocked engine: offline)

- **Harness**: `buildProgram({ engineFactory })` DI with a scripted fake
  engine; commander `exitOverride()` per command; output captured at all
  three levels (configureOutput, console spies, `process.stdout/stderr`
  write spies: subcommands do not inherit configureOutput after
  buildProgram); `process.exitCode` save/restored per invocation.
- **Coverage**: help surface of every command; `--json` envelopes and
  human mode; `--timeout`/`--limit`/`--offset` parsing (non-numeric,
  out-of-range); scenario create/validate (valid, invalid JSON, missing
  file, duplicate name, status/limit errors); `run execute` missing
  `--network` (commander-required) and ghost network → engine refusal
  surfaced + persisted `rejectedRunId` + human hint; replay-eligibility
  refusal with NO `rejectedRunId` misattribution; `run get` provenance +
  honesty note; `run cancel` unknown id → NOT_FOUND, finished run →
  CONFLICT, wait-timeout honesty (OPERATION_TIMEOUT, "keeps
  executing", exit 1), cancel-timeout honesty (never success), and a
  cancel-success path (exit 0 on observed `cancelled`).

### 16.2 Engine unit additions: `scenario-run.test.ts` (now 41), `store.test.ts` (now 8)

- **Cross-process cancel**: a second `ScenarioEngine` over the SAME
  store (the topology of a separate `kaizen run cancel` process)
  durably records the request; the executing engine observes it at its
  watcher, interrupts through `faults.cancel` (one mechanism, never a
  second executor), and the run terminalizes `cancelled` with audit
  history, verified cleanup, and independent rollback observation.
- **Write-once cancellation guard** (DEC-025): a foreign persisted
  request survives the executor's own stale full-row rewrite
  (`COALESCE`); regression for the live-observed lost update.
- **Ownership/reconcile**: `executor_pid` set once at insert; startup
  reconcile DEFERS while the owner pid is live (no write, honest
  `deferred` entry) and still terminalizes dead-owner/pid-less orphans
  (`INTERRUPTED`).
- **Migration**: `store.test.ts` schemaVersion 17 → 18 (v18 =
  `scenario_runs.executor_pid`): the only pre-existing assertion
  updated; nothing weakened.
- Store-level SQL visibility (WAL, two connections, one file) verified
  separately while diagnosing; the durable-cancel path is covered by the
  tests above.

### 16.3 LIVE integration: `test/integration/cli-scenario.int.test.ts` (gated `KAIZEN_TEST_LIVE=1`; real `portaldot_dev`, disposable designatedTest network)

Five tests, each with INDEPENDENT observations beyond the CLI's own
printed record:
1. **Authoring**: validate (no save), create, get, list, operations.
2. **Execute**: a real pause run through the CLI; node reachable again
   with the SAME pid + moving chain head (own RPC polling).
3. **Replay**: a NEW run via `run replay` with `replayOfRunId`
   provenance + honesty note + a DISTINCT fault record; node healthy.
4. **Cancel (cross-process)**: the execute runs in a REAL CHILD PROCESS
   (built bin, same `KAIZEN_DATA_DIR`); `run cancel` from the test
   process durably records the request; the child's engine interrupts
   the hold; the child honestly reports `{ok:false, state:"cancelled"}`
   exit 1; the run reached `cancelled` (not failed: pending
   cancellation honored); node back with the SAME pid + RPC reachable;
   cancelling the finished run → SCENARIO_RUN_CONFLICT.
   (The bg child also isolates the harness's global spies: in-process
   CLI invocations are strictly sequential by design.)
5. **Gate refusals**: ghost network → refused + persisted rejected run
   inspectable by id; replay-of-rejected refused (no new run); missing
   `--network`; unknown ids → NOT_FOUND with actionable messages.

### 16.4 Commands and actual results (2026-10-21)

| Command | Result |
|---------|--------|
| `npm run typecheck` | PASS (exit 0) |
| `npm run lint` | PASS (exit 0) |
| `npm run build` | PASS (exit 0; rolldown notice only) |
| `npm test` | **323/323 PASS (26 files)**: CLI 36/36; `scenario-run.test.ts` 41/41 |
| `npm run test:integration` (no gate) | 50 skipped (cli-scenario 5 skipped: never passed without its gate) |
| `KAIZEN_TEST_LIVE=1 … cli-scenario.int.test.ts` | **5/5 PASS** (~32 s) |
| `KAIZEN_TEST_LIVE=1 … scenario-runs.int.test.ts` (regression re-run; engine touched) | **9/9 PASS** |
| `KAIZEN_TEST_LIVE=1 … faults.int.test.ts` (regression re-run; pause adapter touched) | **5/5 PASS** |
| Hygiene: `pgrep -af portaldot` after live runs | none |

## 17. Week 2 submission: T-8.2 V3 anchoring + T-3.6B console (2026-10-21)

### 17.1 T-8.2: V3 on-chain run anchoring

- **Engine unit** `packages/engine/test/v3-anchor.test.ts` (fake chain
  transport): canonical run hash determinism; ABI selectors vs solc output;
  persist-before-submit; dry-run refusal → `failed` (never anchored);
  missing RunAnchored/Remarked evidence → `failed`; verify verdicts
  (verified / mismatch / unverifiable); signer scrubbing; no silent
  contract→remark fallback; duplicate-anchor refusal per chain + method
  (retry allowed after a failure); and a recompute
  of every anchored hash from the committed `docs/evidence/runs/*.json`.
- **API** `apps/api/test/v3.test.ts`, **CLI** `packages/cli/test/v3-commands.test.ts`.
- **Live write suite** `test/integration/v3-anchor.int.test.ts`, gated
  `KAIZEN_TEST_V3_WRITE=1` + `KAIZEN_V3_SIGNER_SURI` (spends tPOT; skipped
  otherwise and never reported as passed).
- **Live evidence (PortaldotV3 Test, chain id 420420777, genesis
  0xd4f9…83bd)**: registry deploy block 136822; contract anchors 136899,
  136919; remark anchors 136940, 136947; records in
  `docs/evidence/v3-anchors.json`, the exact run records in
  `docs/evidence/runs/`, node-console screenshot
  `docs/assets/node-console-block-136899.webp`.
- **Re-verification (2026-10-21, this session)**: API started on the
  evidence data dir (`KAIZEN_DATA_DIR=<evidence dir> node apps/api/dist/index.js`):
  `GET /api/v3/probe` → healthy (substrate ok, best #137255; EVM ok,
  chain id 420420777 matches; node console HTTP 200);
  `GET /api/v3/status` → registry `0x08fdadd1ebe16234c03b723255cc12fd98a5ef07`
  (source: deployment), signer balance ≈3.15 tPOT;
  `POST /api/v3/anchors/:id/verify` for all four finalized anchors →
  `verified` (hash match + block-hash match; contract anchors also
  registry code present + `anchoredAt` 2026-10-21T21:18:48Z / 21:20:48Z).

### 17.2 arm64 sandbox: qemu-user workaround (RSK-31)

The development sandbox is linux-arm64; upstream publishes no
linux-arm64 `portaldot_dev`. The T-8.2 live runs (local two-node
`portaldot_dev` network → Failure Lab pause/terminate runs → anchors) were
executed under **qemu-user x86_64 emulation** (the x86_64 binary run
through qemu-user on the arm64 host), with a one-line preload that
reports `process.arch = 'x64'` so the binary manager selects the official
linux-x64 artifact (`node -r ./arch-x64.cjs …`, the file containing
`Object.defineProperty(process, 'arch', { value: 'x64' })`). Emulation is
slower than native but runs the real, hash-verified binary. The
workaround is per-machine, not part of the repo, and was not present in
the later docs/UI session: no new live node runs were made there. On an
x86_64 Linux host none of this is needed.

### 17.3 T-3.6B: imported console (jsdom)

Seven web test files, 55 tests (`apps/web/src/**`):
`Console.test.tsx` (shell routing/steps, landing health, nav gating,
Overview topology/links/start/stop/WS events, node drawer logs/diagnostics/
stop), `FailureLab.test.tsx` (blocked fault types disabled, confirm before
execute, 403 dry-run preflight rendering, active-fault roll back, scenario
draft→input, save+execute after confirm, cancel, replay, registry-blocked
ops), `Screens.test.tsx` (Create preset/custom, Validators Phase 5 labels,
Incidents evidence timeline + Phase 4 label, Deployments local processes +
Phase 6, Settings readiness + confirm-remove), `V3.test.tsx` (probe per
endpoint, committed evidence anchors with node-console links, verify,
remark-default anchor with confirm, contract deposit warning, non-
anchorable run), `lib/model.test.ts` (observed/inferred/down links, no
invented values), plus the existing `client.test.ts` / `events.test.ts`.
The API client double lives in `src/test-utils/mockApi.ts` (tests only).

### 17.4 Commands and actual results (2026-10-21)

The sandbox caps a single command at 120 s, so `npm test` was run as
chunks of the same vitest config; together they cover every file in the
default suite:

| Command | Result |
|---------|--------|
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run build` | PASS (rolldown "use client" notice only) |
| `npx vitest run apps/web` | 55/55 PASS (7 files) |
| `npx vitest run apps/api packages/cli` | 79/79 PASS (5 files) |
| `npx vitest run packages/engine/test/{args,binary,bus,chainspec,manager,ports,topologies,store,service}.test.ts` | 60/60 PASS |
| `npx vitest run packages/engine/test/{fault,monitor,v3-anchor,v3-probe,scenario-store,scenario}.test.ts` | 134/134 PASS |
| `npx vitest run packages/engine/test/scenario-run.test.ts` | 41/41 PASS |
| `npx vitest run packages/engine/test/scenario-replay.test.ts` | 10/10 PASS |
| **Total** | **379/379 PASS (29 files)** |
| Live UI smoke in a real browser | NOT RUN (no browser / no x86_64 userland in this session: RSK-23, RSK-31) |
