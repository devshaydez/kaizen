# Kaizen
Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.

Kaizen is a disaster-simulation engine that breaks Portaldot validators on purpose and proves on-chain that they recover.

Kaizen is a proof-of-resilience platform for Portaldot validators. It runs controlled drills against disposable test networks, records the observed operations and evidence, and supports independently verifiable certificates anchored to the Portaldot V3 test network.

[![Resilience](https://kaizen-live.vercel.app/api/badge)](https://kaizen-live.vercel.app)

## The problem

Validator operators need a way to demonstrate that their infrastructure can withstand operational failures. A dashboard or an unverified claim cannot establish that a fault occurred, that recovery was observed, or that the resulting evidence is authentic. Kaizen is designed to make these operations explicit, gated, recorded, and independently checkable.

## How it works

Kaizen uses a shared TypeScript engine for network and node operations, monitoring, fault injection, scenarios, evidence, and certificates. The CLI and HTTP API call that engine rather than maintaining separate operational logic. The React web console reads through the API and renders engine-produced data.

The engine manages disposable Portaldot networks, samples node RPC and process state, and can run supported, explicitly requested failure scenarios. Safety gates restrict destructive operations to designated local or development test networks. Run records preserve the selected scenario, observed steps, and verification evidence. The certificate flow can verify and anchor evidence on-chain; the system does not substitute simulated results for missing observations.

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

## Evidence and on-chain anchoring

The drill-live workflow runs real resilience drills in CI every three hours. It records evidence for each run and anchors the resulting evidence through the configured Portaldot V3 test-network flow. The published live console at https://kaizen-live.vercel.app exposes the available live evidence. The configured drill signer is `5HBnAqniYhyupDT1ccsTSRkdy3EbCAaZC6ii9XFon8WQwEaR`.

An anchor or drill is reported only when its corresponding operation and evidence support that claim. See [the architecture](docs/ARCHITECTURE.md), [the technical research record](docs/TECHNICAL_RESEARCH.md), and [the testing evidence](docs/TESTING.md) for scope and verification boundaries.

## Contract platform choice: ink! via pallet-contracts, with a documented revive path

The resilience registry is a 6.8 KB ink! contract deployed through pallet-contracts on Portaldot V3. This was a deliberate evaluation, not a default: the ink! path is native to the Substrate toolchain the engine already operates (BABE/GRANDPA evidence decoding, on-chain anchoring), registry upload plus instance deposit is approximately 548 tPOT, and each certificate anchor costs approximately 1.4 tPOT, versus approximately 7.7 tPOT for the equivalent EVM-side registry. The official ink! documentation has stated it will no longer be actively maintained or developed from January 2026; this is factored in, and because the registry is isolated behind the engine's `V3AnchorService`, a future port to revive/PolkaVM is a bounded change to that service boundary rather than an engine rewrite. Deposit levels on V3 are expected to continue being adjusted, so the cost model reads actual chain deposits at runtime instead of hardcoding them.

## Roadmap

The implementation plan and progress log describe the current state and remaining work. Planned areas include deployment adapters for Docker and Kubernetes/Helm, additional validator operations, and broader end-to-end verification. Planned capabilities are not represented as completed features. See [Implementation Plan](docs/IMPLEMENTATION_PLAN.md) and [Progress](docs/PROGRESS.md).

## Documentation

- [Project specification](docs/PROJECT_SPEC.md)
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
