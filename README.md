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

### Monitoring surface

Read-only monitoring polls the public V3 WS endpoint at roughly one request per block and reads validator identity from on-chain state: `session.validators` (current validators), `session.queuedKeys` / `session.nextKeys` (next session keys), `session.currentIndex`, `babe.authorities`, and `grandpa.authorities`. No official validator list is published, so on-chain state is the source of truth. See [Technical research](docs/TECHNICAL_RESEARCH.md), R-25.

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
