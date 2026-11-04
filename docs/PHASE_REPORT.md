# Portaldot Evidence Upgrade — Phase Report

**Branch**: `feat/portaldot-evidence-upgrade`. **Started**: 2026-11-04.
**Scope**: T-9.7 (consensus-aware evidence, validator discovery, evidence and
score integrity, contract/anchoring evaluation, reproducible CI). This report
is updated after each phase. Claims below are limited to what was run and
observed; a phase is not "verified" because code exists.

---

## Phase A — Audit and architecture (2026-11-04)

### A.1 What already worked (preserved)

| Area | State found | Evidence |
|---|---|---|
| Chain-bound evidence | `ChainEvidenceRecorder` reads best/finalized heads from an observer node that is not the fault target, records gaps instead of filling them, and derives recovery from finality advancing past the pre/during-fault maximum. | `packages/engine/src/resilience/evidence.ts`; 11 offline tests in `resilience-evidence.test.ts`; live drill in `test/integration/resilience.int.test.ts` |
| Certificates | Canonical document (`kaizenCertificate`, run hash, run, chain) → SHA-256 fingerprint; sr25519 signature; dev keys labelled; verification recomputes the fingerprint and re-fetches every observed block hash by number. | `certificate.ts`, `verify.ts`; 12 + 6 offline tests; `resilience-live.yml` |
| Score v1 | Deterministic, documented formula with recency decay and confidence; integrity-failing certificates excluded. | `score.ts`, `docs/RESILIENCE_SCORE.md`; 12 offline tests |
| V3 run anchoring | EVM registry (`KaizenRunRegistry`) via pallet-revive and `system.remarkWithEvent`; submission gated, explicit, dry-run before spending fees; receipts/events required before an anchor is called anchored. | `packages/engine/src/v3/anchor/*`; `v3-anchor.test.ts`; recorded live anchors (T-8.2) |
| Read-only RPC reader | `chain_getHeader` / `chain_getFinalizedHead` / `chain_getBlockHash` over HTTP with timeouts and a typed unreachable error. | `resilience/rpc.ts` |

### A.2 Gaps found (the work this upgrade targets)

1. **Consensus evidence was documented, not implemented.**
   `README.md` ("Monitoring surface") and `docs/TECHNICAL_RESEARCH.md` R-25
   state that the engine reads `session.validators`, `babe.authorities`, and
   `grandpa.authorities` through its RPC layer. No code in
   `packages/engine/src/resilience` performed any of those reads. R-25 is
   therefore downgraded to **UNVERIFIED** in this upgrade (the polling stance
   remains mentor guidance, not a Kaizen measurement).

2. **Uncommitted consensus groundwork was defective.** A pre-existing
   uncommitted `consensus.ts` + recorder wiring was audited before reuse:
   - `attributeBabeSlot` derived authorship from an invented `period`
     round-robin (`slot / period % authorities.length`). That is not a BABE
     rule. BABE carries the `authority_index` in the pre-runtime digest, and
     secondary slots use `blake2_256(epoch_randomness ++ slot) % authorities_len`
     (Substrate `sc-consensus-babe` documentation). The implemented rule could
     silently attribute a block to the wrong validator — the exact failure the
     feedback asks to prevent.
   - `finalityDuringSetTransition` returned true when a transition occurred
     *at or after* the observation block, which has no relationship to
     explaining a finality gap.
   - Transition detection never seeded the first observed `setId`, so the
     second observation always looked like a transition.
   - `buildConsensusEvidence` collapsed "no source configured", "read failed",
     and "no data" into one boolean without reasons.

3. **No validator discovery.** Nothing queried `session.validators`,
   `session.queuedKeys`, `session.nextKeys`, `session.currentIndex`,
   `babe.authorities`, or `grandpa.authorities`; validators were only known
   from process records.

4. **No evidence-integrity recomputation.** Verification compared block hashes
   and the certificate fingerprint but never recomputed `metrics`, never
   checked observation ordering against fault timestamps, and never classified
   a drill as passed/failed/inconclusive. A certificate with
   `consensus.incomplete = true` still reported `status: verified`; the only
   signal was a free-text reason.

5. **Score v1 conflated missing with bad.** `inverse(null) = 0` meant a
   drill whose metric could not be derived scored identically to a
   catastrophic measurement. Era/authority transitions, evidence volume
   coverage, and incomplete certificates were not inputs.

6. **Anchoring verification stopped short.** `V3AnchorService.verify` checked
   genesis, block hash, `anchoredAt`, and `eth_getCode`; it did not check the
   EVM chain id, did not confirm the recorded transaction succeeded, and did
   not validate the registry address provenance.

7. **Documentation overclaimed the contract.** `README.md` and DEC-031 state
   that a 6.8 KB ink! registry is deployed on Portaldot V3 and quote deposit
   costs. The repository contains only Solidity/revive artifacts
   (`contracts/*.sol`, `KaizenResilienceRegistry` remains undeployed per
   RSK-30); no ink! source, build artifact, or deployment record exists here.
   Phase D records this honestly and does not migrate anything.

### A.3 Plan

- **Phase B** — replace the defective attribution with digest-based
  authorship; add epoch/session/authority-set context, GRANDPA `setId`
  tracking with a bounded transition window, and read-only validator discovery
  over an injectable runtime facade (real `@polkadot/api` implementation;
  offline fake for tests), cached per block to keep the read rate at roughly
  one snapshot per block.
- **Phase C** — evidence integrity (metric recomputation, timestamp
  consistency, completeness reasons), drill outcome classification
  (passed/failed/inconclusive), certificate evidence hash, verification
  outcome propagation, and score v2 eligibility/coverage rules.
- **Phase D** — documented, evidence-based contract comparison (revive vs
  ink!) and anchoring economics; read-only verification hardening (EVM chain
  id, transaction receipt, registry address, on-chain record match). No
  deployment or migration.
- **Phase E** — CI drill assertions/artifacts, README reproduction path,
  documentation sync, full test/build/typecheck/lint run, diff review, PR.

### A.4 Constraints recorded

- The local sandbox is arm64 and has no `portaldot_dev` binary, so live-node
  verification cannot run here. Live suites remain gated by
  `KAIZEN_TEST_LIVE=1` and are exercised on x86_64 CI. Unit tests use
  scripted fakes only and are never described as network tests.
- No mainnet access, no contract deployment, no fund spending, no migration.

---

## Phase B — Consensus and validator discovery (2026-11-04)

### Implemented

- **BABE authorship is digest-based, not slot-derived.**
  `decodeBabePreDigest` decodes the SCALE enum from Substrate
  (`1 Primary`, `2 SecondaryPlain`, `3 SecondaryVRF`; `authority_index: u32`
  then `slot: u64`) and `attributeBabeAuthorship` resolves the author through
  the authority set read in the block's own state. For secondary slots the
  digest index is cross-checked with
  `U256::from_big_endian(blake2_256((epoch_randomness, slot).encode())) % authorities_len`
  (the literal `sc-consensus-babe` rule).
- **Conservative attribution.** Missing authority list, an authority index
  outside the observed set, a slot outside `[epochStart, epochStart+duration)`,
  or a secondary-rule disagreement makes the record `inconclusive` with
  reasons; no validator id is emitted in those cases.
- **Session/epoch transitions preserved.** Each authorship record carries the
  epoch, epoch start/duration, `authoritySetId`, raw authority key and resolved
  validator id. The evidence stores every authority set used, plus observed
  BABE epoch transitions.
- **GRANDPA setId tracking.** Transitions are recorded with `fromSetId`,
  `toSetId`, finalized block and time, validated for duplicates/non-increasing
  ids, and used to classify finality lags as `normal`, `expected-transition`,
  `stalled`, or `unknown`. A set change across an observation is expected
  protocol behaviour even when the transition record was built later.
- **Dynamic, read-only validator discovery.** `ValidatorDiscovery` queries
  `session.validators`, `session.queuedKeys`, `session.nextKeys`,
  `session.currentIndex`, `babe.authorities`, `grandpa.authorities`, epoch
  context, `grandpa.currentSetId`, and staking era context over
  `@polkadot/api`. It caches one snapshot per block hash, reads historical
  blocks at that block's hash, maps BABE/GRANDPA keys to validator accounts,
  and records failed/absent queries in `unavailable`. Era points are context
  only and are never used for BABE identity.

### Files

`packages/engine/src/resilience/consensus.ts` (rewritten),
`discovery.ts` (new), `consensus-runtime.ts` (new), `evidence.ts`,
`service.ts`, `index.ts`, `packages/engine/src/engine.ts`;
`packages/engine/test/resilience-consensus.test.ts` (rewritten),
`packages/engine/test/resilience-discovery.test.ts` (new),
`test/integration/resilience.int.test.ts`.

### Tests and results (actual)

- `npx vitest run --config vitest.config.mts packages/engine/test/resilience-*.test.ts`
  → 8 files, **97 passed** (26 consensus + 13 discovery are new/replaced).
- `npx tsc -p packages/engine --noEmit` → clean.
- Live assertions added but **not run locally** (arm64, no `portaldot_dev`);
  they require the x86_64 `resilience-live.yml` run.

### Known limitations

- `staking.erasRewardPoints` on `portaldot_dev` is unverified; discovery
  reports it unavailable rather than fabricating points.
- Live mapping of authority keys to validator accounts depends on
  `session.queuedKeys` / `session.nextKeys` being present and named as such on
  Portaldot; if not, authorship is `authored` but `validatorId` stays null and
  the evidence is marked incomplete with that reason.
- The discovery snapshot performs one read per listed storage item at capture
  points; it is cached per block but has not been load-tested against the
  shared public endpoint.

---

## Phase C — Evidence, certificate and score integrity (2026-11-04)

### Implemented

- **Evidence recomputation** (`integrity.ts`): `checkEvidenceIntegrity`
  re-derives every metric with `computeRecoveryMetrics` and compares it with
  the stored document, validates every block reference and `finalized ≤ best`,
  checks phase order against the fault window, requires all three phases, and
  returns an `evidenceHash` (SHA-256 over canonical evidence).
- **Drill outcome**: `assessDrill` returns `passed` / `failed` / `inconclusive`.
  A no-recovery drill with complete observations is `failed` (not
  inconclusive); a tampered or incomplete document is `inconclusive`; a valid
  signature does not upgrade either.
- **Certificates**: new certificates carry `evidenceHash` and `outcome`.
  These fields are intentionally outside the signed fingerprint document
  (which is unchanged, so v1 certificates still verify); verification
  recomputes and compares them. Legacy certificates without the fields are
  accepted and reported as such, not invalidated.
- **Verification**: `CertificateVerification` now includes a recomputed
  `evidence` assessment, `evidenceHashMatches`, and a `CertificateVerdict`
  that adds `inconclusive` (valid signature + verified chain + incomplete
  consensus or incomplete evidence). Tampering (fingerprint, metrics,
  timestamps, evidenceHash) is `mismatch`; an unreachable network is
  `unverifiable`.
- **Score v2** (`score.ts`, `docs/RESILIENCE_SCORE.md`): missing metrics are
  excluded from the quality average instead of scored as catastrophic;
  `coverage` is reported and multiplies confidence; `evidenceOutcome =
  inconclusive` is never survived; expected GRANDPA transitions are removed
  from the finality signal via `scoringFinalityGap`; the service excludes
  ineligible certificates with a reason. Worked examples A–F are unchanged
  when all metrics are measured.

### Tests and results (actual)

- `npx vitest run --config vitest.config.mts packages/engine/test/resilience-*.test.ts`
  → 9 files, **118 passed** (13 new integrity tests; score/verify/certificate
  suites extended).
- `npx tsc -p packages/engine --noEmit` → clean.
- No live-network run (arm64 sandbox).

### Known limitations

- Consensus absence is reported, not treated as tampering; consensus-present
  but incomplete makes the certificate verdict `inconclusive`.
- Evidence-class weighting (chain-observed vs chain-bound) and seeded drills
  remain the planned v3 trust model; v2 does not claim absolute reliability.
- `evidenceHash` is not part of the signature. The signed fingerprint already
  binds the full evidence; the hash is a convenience whose mismatch is still
  detected by verification, but it is not an independent signature.

---

## Previous report (Phase 9, T-3.6C and T-9.1–T-9.5)

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

`apps/api/src/server.ts` binds to `127.0.0.1` by default. The localhost API is unauthenticated by design and loopback-only; do not expose it remotely as-is. Before any remote deployment, implement and verify Host/Origin validation and WebSocket cross-origin protection, together with an appropriate authentication boundary. These controls are PLANNED, not present verification.

The IncidentMonitor and Docker/Kubernetes/Helm adapters remain PLANNED. `KaizenResilienceRegistry.sol` remains undeployed until its duplicate-fingerprint submission design is resolved. The more advanced resilience trust model described above also remains PLANNED.

## Sources of recorded evidence

The evidence summaries above reflect the dated entries in `docs/PROGRESS.md`, the resilience specification in `docs/RESILIENCE_SCORE.md`, and the earlier report preserved verbatim as `docs/PHASE_REPORT_v1.md`. This report records historical results; it does not rerun or upgrade them into fresh verification.
