# Kaizen business case

> Monitoring tells you a node is down. Kaizen proves it comes back, and makes that proof worth stake.

## The problem

Validator operators need credible evidence that their infrastructure can recover from operational faults. Monitoring can show a node is unavailable, but availability dashboards alone do not demonstrate how a validator behaved during a controlled disruption or whether recovery was observed. Delegators also lack a consistent, evidence-backed signal they can use when comparing validator operations.

Kaizen is a proof-of-resilience platform for Portaldot. It runs controlled drills on disposable local test networks, records observed operations and recovery evidence, and supports independently verifiable certificates anchored to the Portaldot V3 testnet. A local test-network result is evidence about that test exercise only. It is not a claim about mainnet performance, production readiness, or guaranteed future uptime.

## Users and beneficiaries

- **Validator operators and staking providers** can run repeatable test-network drills and use verified results to explain their recovery practices to prospective delegators. Certificates evidence a specific recorded exercise, not a guarantee of production reliability.
- **Delegators and staking dashboards** can inspect published scores and certificate evidence as one input when comparing validators. Kaizen does not make delegation decisions or guarantee validator outcomes.
- **Portaldot ecosystem teams** can use controlled local test networks to exercise operational recovery workflows. Any future pre-upgrade or chain-wide exercise would remain explicitly test-network scoped unless separately designed and authorized.

## Product and value proposition

Kaizen connects controlled failure injection with observed recovery, an auditable run history, and certificates that can be checked independently. Operators receive a concrete artifact to communicate how a specific drill performed; ecosystem teams gain a repeatable workflow for examining operational resilience. The certificate and its underlying evidence should be interpreted within their stated environment, scope, and time.

## Go-to-market

The open-source CLI is the adoption path: operators can run drills themselves on local test networks without relying on a hosted service. Published run evidence and certificates can help validators share results with delegators and infrastructure communities. The live page can display a certificate-backed badge, for example, “Kaizen-certified: recovered in X s,” where the displayed value is taken from the corresponding verified certificate and exercise record.

This approach prioritizes verifiable usage and ecosystem relevance over unsupported commercial claims. No pricing, revenue, customer counts, adoption metrics, partnerships, or commercial commitments are asserted here.

## Planned roadmap

The following are planned capabilities, not current offerings:

- **Planned:** hosted scheduled drills with public certificate pages.
- **Planned:** coordinated, chain-wide drills before runtime upgrades.
- **Planned:** additional fault scenarios, including peer disconnection and network partition, as technically supported and safely gated.
- **Planned:** a public run-registry explorer for browsing published evidence and certificates.
- **Planned:** expanded validator operations, including staking and session-key workflows, only where supported by the official runtime and with appropriate safety controls.
- **Planned:** Docker and Kubernetes/Helm deployment support, subject to implementation and verification.

Any future drill execution must preserve explicit test-network safeguards. Roadmap items do not imply mainnet operation, production guarantees, or delivery dates.

## Links

- Repository: https://github.com/Shaydez-Defi/kaizen
- Live application: https://kaizen-live.vercel.app
- Pitch deck: Kaizen Pitch Deck (PDF)
