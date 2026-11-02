# Phase 9 and Console Status Report: T-3.6C and T-9.1 to T-9.5

**Revision date**: 2026-10-30. **Status**: T-3.6C and T-9.1 through T-9.5 are implemented as described below. Implementation status is distinct from the strength of evidence; no full live-browser verification is claimed. The previous report is preserved verbatim as `docs/PHASE_REPORT_v1.md`.

## Scope and current status

- **T-3.6C, console and landing design alignment: IMPLEMENTED, NOT VERIFIED end to end.** The 2026-10-22 progress entry records the rebuilt landing and console layouts, retained real API/WebSocket wiring, `kaizen up`, and disabled/labelled Docker/Kubernetes affordances. Recorded checks include typecheck, lint, build, web jsdom tests and screenshot rendering using fixture API data. These are not a live-browser smoke against a live Portaldot network.
- **T-9.1, chain-bound resilience evidence: IMPLEMENTED.** Evidence capture records best/finalized heads and hashes from an observer distinct from the fault target; verification re-fetches hashes and distinguishes mismatch from unavailable/offline evidence.
- **T-9.2, resilience certificates: IMPLEMENTED.** Canonical run/evidence certificate with sr25519 signature and explicit operator-controlled certification. Additional validator/network metadata cross-check hardening is pending separate validation and is not asserted as verified here.
- **T-9.3, resilience score v1: IMPLEMENTED.** Score v1 uses eligible certificates; integrity-failing certificates are excluded. Commit-reveal seeded drills, BABE authorship/GRANDPA finality inputs, and evidence-class weighting are PLANNED follow-on work, not part of v1.
- **T-9.4, resilience registry contract: PARTIALLY IMPLEMENTED, UNDEPLOYED.** Contract, reproducible build/artifact and in-memory EVM test exist. `KaizenResilienceRegistry.sol` must remain undeployed until the duplicate-fingerprint submission design is resolved.
- **T-9.5, product surfaces: IMPLEMENTED.** Opt-in evidence capture, CLI certification/listing/scoring/verification commands, read-only resilience API, persistence migrations and gated live integration workflow are recorded in the 2026-10-24 progress entry.

## Evidence levels, kept distinct

1. **Unit tests** exercise isolated logic and mocks. The 2026-10-24 record lists chunked web, CLI, API and engine suites, plus 6/6 in-memory registry tests. These do not prove connectivity to real nodes or the public chain.
2. **Real local-network integration tests** use a real two-node `portaldot_dev` network and a bounded pause/recovery drill. The 2026-10-24 GitHub Actions run recorded five observations, zero gaps, recovery metrics, and an online certificate verification matching 11 hashes. After the network stopped, the same evidence correctly returned `unverifiable` because the network was offline. This is live local-network evidence, not public-chain transaction evidence.
3. **Public Portaldot V3 transactions** are separately recorded in the 2026-10-21 report/history and `docs/PROGRESS.md`, including contract and `remarkWithEvent` transaction hashes and finalized blocks. Those transactions evidence the V3 run-anchoring flow; they do not establish deployment of the separate `KaizenResilienceRegistry.sol`.
4. **Browser tests with mock data** include jsdom/component tests and screenshots rendered against fixture API data, as recorded for T-3.6C. They establish rendering and interaction behavior for the tested fixtures only.
5. **Full live-browser verification** of the complete console/Failure Lab flow against a live network remains **NOT VERIFIED**. No evidence in this report establishes that a real browser completed the full live flow.

## Hardening and explicitly planned work

`apps/api/src/server.ts` binds to `127.0.0.1` by default. The localhost API is unauthenticated by design and is loopback-only; do not expose it remotely as-is. Before any remote deployment, implement and verify Host/Origin validation and WebSocket cross-origin protection, together with an appropriate authentication boundary. These controls are PLANNED, not present verification.

The IncidentMonitor and Docker/Kubernetes/Helm adapters remain PLANNED. `KaizenResilienceRegistry.sol` remains undeployed until its duplicate-fingerprint submission design is resolved. The more advanced resilience trust model described above also remains PLANNED.

## Sources of recorded evidence

The evidence summaries above reflect the dated entries in `docs/PROGRESS.md`, the resilience specification in `docs/RESILIENCE_SCORE.md`, and the earlier report preserved verbatim as `docs/PHASE_REPORT_v1.md`. This report records historical results; it does not rerun or upgrade them into fresh verification.
