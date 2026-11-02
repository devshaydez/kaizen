# Technical Research: Portaldot Capability Matrix

Every entry records: question → source/experiment → evidence → status →
implications → uncertainties → next verification step.

Status labels (used consistently):
- **VERIFIED**: direct evidence or successful reproducible test.
- **PARTIALLY VERIFIED**: some evidence, important detail unresolved.
- **UNVERIFIED**: plausible but not demonstrated.
- **BLOCKED**: cannot proceed, reason documented.

All local experiments were run on 2026-10-09 in the Phase 0 environment
(x86_64 Linux, 2 vCPU, 7.8 GiB RAM) in `/tmp/opencode/portaldot-probe`
(outside the repo; nothing installed machine-wide). Reproduction commands are
included verbatim.

---

## R-01: How is Portaldot installed; what artifacts exist?

- **Question**: What do we download, and what binaries does it contain?
- **Source**: GitHub API listing of `portaldotVolunteer/Portaldot-node`;
  official docs "Chain Info".
- **Evidence**: Prebuilt tarballs exist (no source build needed):
  | Artifact | Size (bytes) |
  |---|---|
  | portaldot-testnet-ubuntu.tar.gz | 29,591,898 |
  | portaldot-testnet-macos.tar.gz | 25,005,253 |
  | portaldot-mainnet-ubuntu.tar.gz | 30,180,666 |
  | portaldot-mainnet-macos.tar.gz | 25,671,186 |
  Testnet Ubuntu tarball extracts to: `portaldot_dev` (node) + `subkey` (key tool).
- **Status**: VERIFIED.
- **Implications**: Kaizen can manage node binaries itself (download + cache).
  No Rust toolchain needed (none is installed in this environment anyway).
- **Uncertainties**: Upstream publishes no checksums/signatures (see RSK-07).
- **Next step**: T-1.3 pins SHA-256 at first download (trust-on-first-use) and
  records it in the local manifest.

Reproduce:
```bash
curl -s https://api.github.com/repos/portaldotVolunteer/Portaldot-node/contents/
```

## R-02: Actual node startup command, flags, configuration surface

- **Question**: What CLI does the real binary expose?
- **Source**: Direct execution of the downloaded binary (`--help`, `--version`).
- **Evidence**: `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu` (clap v2-style CLI).
  Key flags confirmed present: `--dev`, `--chain <spec|dev|local|staging>`,
  `--alice/--bob/--charlie/--dave/--eve/--ferdie/--one/--two` (each = `--name X
  --validator` with that account's session keys inserted into the keystore),
  `--validator`, `--base-path`, `--port` (p2p), `--rpc-port` (HTTP),
  `--ws-port` (WS), `--bootnodes`, `--reserved-nodes`, `--reserved-only`,
  `--node-key`/`--node-key-file`, `--keystore-path`, `--in-peers`/`--out-peers`,
  `--name`, `--no-grandpa`, `--force-authoring`, `--pruning`, `--rpc-methods
  Auto|Safe|Unsafe`, `--rpc-cors`, `--listen-addr`, `--public-addr`,
  `--prometheus-port` (metrics ON by default; `--no-prometheus` disables),
  `--tmp`, `-l/--log` filters, `--password`/`--password-filename`.
  Subcommands: `build-spec`, `purge-chain`, `key {generate, generate-node-key,
  insert, inspect, inspect-node-key}`, `inspect`, `sign`, `verify`, `vanity`,
  `export-blocks`, `import-blocks`, `check-block`, `export-state`, `revert`,
  `benchmark`, `try-runtime`.
- **Status**: VERIFIED (flag surface observed on the real binary).
- **Implications**: Everything Kaizen needs for process orchestration, identity,
  key management, and topology wiring is exposed by the binary itself.
- **Uncertainties**: None on flag existence; semantics of some flags follow
  generic Substrate behavior (acceptable risk: see RSK-08).
- **Next step**: none required.

Reproduce: `./portaldot_dev --help`

## R-03: Starting a local development network (single node)

- **Question**: Does `portaldot_dev --dev --alice` produce a live chain here?
- **Source**: Direct experiment.
- **Evidence**: Node started, logged BABE consensus session, produced and
  imported blocks at ~6 s cadence (Imported #1, #2, ...). Log facts: peer
  identity `12D3KooW...`, Prometheus at `127.0.0.1:9615`, WS listening on the
  given `--ws-port`, default protocol ID `sup`.
- **Status**: VERIFIED.
- **Implications**: Single-node MONITOR loop is immediately implementable.
- **Uncertainties**: None material.
- **Next step**: none required.

Reproduce:
```bash
./portaldot_dev --dev --alice --base-path <dir> --port 30343 \
  --rpc-port 19933 --ws-port 19944 --no-telemetry --name kaizen-probe-1
```

## R-04: Multi-node local network (peer discovery + sync)

- **Question**: Can several local nodes be configured to discover and connect?
- **Source**: Direct 2-node experiment with exported local chain spec.
- **Evidence**: `build-spec --chain local --raw --disable-default-bootnode`
  produced a 1,488,964-byte raw spec ("Local Testnet", id `local_testnet`,
  chainType `Local`; genesis runtime includes `babe`, `grandpa`, `staking`,
  `session`, `sudo`, `imOnline`, `balances`, `indices`, `treasury`,
  `authorityDiscovery`, `vesting`, `gilt`, `transactionStorage`). Node A
  (`--alice`) and node B (`--bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<A>`)
  connected within seconds: each reported `peers: 1` with `roles: "AUTHORITY"`,
  imported identical blocks (same best hash at #7), and finality progressed
  (`finalized #5` on both).
  **Re-verified through the Kaizen engine (Phase 1, T-1.6)**:
  `NetworkService.create('two-node')` builds the spec, pre-generates node
  keys (`key generate-node-key --file`), wires the bootnode from the real
  peer id, and starts both nodes; the live test converges on `peers ≥ 1` on
  both nodes, bidirectional peer-id cross-check, identical best hash, and
  equal progressing finalized heights: all read via `@polkadot/api` over WS
  (`test/integration/network.int.test.ts`).
- **Status**: VERIFIED (2-node, explicit bootnode wiring, same host).
- **Implications**: Two-, four-validator and validator+fullnode presets are
  buildable with the same mechanism. Peer state is observable via
  `system_peers` (peerId, bestHash, bestNumber, roles).
- **Uncertainties**: 4-node behavior and genesis authority set size were not
  inspected; custom chain-spec editing is untested.
- **Next step**: T-2.2/T-2.3 verify 4-validator topology and read genesis
  authorities from the spec.

Reproduce: script archived at Phase 0 (`multinode-test.sh`), summarized:
```bash
./portaldot_dev build-spec --chain local --raw --disable-default-bootnode > local-raw.json
./portaldot_dev --chain local-raw.json --alice  --base-path A --port 30353 \
  --rpc-port 19953 --ws-port 19964 --prometheus-port 9715 --name kaizen-A
./portaldot_dev --chain local-raw.json --bob --bootnodes /ip4/127.0.0.1/tcp/30353/p2p/<A_peer> \
  --base-path B --port 30354 --rpc-port 19954 --ws-port 19965 --prometheus-port 9716 --name kaizen-B
```

## R-05: Topology presets beyond two nodes

- **Question**: Do four-validator and validator+fullnode topologies work?
- **Source**: Inference from R-04 + `--help` (`--charlie`…`--ferdie` shortcuts)
  and the exported spec (Local Testnet authorities).
- **Evidence**:
  - **Phase 0/1**: mechanism proven for 2 nodes; well-known keys for up to 6
    named validators exist.
  - **Phase 2A (2026-10-10, live spike)**: the Local Testnet plain spec seeds
    exactly **TWO** genesis authorities: Alice `5GrwvaEF…` and Bob
    `5FHneW46x…`: with `staking.validatorCount=2`,
    `minimumValidatorCount=2`, matching `session.keys`, `staking.stakers`
    (3e18 bond each) and `staking.invulnerables`. Charlie/Dave/Eve are NOT
    genesis authorities but ARE funded in genesis balances (5 UNITS each).
  - Session key derivation confirmed against the binary: babe/imOnline/
    authorityDiscovery = sr25519(//X) = the dev account; **grandpa =
    ed25519(//X)** (`key inspect --scheme ed25519 //Alice` reproduced Alice's
    genesis grandpa key `5FA9nQ…`, and Bob's likewise).
  - **Genesis surgery works**: patching the plain spec (add Charlie/Dave to
    `session.keys`/`staking.stakers`/`staking.invulnerables`, set
    `validatorCount=4`) and rebuilding with `build-spec --chain <file> --raw
    --disable-default-bootnode` produced a 4-authority network that ran live:
    4 processes, **full mesh (peers=3 on every node)**, identical genesis hash
    on all four, **all four authorities authored blocks** (log counts
    alice=36, bob=58, charlie=50, dave=42 after ~8 min), and GRANDPA finality
    advancing (finalized 12 vs best 14 at sample time).
  - **Full node works**: a 5th keyless node (no `--validator`, no well-known
    key) bootnode-connected to the mesh reached peers=4, synced to the exact
    network best (95=95), `isSyncing=false`, and authored **0** blocks.
- **Status**: VERIFIED.
- **Implications**: Presets ARE data-driven from the topology plan; any
  network whose validator keys exceed {alice, bob} gets a patched per-network
  spec (DEC-011). Four running processes alone never count as four
  authorities: validation and labeling must reflect that.
- **Uncertainties**: finality quorum with a *partially* offline authority set
  (e.g. 3-of-4 online): relevant to Phase 3/4 failure work, not tested here.
- **Next step**: none for Phase 2A (topologies live-verified end-to-end).

## R-06: Ports, RPC endpoints, WebSocket endpoints

- **Question**: Which endpoints exist and how are they addressed?
- **Source**: `--help`, node logs, live RPC calls.
- **Evidence**: Separate `--rpc-port` (HTTP) and `--ws-port` (WS) flags work
  (older-generation Substrate; NOT the merged-port newer style). This node
  generation defaults: HTTP 9933, WS 9944. Log line "Listening for new
  connections on 127.0.0.1:<ws-port>" observed. HTTP JSON-RPC verified live
  (see R-07). Prometheus at 9615 default (`--prometheus-port` overrides).
  **WS proven with a real client (Phase 1, T-1.5)**: `@polkadot/api` 17.0.2
  `WsProvider` connects to `ws://127.0.0.1:<ws-port>` on the real binary;
  typed snapshot reads (`system_*`, `chain_getHeader`, `state_getRuntimeVersion`),
  `chain_subscribeNewHeads` delivering advancing blocks, raw
  `provider.send('system_localPeerId')`, and auto-reconnect after the node is
  stopped and restarted all verified in `test/integration/rpc.int.test.ts`.
- **Status**: VERIFIED (HTTP + WS both exercised by live tests).
- **Implications**: Kaizen must allocate 3+ ports per node (p2p, HTTP, WS) plus
  Prometheus: port management is a core engine responsibility.
- **Uncertainties**: None material for the local-node use case.
- **Next step**: none required (Phase 2 may add WS subscriptions for the
  monitoring sampler).

## R-07: Which RPC methods are available; what do responses contain?

- **Question**: Can Kaizen read real operational data over RPC?
- **Source**: Live JSON-RPC calls against the running dev node (HTTP).
- **Evidence** (verbatim responses):
  - `system_health` → `{"isSyncing":false,"peers":0,"shouldHavePeers":false}`
  - `system_chain` → `"Development"`; `system_name` → `"Portaldot Node"`;
    `system_version` → `"2.0.0-unknown-x86_64-linux-gnu"`
  - `system_peers` → `[{"bestHash":"0x27a7…","bestNumber":6,"peerId":"12D3KooW…","roles":"AUTHORITY"}]`
  - `system_localPeerId` → `"12D3KooWP4P5VzoAZgyuMEpDetnoWp2nm9cF53uR6goyUDjrR7zm"`
  - `system_syncState` → `{"currentBlock":4,"startingBlock":0}`
  - `chain_getHeader` → full header incl. BABE digest logs
  - `state_getRuntimeVersion` → specName `portaldot`, specVersion `1002`,
    implName `substrate-node`, 13 runtime APIs listed
  Docs also list (not all exercised): `system_addLogFilter`, `system_addReservedPeer`,
  `system_removeReservedPeer`, `system_reservedPeers`, `system_networkState`,
  `system_nodeRoles`, `system_properties`, `system_chainType`, `system_version`,
  plus `chain`, `state`, `payment`, `grandpa`, `syncstate`, `author`, `babe`
  RPC groups. Note: unsafe-flagged methods (e.g. `system_peers`,
  `add/removeReservedPeer`) are enabled locally because `--rpc-methods Auto`
  → Unsafe on loopback.
- **Status**: VERIFIED (exercised subset) / the documented-but-unexercised
  remainder is PARTIALLY VERIFIED at the set level.
- **Implications**: All MONITOR signals required by the spec exist. The
  reserved-peer RPCs are the intended mechanism for peer disconnect experiments
  (Failure Lab) without killing the process.
- **Uncertainties**: Exact `system_peers` fields under load; behavior of
  `system_addReservedPeer` on this build (needs `--reserved-only` contexts).
- **Next step**: T-3.1 exercises reserved-peer manipulation for disconnects.

## R-08: Node identity, health, sync, peer inspection

- **Question**: Can each be inspected reliably?
- **Source**: Live RPC + logs (R-07, R-04).
- **Evidence**: identity via `system_localPeerId` + log line; health via
  `system_health`; sync via `system_syncState` + header numbers; peers via
  `system_peers` with roles; block height/finalized via `chain_getHeader`
  and Prometheus (`substrate_block_height{status="best"|"finalized"}`).
- **Status**: VERIFIED.
- **Implications**: Incident detection (R-15) has all raw signals available.
- **Next step**: none required.

## R-09: Health checks, metrics, graceful shutdown

- **Question**: Does the binary support reliable ops hooks?
- **Source**: `--help`, node logs, kill experiment.
- **Evidence**: Prometheus ON by default (`--no-prometheus` to disable);
  live scrape returned `substrate_block_height{status="best"} 4`,
  `substrate_block_height{status="finalized"} 2`. `SIGTERM` (plain `kill`)
  terminated both test nodes; `pgrep` confirmed exit; no orphan processes.
- **Status**: PARTIALLY VERIFIED (metrics + exit verified; "graceful" = clean
  DB flush after SIGTERM not proven: no corruption observed in restarts).
- **Implications**: Prometheus is a good secondary signal source; process
  manager should use SIGTERM → wait → SIGKILL escalation.
- **Uncertainties**: Behavior under SIGKILL (crash recovery on restart).
- **Next step**: T-1.4 tests SIGKILL + restart to confirm DB recovery.

## R-10: Chain spec creation (`build-spec`)

- **Question**: Can Kaizen generate/modify chain specs for topologies?
- **Source**: Direct execution.
- **Evidence**:
  - `build-spec --chain local --raw --disable-default-bootnode`
    → valid 1.49 MB raw JSON; non-raw mode shows `name: Local Testnet`,
    `id: local_testnet`, `chainType: Local`, one default bootnode
    (`/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWGjDD5sBKxrScFWdGK8Kv72CH1XbxKD6okKVN5y2yZQHo`).
  - **Phase 2A (2026-10-10)**: plain-spec JSON surgery (extended
    `session.keys` with 4 authorities, `staking.stakers`,
    `staking.invulnerables`, `validatorCount`) was accepted by
    `build-spec --chain <patched-plain-file> --raw
    --disable-default-bootnode` (output 1,495,379 bytes) and the resulting
    raw spec ran a functioning 4-authority network (see R-05).
- **Status**: VERIFIED (generation + plain-spec surgery + raw rebuild; the
  raw-rebuild step regenerates genesis storage from the runtime genesis
  config: no direct raw-storage editing is needed or attempted).
- **Implications**: ChainSpecService = plain spec → typed patch → raw spec,
  per network, with an audit sidecar (DEC-011).
- **Uncertainties**: editing RAW genesis storage directly (hand-written
  storage keys) remains untested: deliberately out of scope.
- **Next step**: none for Phase 2A.

## R-11: Validator operation requirements (keys, funding, privileges)

- **Question**: What does it take to run validator nodes?
- **Source**: `--help` semantics; docs (staking/session extrinsics); R-04 result.
- **Evidence**: `--alice`…`--ferdie`/`--one`/`--two` = `--name X --validator`
  **plus session keys inserted into the keystore**: i.e. on the Local Testnet
  spec, named well-known accounts act as genesis authorities; our 2-node
  Alice+Bob network produced blocks and finalized, proving validator operation
  works without manual staking on that spec. `key insert` exists for injecting
  custom session keys. Staking pallet (`bond`, `validate`, `nominate`, …) and
  Session pallet (`setKeys`, `purgeKeys`) are documented by Portaldot and the
  `staking`/`session` pallets appear in the Local Testnet genesis.
- **Status**: PARTIALLY VERIFIED (genesis-authority validator operation proven;
  joining as a *new* validator via staking+session-key flow untested).
- **Implications**: Validator UI should present real keystore/session state;
  staking-driven validator onboarding is a Phase 5 task with explicit guards.
- **Uncertainties**: Era/session lengths on the Local spec; whether a fresh
  account can become active within a demo timeframe; reward destination effects.
- **Next step**: T-5.1/T-5.2 read `Session`/`staking` storage on a live local
  network and record era/session timing.

## R-12: Staking extrinsics (Portaldot-specific)

- **Question**: Which staking operations does the runtime expose?
- **Source**: Official docs `module-interface/extrinsics/staking.html`.
- **Evidence**: Full modern-NPoS surface documented: `bond`, `bondExtra`,
  `unbond`, `rebond`, `withdrawUnbonded`, `chill`, `chillOther`, `nominate`,
  `validate`, `setPayee`, `updatePayee`, `payoutStakers(ByPage)`, `kick`,
  `reapStash`, `restoreLedger`, plus root/admin calls (`setValidatorCount`,
  `setInvulnerables`, `setStakingConfigs`, `forceNewEra*`, `manualSlash`…).
- **Status**: PARTIALLY VERIFIED (documented by Portaldot; not exercised
  on-chain in Phase 0).
- **Implications**: Only the signed, user-space subset (bond/validate/nominate/
  chill/setPayee/unbond/withdraw) belongs in Kaizen's validator UI; root calls
  stay out of scope.
- **Next step**: T-5.3 exercises one `bond`+`validate` on a throwaway local
  network and records the events.

## R-13: Session-key operations

- **Question**: Can Kaizen support session-key ops?
- **Source**: Official docs `extrinsics/session.html`; `key` subcommand help.
- **Evidence**: `session.setKeys(keys, proof)` and `session.purgeKeys()` are
  documented; `portaldot_dev key insert` (keystore injection) exists;
  `key generate-node-key` / `inspect-node-key` exist for libp2p identity.
- **Status**: PARTIALLY VERIFIED.
- **Implications**: A safe, real flow: generate/inspect keys offline → insert
  to keystore → `setKeys` on-chain → verify via Session storage. Requires a
  signing capability (see R-16).
- **Uncertainties**: Exact `SessionKeys` type shape for this runtime (needs
  metadata decode); proof generation mechanics.
- **Next step**: T-5.4 decodes `Session.Keys` from live metadata before any
  implementation.

## R-14: imOnline events (validator liveness signals)

- **Question**: Can validator health be observed via runtime events?
- **Source**: Official docs `events/imOnline.html`; local spec genesis keys.
- **Evidence**: Events documented: `AllGood()`, `HeartbeatReceived(AuthorityId)`,
  `SomeOffline(Vec<AccountId32>)`. `imOnline` pallet present in Local Testnet
  genesis (R-04 spec dump).
- **Status**: PARTIALLY VERIFIED (documented + pallet present; events not yet
  observed live).
- **Implications**: `SomeOffline` is a first-class incident signal for the
  Failure Lab; subscribing to events over WS is required.
- **Next step**: T-4.1 subscribes to events while killing a validator and
  records whether `SomeOffline` fires within a session boundary.

## R-15: Runtime identity and metadata

- **Question**: What runtime/SDK compatibility constraints exist?
- **Source**: Live `state_getRuntimeVersion` and `state_getMetadata`.
- **Evidence**: specName `portaldot`, specVersion `1002` (matches PDK's
  "portaldot-1002"), implName `substrate-node`, transactionVersion 2,
  13 runtime APIs. Metadata magic `meta`, **version 13 (V13)**.
- **Status**: VERIFIED.
- **Implications**: V13 metadata + legacy `LookupSource` types (per PDK) mean
  SDK choice matters: `@polkadot/api` is known-good on V13; Python
  `substrate-interface` has a documented signing bug on this chain (R-16).
- **Next step**: none required.

## R-16: SDK/CLI ecosystem quirks (prior art from `portaldot-dev-kit`)

- **Question**: What traps did the hackathon-winning toolkit hit?
- **Source**: `github.com/PugarHuda/portaldot-dev-kit` README (1st place,
  Mini Hackathon S1: a *different* project; we only learn from its findings).
- **Evidence**: (a) Python `substrate-interface` mis-signs Assets-pallet calls
  on V13 metadata because `T::Balance` resolves to the global u128 instead of
  the pallet-scoped u64: TS signing works; (b) Contracts pallet is a legacy
  pre-2021 rent-model build incompatible with modern ink!/cargo-contract;
  (c) dev-chain DB can wedge with "BABE: Unexpected epoch change"; fix =
  `purge-chain --dev -y`; (d) node runs fine with `--ws-external --rpc-cors all`;
  explorer at portalscan.portaldot.io.
- **Status**: PARTIALLY VERIFIED (documented by a third party with working
  tooling; our own probes are consistent: V13, spec 1002, `purge-chain` exists).
- **Implications**: Confirms TS-stack choice (DEC-001); gives us a known
  failure mode (DB wedge) to detect and a known remedy to encode; keeps ink!
  out of scope.
- **Next step**: T-1.4 adds DB-wedge detection (stalled height + BABE log
  pattern) to the process manager.

## R-17: Containerizing the node

- **Question**: Can the actual binary run in Docker?
- **Source**: `file`/`ldd` on the binary; `docker ps` (daemon check).
- **Evidence**: ELF 64-bit x86-64, dynamically linked against glibc
  (`/lib64/ld-linux-x86-64.so.2`), links only `libstdc++`, `libz`, `libgcc_s`,
  `libpthread`, `libm`, `libdl`, `libc`. Docker daemon is running (empty
  `docker ps` succeeded).
- **Status**: PARTIALLY VERIFIED (strong feasibility; no image built yet).
- **Implications**: A `debian:bookworm-slim` or `ubuntu` base + the binary is
  expected to work; needs an actual build/run smoke test.
- **Next step**: T-6.1 builds the image and runs a `--dev` container with RPC
  smoke test.

## R-18: Kubernetes + Helm feasibility

- **Question**: Can a multi-node Portaldot network be deployed to K8s/Helm?
- **Source**: `kubectl cluster-info`, `helm list`, `which kind k3d minikube`.
- **Evidence**: Clients installed: kubectl v1.37.0, Helm **v4.3.0**.
  **No cluster is currently reachable** (kubectl → connection refused on
  localhost:8080). `minikube` IS installed (`/usr/local/bin/minikube`);
  Docker daemon available (minikube docker driver path exists).
- **Status**: UNVERIFIED: not blocked: all tooling present, cluster startup
  is a routine step (`minikube start`), but starting persistent infra in
  Phase 0 was out of scope by instruction.
- **Implications**: P2 path is viable on this machine. Resource risk: 2 vCPU /
  7.8 GiB shared with dev workloads (RSK-11). Helm v4 vs v3 chart syntax is
  a compatibility item to check.
- **Next step**: T-6.3 starts minikube, `helm lint`/`helm install` the chart,
  deploys 2–4 nodes, verifies peering inside the cluster.

## R-19: Mainnet connectivity

- **Question**: Is `wss://mainnet.portaldot.io` usable?
- **Source**: docs Chain Info only.
- **Evidence**: Documented endpoint (ss58 format 42, token POT, 14 decimals).
  Not probed in Phase 0.
- **Status**: UNVERIFIED (deliberately out of Phase 0 scope).
- **Implications**: Kaizen ships with a hard gate: destructive/failure
  operations are refused unless the target network is explicitly designated
  as a test network (FR-5). Mainnet read-only support is a possible later task.
- **Next step**: none scheduled; requires explicit product decision.

## R-20: macOS/Windows coverage

- **Question**: What platforms can run the node?
- **Source**: docs Chain Info + GitHub API listing.
- **Evidence**: macOS tarballs exist; Windows: "recommended to run in WSL"
  (no native binary).
- **Status**: VERIFIED (artifact availability).
- **Implications**: Kaizen targets Linux/macOS hosts for local operations;
  documented WSL caveat for Windows.

## R-21: HTTP JSON-RPC for monitoring (batch/parallel reads, degraded methods)

- **Question**: Can the monitoring loop sample all needed fields over plain
  HTTP JSON-RPC (no WS subscriptions), and how do partial failures behave?
- **Source**: Phase 2A live spike + integration tests against real nodes.
- **Evidence**:
  - `system_peers`, `system_health`, `system_syncState`, `chain_getHeader`,
    `chain_getFinalizedHead`, `chain_getBlockHash` all answer over HTTP POST
    on this build (verified during the 4-validator spike: peers=3/4 read from
    `system_peers` on every node; `system_health` returned
    `{"isSyncing":false,"peers":4,"shouldHavePeers":true}` on the full node).
  - Hex quantity fields (`number`, `bestNumber`, `currentBlock`, …) decode
    with `parseInt(x, 16)`; `system_peers` items carry
    `{peerId, bestHash, bestNumber, roles}`.
  - Disabled/absent methods return a JSON-RPC error object
    (`Method not found`) that is individually tolerated per call: the sample
    degrades that field to null with a warning instead of failing the whole
    node read. Transport-level failure (connection refused) marks the sample
    `reachable:false`.
  - Digest logs from HTTP `chain_getHeader` come back as SCALE-encoded hex
    (no metadata decoration): BABE authorship is therefore read from node
    logs ("Prepared block for proposing"), not header digests, in tests.
- **Status**: VERIFIED (method set + degraded behavior exercised live).
- **Implications**: The monitoring sampler needs no WS per sample; a parallel
  fan-out of single-method POSTs with per-method tolerance satisfies DEC-012
  and keeps the sample honest when a node disables a method.
- **Uncertainties**: behavior under heavy load (many samples/sec) not
  characterized; `system_peers` on very large peer counts untested (local
  networks are ≤8 nodes).
- **Next step**: none for Phase 2A.

---

## R-22: Fault mechanism feasibility (T-3.1 capability matrix)

- **Question**: On a single host, which failure mechanisms can Kaizen induce
  safely and *prove*: pause/resume, peer disconnect, network partition,
  termination/restart: with what privileges, scope, recovery, and cleanup?
- **Source**: Phase 3A experiments, 2026-10-12, each against a freshly
  created disposable Kaizen-managed network only (`designatedTest === true`
  verified in the harness before every fault: DEC-008 intact). Harness:
  `test/experiments/t31-spike.mjs` (standalone ESM; imports only built engine
  helpers; argv-only spawns; SIGSTOP-PID registry + firewall/netns/cgroup
  rollback registered on every exit path; emergency cleanup on
  SIGINT/SIGTERM). Raw evidence logs: `/tmp/opencode/t31-*.log`.
- **Environment**: `portaldot_dev 2.0.0-unknown-x86_64-linux-gnu` (sha256
  `9df4d6332e84…`, TOFU); Linux x86_64 6.x, 2 vCPU / 7.8 GiB; passwordless
  sudo; iptables/ip6tables on the nf_tables backend; Docker present
  (chains owned by dockerd); no Kubernetes.

### Capability matrix

| # | Mechanism | Approach | Privileges | Scope | Induced successfully | Evidence (log) | Recovery | Cleanup | Limitations | Status |
|---|-----------|----------|-----------|-------|----------------------|----------------|----------|---------|-------------|--------|
| A | Node pause / resume | `SIGSTOP` → `SIGCONT` on the engine-managed node PID | none (same-user signal) | one process; topology untouched | YES: pause: PID alive, RPC answers time out, health `unknown` (2 fails) → `unavailable` ("RPC unreachable for N consecutive checks"); bob kept producing at reduced rate (head 1→3 / 36 s) with finality stalled (2/2 GRANDPA); libp2p connection survived (bob peers 1/1) | `t31-a-full.log` | `SIGCONT`: RPC back <3 s, alice synced 0→4 in 3 s, finality 0→5 in ~20 s, both healthy: no restart needed | no residue | paused process still gets kernel TCP handling, so peers hold it as a live peer ≥45 s; health reaches `unavailable`, never `unhealthy` (distinct signature from D) | VERIFIED |
| B1 | Peer disconnect via reserved-peer RPC on a normal connection | localhost `system_addReservedPeer` / `system_removeReservedPeer` (`--rpc-methods Auto`) | none (localhost unsafe RPC) | reserved set only | **NO** (negative result, proven): set membership changes apply, the live connection never drops: 60 s / 20 samples, both sides, both runs | `t31-b.log`, `t31-b2.log` | n/a | n/a | bare peer-id argument fails (`2002 MultiaddrParse(InvalidMultiaddr)`; full multiaddr required); this RPC cannot sever a discovery-maintained connection on this build | PARTIALLY VERIFIED (behavior proven; disconnect not induced) |
| B2 | Peer disconnect on a reservation-bound connection | victim spawned `--reserved-only --reserved-nodes <multiaddr>`; then `system_removeReservedPeer(<peerId>)` on the victim | none beyond spawn config | exactly that link | YES: `system_reservedPeers` `[alice]` → `[]`; victim peers 1→0 at t=0 s; alice stops seeing it by t=3 s; sustained 60 s (victim now rejects the peer: no longer reserved) | `t31-b3.log` | re-add reserved peer or restart | normal | reserved-set filter is by **peer ID, not address**: a reserved peer can reconnect from any reachable address; requires `--reserved-only` at spawn | VERIFIED (conditional on reserved-only config) |
| C1 | Partition via per-node TCP proxy cut (unprivileged) | socat relay as the victim's only bootnode; kill the socat process group | none | the proxied link | PARTIAL: link severed instantly (0.014 s with `--no-mdns`; `ss` proves the proxied leg existed and died), but full mesh reconverges: ~1 s when mDNS is on, ~15 s via identify-learned direct addresses with `--no-mdns` | `t31-c2.log`, `t31-c3.log`, `t31-c5.log` | restore proxy → reconnect observed | no residue | **not a sustained partition**: peers learn real addresses and redial around the cut; mDNS (default ON for non-dev chains) bypasses bootnode wiring entirely | PARTIALLY VERIFIED (cut proven, sustainability refuted) |
| C2 | Partition via controlled peer configuration (unprivileged) | victim `--no-mdns --reserved-only --reserved-nodes <proxy-multiaddr>`; cut the proxy | none | victim vs. whole mesh | YES: victim peers → 0 at t=0.006 s and stayed 0 for the full 90 s; unaffected nodes kept their mesh (alice=2, bob+keep; keep=2) | `t31-c4.log` | proxy restored → reconnect within 120 s | no residue | victim must be spawned reserved-only (topology wiring); observed window 90 s (longer windows untested) | VERIFIED |
| C3 | Partition via static port-scoped iptables (privileged, authorized) | v4-only `--dport/--sport` rules on the victim's ports (loopback-scoped + per-socket ephemeral ports) | sudo (authorized) | one node's ports | PARTIAL: alice dropped bob at 50 s, bob's view hit 0 at 55 s, **reconverged by 85 s**: escape via fresh ephemeral source ports and IPv6 (`[::1]`): and `-i lo` missed eth0 (`10.0.4.11`) legs | `t31-f2.log`, `t31-f4.log` | rules removed → reconvergence | rules removed, table verified | static port rules cannot predict ephemeral redials; `iptables` is IPv4-only; interface scoping leaks non-loopback routes | PARTIALLY VERIFIED (isolation window proven; sustainability refuted) |
| C4 | Partition via ip{,6}tables + cgroup process scoping (privileged, authorized) | both families, no interface scoping: `INPUT --dport <p2p>`, `OUTPUT --sport <p2p>`, per-established-socket port seals (from live `ss`), plus `OUTPUT -m conntrack --ctstate NEW -m cgroup --path /t31-*` with the victim moved into that cgroup | sudo (authorized) | exactly one process (any port, any family) | YES: alice dropped bob at 50 s; sustained t=55→145 s: alice={keep}, keep={alice}, **victim peers=0, victim RPC still up**; zero rule-deletion failures | `t31-f6.log` | rules removed → reconverged ≤10 s | firewall (v4+v6) back to byte-identical baseline; cgroup removed (`leftovers: []`) | `--ctdir ORIGINAL` is inert on this backend (do not use); `--pid-owner` unsupported; cgroup path must exist at rule-insert (EINVAL otherwise); moving a LIVE process back to the root cgroup fails EBUSY (kill first) | VERIFIED |
| C5 | Partition via network namespace + veth (privileged, authorized) | throwaway `ip netns` + veth pair (`10.77.53.1/24` ↔ `10.77.53.2`); victim spawned inside; cut = host-side `ip link set … down` | sudo (authorized) | one link / one node (dedicated IP) | YES: alice lost the ns-node at 55 s; **ns peers=0 with ns RPC still up and ns head frozen at 1 while alice's head advanced to 16**; `ss` showed zero host legs to the ns node; alice↔bob intact throughout (bob=1) | `t31-g.log` | link up → reconnected ≤5 s (ns peers=2) | netns list empty, veth gone (verified) | node runs as root inside the ns (root-owned data needs `sudo rm`); peer-drop latency followed the ~50 s ping timeout, not instant carrier-down | VERIFIED |
| D | Terminate + restart via the engine | `engine.networks.stopNode` (SIGTERM→SIGKILL) → `startNode` | none (engine path) | one node | YES: `alive=false`, RPC down, health **`unhealthy` "process is not running (status: stopped)"** (distinct from pause's `unavailable`); peers 0/1 stayed healthy inside the startup grace | `t31-d.log` | `startNode` → new PID (21174 vs 20731), peers reconnected <1 s, chain 0→3 → finality #1; final heads 10→12, both healthy | engine-managed, no residue | none observed; identity/genesis preserved across restart | VERIFIED |

### Environment facts any injector must respect (discovered live)

- **mDNS is default-ON** for non-dev chains (`--no-mdns` disables;
  auto-implied by `--dev`). Without it, bootnode/proxy wiring is bypassed
  and proxy cuts are invisible (C1).
- **`--reserved-only` disables automatic discovery**; the reserved filter is
  by **peer ID**, so a reserved peer can be reached from any address: which
  is why C2 still depended on the victim being unable to dial anything else.
- **Outbound p2p dials use ephemeral local ports**, not the listen port :
  static port rules cannot predict redials (C3).
- **Dual-stack and multi-homed**: p2p ran over `127.0.0.1`, `[::1]`, and
  `10.0.4.11` (eth0) in the same run. `iptables` is IPv4-only; `-i lo`
  misses eth0. Any kernel-level cut needs **both families and no interface
  scoping** (C3→C4 lesson).
- **nft-backend quirks**: `--pid-owner` unsupported; `--ctdir ORIGINAL`
  silently matches nothing (micro-test: counter 0, bytes kept flowing);
  `--ctstate NEW` + `-m cgroup --path` **works** (path must exist at insert
  else EINVAL); deletion requires the exact `-D <chain> <rule-spec>` form
  (wrong form fails silently and leaks rules: hit and fixed in T-3.1).
- **sudo**: passwordless here; `unshare --net` works; `ip netns` + veth
  work; a live process cannot be moved back to the root cgroup (EBUSY :
  kill it first, then `rmdir`).
- **RPC**: `system_localPeerId` (not `system_peerId`);
  `system_addReservedPeer`/`system_removeReservedPeer`/`system_reservedPeers`
  present; listen addresses are advertised in both `/tcp/<port>/p2p/…` and
  `/tcp/<port>/ws/p2p/…` forms (both dialable).
- **Health signatures** (for the monitor, DEC-012): pause →
  `unknown` → `unavailable`; process stop → `unhealthy`
  ("process is not running (status: stopped)"); these are distinguishable
  and must not be conflated in the Failure Lab UI.

Reproduce (needs the built engine + cached binary):
```bash
KAIZEN_TEST_BIN_DIR=/tmp/opencode/bin TMPDIR=/tmp/opencode \
  node test/experiments/t31-spike.mjs <a-pause|b-peer|b-peer-reserved|
  c-partition|c-partition-reserved|c-partition-mdns|c-iptables|
  c-iptables-cgroup|c-netns|d-terminate|rpc-probe>
```
Privileged variants (`c-iptables*`, `c-netns`) require prior operator
authorization (DEC-018) and verify firewall/netns state before and after.

- **Status**: PARTIALLY VERIFIED overall: A, B2, C2, C4, C5, D VERIFIED;
  B1, C1, C3 PARTIALLY VERIFIED (negative results proven by observation).
- **Implications for T-3.2 (FailureInjector)**: unprivileged defaults are
  SIGSTOP/SIGCONT (pause), engine stop/start (terminate), and
  reserved-only + proxy rewiring (topology faults); kernel-level isolation
  (C4/C5) is the fallback for arbitrary-node cuts and must follow the
  proven discipline: capture firewall baseline → narrow rules scoped to one
  process/link → verify isolation with peer+`ss` evidence → exact rollback
  → verify restored baseline. Never touch FORWARD/DOCKER chains; never
  host-global firewall changes; every fault pre-checks `designatedTest`.
- **Uncertainties**: windows >90 s (long-horizon reconvergence) untested;
  partial-authority finality under isolation not measured here (RSK-12
  remains open: A only shows finality stalling with 2/2 authorities
  pause-split); cgroup/iptables semantics on non-nft backends or other
  kernels untested; monitor-health transitions during partition observed
  only through direct RPC reads, not asserted beyond them.
- **Next verification step**: T-3.2 implementation re-verifies each chosen
  mechanism inside the injector's own lifecycle (with unit tests for the
  DEC-008 gate and integration evidence for at least one fault + recovery).

### T-3.2 implementation status (2026-10-12, FailureInjector)

Implemented in `packages/engine/src/fault/` and re-verified through the
injector's own lifecycle against a real `portaldot_dev` two-node network
(`test/integration/faults.int.test.ts`, live run 2026-10-12: dry-run first,
then execution with the TEST's own RPC polling as the independent
observation):

| # | Mechanism | Injector status | Live evidence (T-3.2) |
|---|-----------|-----------------|------------------------|
| A | pause (SIGSTOP/SIGCONT) | **IMPLEMENTED: VERIFIED**: baseline+effect+recovery all independently observed; same pid before/after; chain resumes; distinct claims (applied/observed/removed/recovered) | pause run: victim RPC unreachable for ≥5 s observed by the test's own 500 ms polling, reachable again, pid unchanged, `chain_getHeader` advanced past the pre-fault head; `result.outcome=verified` |
| D | terminate (engine stop/start) | **IMPLEMENTED: VERIFIED**: exit proven (old pid dead + RPC down), restore proven with a NEW pid, peers reconverged on both nodes, chain resumed | terminate run: old pid dead, new pid serving RPC, `system_health.peers>=1` on both nodes, head advanced |
| B2 | peer-disconnect (reserved-peer RPC) | **BLOCKED (registered adapter, typed unsupported result)**: no engine topology produces `--reserved-only` nodes and spawn mode is not persisted on NodeConfig, so the reservation-bound precondition cannot be verified for any managed target; unblock path names the required topology wiring + `t31-b3.log` | live REST `POST …/execute` → HTTP 409 `FAULT_NOT_SUPPORTED`; victim unaffected |
| C2/C4/C5 | partition | **BLOCKED (registered adapter, typed unsupported result)**: unprivileged route needs the same reserved-only wiring; privileged route needs DEC-018 operator authorization + a privileged execution path that T-2/T-3.2 deliberately does not implement | live REST execute → 409 `FAULT_NOT_SUPPORTED`; no firewall/netns state touched |

Injector-level facts worth keeping: `system_health` answers within the
adapter's 3 s bound on this build when resumed (R-22 A's <3 s recovery
holds through the injector); pause health reads `unavailable` (never
`unhealthy`) so it stays distinguishable from terminate; a dry-run record
rests at `ready` and is NOT a terminal lifecycle state (previews are never
executed); adapter-internal polling bounds need a wrap backstop ABOVE them
(+3 s) or the two timers race.

---

## R-23: Portaldot V3 public endpoints: connectivity and identity (T-8.1)

- **Question**: Are the official Portaldot V3 endpoints reachable from this
  environment, and what do they verifiably answer: chain identity, health,
  height, EVM chain id: without assuming anything from generic Substrate
  docs?
- **Source**: T-8.1 live probe, 2026-10-19 ~17:51 UTC, via the implemented
  probe itself: `KAIZEN_TEST_V3=1 npx vitest run --config
  vitest.integration.config.mts test/integration/v3-probe.int.test.ts`
  (`test/integration/v3-probe.int.test.ts`, report logged as one
  credential-free `[v3-live]` JSON line). Manual pre-checks the same day:
  `curl -X POST https://test-evm-rpc-v3.portaldot.dev` (`eth_chainId` →
  `0x190f1ca9`) and a Node `ws` script against the Substrate endpoint
  (`system_chain`/`system_health`/`chain_getHeader`).
- **Evidence (verbatim observations, single probe cycle 2026-10-19T17:51Z)**:
  - **Substrate WS** `wss://test-node-v3.portaldot.dev`: `ok` (3130 ms):
    `system_chain` = **"PortaldotV3 Test"**; `system_health` =
    **{peers: 2, isSyncing: false, shouldHavePeers: false}**; best header
    **#106135** (hash `0x30c7b266…08cab66`).
  - **EVM JSON-RPC** `https://test-evm-rpc-v3.portaldot.dev`: `ok`
    (1553 ms): `eth_chainId` = `0x190f1ca9` = **420420777** (matches the
    supplied expectation exactly); `eth_blockNumber` = **#106135**: the
    SAME height as the Substrate head, corroborating one chain exposed via
    two protocols; `web3_clientVersion` is supported and returned
    **"eth-rpc/main-fddd431/x86_64-unknown-linux-gnu/rustc1.98.0"**: a
    Frontier-style `eth-rpc`, not a geth client.
  - Height advances over time (manual pre-check at 17:27 UTC read
    #105907), i.e. the chain is live, not a static fixture.
- **Status**: **VERIFIED** (point-in-time, this environment).
- **Implications**: the T-8.1 default configuration (incl. chain id
  420420777) is confirmed correct against the real endpoints; monitoring or
  later phases can read the current height from either surface and they
  agree; EVM method support includes the optional `web3_clientVersion`.
- **Uncertainties**: single-host, single-time-point observations; no
  finality/session/contract state probed (out of T-8.1's read-only
  connectivity scope); behavior across V3 chain restarts/reorgs not
  observed; availability of the endpoints from other networks/regions not
  tested.
- **Next verification step**: any future task integrating with V3 (e.g.
  contract deployment) re-runs `KAIZEN_TEST_V3=1` and must treat a
  chain-id mismatch as a hard stop, not a warning.

## R-24: Explorer public HTTP response: what is verifiable (T-8.1)

- **Question**: What can honestly be verified about
  `https://node-console.portaldot.dev` without a browser scraper or a new
  dependency: and what cannot?
- **Source**: manual `curl` inspection 2026-10-19 17:28 UTC, plus the
  probe's bounded availability check (fetch GET, first 2 KiB of the body,
  17:51 UTC).
- **Evidence**: HTTP/2 **200**, `content-type: text/html`, server
  `cloudflare`, ~12.9 kB document, `<title>Portaldot Node Console</title>`
  (probe observed the same title within its bounded 2 KiB prefix);
  `last-modified: 2026-10-16`. The page is an HTML SPA (loads
  `env-config.js`); it exposes **no Substrate WS or EVM JSON-RPC
  protocol** at this URL.
- **Status**: **PARTIALLY VERIFIED**: availability, status, content type,
  and document identity are verified; the explorer's actual data views
  (accounts, blocks, contracts rendered by its JS bundle) are NOT verified
  (that would require browser/JS execution: deliberately out of T-8.1
  scope: no scraper, no new dependency).
- **Implications**: the probe's explorer check is availability-only and
  says so in its typed result (`warnings` field: "availability check
  only…"); no RPC semantics are ever attributed to the explorer.
- **Uncertainties**: behavior of the console's backend APIs (its
  `env-config.js` targets) is unknown; whether the title changes across
  deployments.
- **Next verification step**: if explorer deep-checks are ever justified,
  inspect its published API surface first (likely a separate backend URL in
  `env-config.js`) rather than scraping HTML.

---

## R-25: Read-only monitoring surface on V3: polling budget and validator-identity sources (mentor A3)

- **Question**: Can Kaizen poll `wss://test-node-v3.portaldot.dev` (and the public EVM RPC) at roughly one request per block without harming the endpoint, and what is the authoritative source for the active validator set to score, given no official list is published?
- **Source**: mentor guidance (2026-10-31, A3): one request per block is appropriate; no official validator list is maintained yet; prioritize querying on-chain state.
- **Polling stance**: read-only polling at ~1 request per block is an appropriate rate for the public V3 WS endpoint. The engine's monitor samples node RPC on an interval and reads only public state; it never submits transactions or mutating extrinsics to shared endpoints. The EVM RPC is read only for anchoring receipts/verification lookups.
- **Validator-identity sources (query on-chain state, in priority order)**:
  - Current validators: `session.validators`
  - Next session keys: `session.queuedKeys`, `session.nextKeys`
  - Current session index: `session.currentIndex`
  - BABE authorities set: `babe.authorities`
  - GRANDPA authorities set: `grandpa.authorities`
- **Attribution rule (ties into A2 hardening, PR #27)**: BABE authorship is mapped through the authorities set in effect at the block being decoded; GRANDPA finality lag is suppressed across authority-set changes; era is never used as a basis for BABE identity (it governs elections and rewards).
- **Status**: **PARTIALLY VERIFIED**: the engine already reads `session.validators`, `babe.authorities`, and `grandpa.authorities` through its RPC layer (see `packages/engine/src/resilience`), and the per-block attribution rule is implemented and tested (PR #27). Polling-rate impact on the shared public endpoint is a stated mentor position, not independently load-tested by Kaizen.
- **Uncertainties**: no official list of active V3 validators exists yet; whether `session.nextKeys` is populated on V3 at the current session boundary has not been probed.
- **Next verification step**: log one session/epoch transition on the live endpoint and record the storage reads observed (keys, latency, rate) before demo day.

---

## Summary Matrix

| ID | Capability | Status |
|----|------------|--------|
| R-01 | Binary artifacts & install | VERIFIED |
| R-02 | Startup command / flags / subcommands | VERIFIED |
| R-03 | Single-node dev network | VERIFIED |
| R-04 | Multi-node network (2 nodes, bootnodes) | VERIFIED |
| R-05 | 4-validator & custom topologies | VERIFIED (Phase 2A: patched-spec 4-authority net + full node live) |
| R-06 | Ports / RPC / WS endpoints | VERIFIED (WS via @polkadot/api, Phase 1) |
| R-07 | RPC methods & responses | VERIFIED (core set) |
| R-08 | Identity/health/sync/peer inspection | VERIFIED |
| R-09 | Metrics / graceful shutdown | PARTIALLY VERIFIED |
| R-10 | Chain spec build/export | VERIFIED (Phase 2A: plain-spec surgery + raw rebuild live) |
| R-11 | Validator operation (genesis authorities) | PARTIALLY VERIFIED |
| R-12 | Staking extrinsics | PARTIALLY VERIFIED |
| R-13 | Session-key operations | PARTIALLY VERIFIED |
| R-14 | imOnline events | PARTIALLY VERIFIED |
| R-15 | Runtime identity (spec 1002, metadata V13) | VERIFIED |
| R-16 | Ecosystem quirks (prior art) | PARTIALLY VERIFIED |
| R-17 | Docker containerization | PARTIALLY VERIFIED |
| R-18 | Kubernetes + Helm | UNVERIFIED (tooling present) |
| R-19 | Mainnet endpoint | UNVERIFIED (out of scope) |
| R-20 | Platform coverage (macOS/WSL) | VERIFIED |
| R-21 | HTTP JSON-RPC for monitoring | VERIFIED (Phase 2A) |
| R-22 | Fault mechanisms: pause/disconnect/partition/terminate (T-3.1) | PARTIALLY VERIFIED: A/B2/C2/C4/C5/D VERIFIED; B1/C1/C3 negative results proven (see matrix). T-3.2: pause + terminate IMPLEMENTED and re-verified live through the injector; peer-disconnect + partition registered as typed-blocked (see T-3.2 status table) |
| R-23 | Portaldot V3 public endpoints: connectivity & identity (T-8.1) | VERIFIED (2026-10-19): Substrate WS chain "PortaldotV3 Test", health peers 2 / not syncing, best #106135; EVM chain id 420420777 matches config, same height via both surfaces, client `eth-rpc/main-fddd431…`; point-in-time, single host |
| R-24 | Explorer public HTTP response (T-8.1) | PARTIALLY VERIFIED: HTTP 200 / text/html / title "Portaldot Node Console" verified (availability-only check); SPA data views not verified (no browser/JS execution; out of scope) |
| R-25 | V3 monitoring surface: polling budget + validator-identity sources (A3) | PARTIALLY VERIFIED: ~1 req/block read-only stance per mentor guidance; storage-key sources implemented and tested (PR #27); endpoint load impact not independently load-tested |
