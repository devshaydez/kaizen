# Kaizen
Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.

Kaizen is a disaster-simulation engine that breaks Portaldot validators on purpose and proves on-chain that they recover.

Kaizen is a proof-of-resilience platform for Portaldot validators. It runs controlled drills against disposable test networks, records the observed operations and evidence, and supports independently verifiable certificates anchored to the Portaldot V3 test network.

[![Resilience](https://kaizen-live.vercel.app/api/badge)](https://kaizen-live.vercel.app)

## The problem

Validator operators need a way to demonstrate that their infrastructure can withstand operational failures. A dashboard or an unverified claim cannot establish that a fault occurred, that recovery was observed, or that the resulting evidence is authentic. Kaizen is designed to make these operations explicit, gated, recorded, and independently checkable.

## How it works

Kaizen uses a shared TypeScript engine for network and node operations, monitoring, fault injection, scenarios, evidence, and certificates. The CLI and HTTP API call that engine rather than maintaining separate operational logic. The React web console reads through the API and renders engine-produced data.

The engine manages disposable Portaldot networks, samples node RPC and process state, and can run supported, explicitly requested failure scenarios. Safety gates restrict destructive operations to designated local or development test networks. Run records preserve the selected scenario, observed steps, and verification evidence, including BABE authorship and GRANDPA finality context read from the chain at the observed blocks. Ambiguous consensus data is recorded as `inconclusive` rather than attributed to a validator. The certificate flow verifies evidence integrity and anchoring; the system does not substitute simulated results for missing observations.

## Quickstart

Requirements: Node.js 24 or later, npm, and a supported Linux x86_64 or macOS host. The first setup requires network access to download the upstream Portaldot node binary. Each running node requires approximately 1 GiB of free RAM.

From a clean clone, run:

```bash
git clone https://github.com/Shaydez-Defi/kaizen.git
cd kaizen
npm ci
npm run build
npm test
```

The workspace scripts and runtime packages are specified in `package.json` and the package manifests. `npm install` installs the workspace dependencies, `npm run build` builds the engine, CLI, API, and web application, and `npm test` runs the unit suite. A real-node integration suite is separate and opt-in; it requires `portaldot_dev` and `KAIZEN_TEST_LIVE=1` as described in [Testing](docs/TESTING.md). The hosted console provides the public live view at https://kaizen-live.vercel.app.

### Reproduce the live drill

`portaldot_dev` is distributed for x86_64, so the live proof runs on an
x86_64 Linux runner (an arm64 machine cannot download it; RSK-31):

```bash
KAIZEN_TEST_LIVE=1 KAIZEN_ATTESTATION_DIR=./attestations \
  npx vitest run --config vitest.integration.config.mts \
  test/integration/resilience.int.test.ts
```

The `.github/workflows/resilience-live.yml` job does exactly this on a
GitHub-hosted x86_64 runner: it boots a real two-node network, pauses a
validator, captures evidence, certifies with the **public** dev key, and
verifies the certificate online and offline. It can be started from the
Actions tab (`workflow_dispatch`) and runs on pull requests touching the
engine. The `resilience-attestations` artifact contains the certificate,
verification and score JSON produced by that run; the job also prints a
short listing and preview of the files. A green workflow is real-node
verification; the offline unit suite is not a substitute for it.

The twice-hourly `drill-live` workflow publishes a live bundle to the
`demo-data` branch, which the hosted console reads.

## Evidence and on-chain anchoring

The drill-live workflow runs real resilience drills in CI every three hours. It records evidence for each run and anchors the resulting evidence through the configured Portaldot V3 test-network flow. The published live console at https://kaizen-live.vercel.app exposes the available live evidence. The configured drill signer is `5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR`.

An anchor or drill is reported only when its corresponding operation and evidence support that claim. See [the architecture](docs/ARCHITECTURE.md), [the technical research record](docs/TECHNICAL_RESEARCH.md), and [the testing evidence](docs/TESTING.md) for scope and verification boundaries.

## Contract platform: revive/EVM (deployed), ink! evaluated and not adopted

The run registry deployed on Portaldot V3 (`KaizenRunRegistry`) is Solidity compiled to EVM bytecode and executed by pallet-revive. That is the path the engine's anchoring, dry-run, receipt and verification code exercises, and it is the path with recorded live transactions. `KaizenResilienceRegistry.sol` is implemented, reproducible and tested in memory, but it is **not deployed** (the deployer held ≈3.15 tPOT against an ≈85 tPOT registry deploy, RSK-30).

No ink! contract is present in this repository. The official ink! documentation states that active maintenance ended in January 2026, and there is no working ink! deployment here to preserve; migrating would add a new artifact, codec, dry-run path and deployment without a measured benefit. The registry is isolated behind `V3AnchorService`, so a future move to pallet-contracts remains a bounded change if Portaldot requires it. Deposit levels on V3 change over time, so costs are read from live chain state rather than hardcoded.

The full evidence-based comparison, measured versus estimated costs, batching options, and known limitations are in [Portaldot integration](docs/PORTALDOT_INTEGRATION.md).

### Monitoring surface

Read-only monitoring reads validator identity and consensus context from on-chain state at an explicit block: `session.validators`, `session.queuedKeys`, `session.nextKeys`, `session.currentIndex`, `babe.authorities`, `grandpa.authorities`, plus epoch and staking-era context. Discovery is cached per block, so a monitor reads at most one snapshot per block; it never writes. No official validator list is published, so on-chain state is the source of truth. The reads are implemented with offline tests; the live-node assertions run only in the x86_64 resilience workflow and have not been executed in every environment. See [Portaldot integration](docs/PORTALDOT_INTEGRATION.md) and [Technical research](docs/TECHNICAL_RESEARCH.md), R-25.

## Roadmap

The implementation plan and progress log describe the current state and remaining work. Planned areas include deployment adapters for Docker and Kubernetes/Helm, additional validator operations, and broader end-to-end verification. Planned capabilities are not represented as completed features. See [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) and [Progress](docs/PROGRESS.md).

## Documentation

- [Project specification](docs/PROJECT_SPEC.md)
- [Portaldot integration: consensus, evidence, contracts](docs/PORTALDOT_INTEGRATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Technical research](docs/TECHNICAL_RESEARCH.md)
- [Risk register](docs/RISKS.md)
- [Decision records](docs/DECISIONS.md)
- [Progress log](docs/PROGRESS.md)
- [Testing strategy and evidence](docs/TESTING.md)
- [Phase reports](docs/PHASE_REPORT.md)

## License

Kaizen is released under the MIT License. See [LICENSE](LICENSE) for the complete terms.
