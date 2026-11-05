# Resilience Score — specification (v2)

Status: v2 IMPLEMENTED (T-9.7C, 2026-11-04); v1 remains recomputable from v1
inputs; the seeded/chain-observed trust model is **v3 PLANNED** (§7).
Code: `packages/engine/src/resilience/score.ts`, pinned by
`packages/engine/test/resilience-score.test.ts`. Decision: DEC-029.

The resilience score is a **0–100 number per validator** computed from the
validator's **certified** Failure Lab runs. It is a pure, deterministic
function: anyone holding the certificates can recompute it. Kaizen never
shows a score it did not compute from certificates.

A score is evidence about the exercises Kaizen ran. It is **not** an
absolute reliability rating of a validator, and v2 does not claim to make
operator self-reporting trustworthy; §7 records the remaining gap.

## 1. Inputs: eligible certified runs

A certified run is a `ResilienceCertificate` (T-9.2): the finished run
record plus **chain evidence** — best and finalized heads (number + hash)
observed by a reference node before the fault, during it, and after
recovery — fingerprinted with SHA-256 over canonical JSON and signed with
the operator's sr25519 key.

A certificate is **eligible** only when:

1. its fingerprint, signature, address/key consistency and top-level
   metadata all check out (T-9.2/T-9.7C);
2. its stored `evidenceHash` (when present) equals a fresh hash of the
   evidence document;
3. `assessDrill` returns `passed` or `failed`, not `inconclusive` — i.e. the
   evidence has every phase, well-formed block references, consistent
   timestamps, metrics that recompute exactly, and derivable gap/liveness
   metrics.

Ineligible certificates are reported as `excluded` with a reason and do not
contribute quality or confidence. Certificates whose chain binding is
`unverifiable` (the local network has since been stopped) remain eligible:
the score is an offline function of the stored evidence and records how many
inputs it used; `kaizen verify-certificate` shows the chain verdict.

Certificates signed with the public DEV key are labelled. A valid signature
proves integrity and control of the signing key; it does **not** prove that
the operator is trustworthy or that the drill was not staged.

## 2. Per-run metrics (from chain evidence)

All three are derived by `computeRecoveryMetrics` from the observations
alone; a metric that cannot be derived is `null`.

| Metric | Definition |
|---|---|
| `recovered` | some after-recovery observation has a finalized number strictly greater than every finalized number observed before/during the fault (block production without finality is **not** recovery) |
| `timeToRecoverMs` | first recovered observation time − fault end time (fault start if no end was recorded); null when the drill did not recover |
| `finalityGapBlocks` | max over during/after observations of `best.number − finalized.number` |
| `blocksMissed` | `floor(elapsed / expectedBlockTime) − produced`, clamped at 0, where elapsed and produced span the last before-fault to the last during-fault observation; `expectedBlockTime` defaults to 6 000 ms and is recorded in the evidence |

**Expected authority transitions are not penalised.** When consensus
evidence is present, the scoring input uses `scoringFinalityGap`: the maximum
lag among finality observations **not** classified `expected-transition`. If
every measured gap coincides with a GRANDPA set change, the scoring signal is
0. Expected session/epoch/authority-set changes therefore cannot lower a
validator's score.

## 3. Formula (v2)

Per run *i*:

```
survived_i = recovered_i AND state_i ∈ {completed, completed-with-warnings}
             AND evidenceOutcome_i ≠ failed AND evidenceOutcome_i ≠ inconclusive

components (only measured ones enter the average):
  R = 1 / (1 + timeToRecoverMs / 60 000)
  F = 1 / (1 + finalityGapBlocks / 10)
  M = 1 / (1 + blocksMissed / 10)

q_i = survived_i ? Σ(weight·value) / Σ(weight) over available metrics : 0
c_i = Σ(weight) over available metrics / 0.5+0.3+0.2
w_i = 0.5 ^ (ageDays_i / 30)          age from certification time; future → 0
```

Aggregate:

```
quality    = Σ w_i·q_i / Σ w_i
coverage   = Σ w_i·c_i / Σ w_i
confidence = (1 − e^(−Σ w_i / 2)) × coverage
score      = round(100 · quality · confidence), clamped to [0, 100]
```

Rationale:

- **Recovery time dominates (0.5)** — the question a delegator or network
  operator asks is "how fast does finality come back after this validator is
  hit?" A 60 s recovery halves R.
- **Finality gap (0.3)** measures how far finality fell behind production;
  10 blocks halves F. Transition-time gaps are removed beforehand (§2).
- **Liveness (0.2)** penalises missed slots during the fault window; 10
  missed blocks halves M.
- **Missing ≠ bad.** A metric that could not be derived is excluded from the
  average and lowers `coverage`; it is not scored as a catastrophic
  measurement. A run with no measured metric has quality 0 and coverage 0.
- **Failed runs count as 0** and still carry weight, so failures pull the
  score down rather than being ignored.
- **Recency decay (30-day half-life)** — resilience must be re-proven; old
  runs fade.
- **Confidence** stops one lucky run from scoring high and is multiplied by
  metric coverage, so missing measurements reduce confidence rather than
  pretending a bad outcome occurred.

Parameters are exported as `RESILIENCE_SCORE_PARAMS`; changing any of them
is a new score version (`RESILIENCE_SCORE_VERSION = 2`).

## 4. Worked examples (pinned by tests)

"Typical" run: recovered, `completed`, ttr 12 s, gap 6, missed 6 → q ≈ 0.729
with coverage 1.

| # | Certified runs (as of 2026-10-24) | Score |
|---|---|---|
| A | one fresh typical run | 29 |
| B | five fresh typical runs | 67 |
| C | five fresh perfect runs (0 s, gap 0, missed 0) | 92 |
| D | four fresh typical + one failed | 54 |
| E | five typical runs, all 30 days old | 52 |
| F | ten fresh perfect runs | 99 |

Examples A–F are unchanged from v1 because every metric is measured and
every drill is eligible. The differences appear only in the cases v1
conflated:

- one typical run with only finality and liveness measured → q = 0.625,
  coverage = 0.5, confidence halved;
- an inconclusive certificate → excluded (no quality contribution);
- a finality gap that is entirely transition-time → gap signal 0.

## 5. On-chain form

`KaizenResilienceRegistry` (contracts/) stores per-validator certificates
(fingerprint, sr25519 signer key, metrics, score, timestamp) and exposes
`getLatest` / `getScore`. The **contract does not compute the score** (no
floating point or sr25519 verification in the EVM); it stores the score the
operator computed with this spec next to the inputs, so anyone can
recompute it from the certificates and compare. The signature itself is
emitted in the `CertificateRecorded` event (not stored) and is verified
off-chain by `kaizen verify-certificate` / the API. The registry remains
**undeployed** (RSK-30); this section describes the interface, not a live
deployment.

## 6. Limits (honest scope)

- Evidence comes from one reference observer node per run; a partitioned
  observer would see its own fork (verification then reports `mismatch`).
- `blocksMissed` assumes a fixed slot time; it is a liveness signal, not a
  slashing-grade measure.
- Consensus context can be absent (v1 evidence) or incomplete (e.g. an
  authority key not mapped to an account). The score remains chain-bound
  evidence in that case; consensus-level authorship claims are not made.
- Scores from local test networks show what the validator setup survives
  under Kaizen's fault catalogue (pause, terminate); they are not a claim
  about mainnet behaviour.
- v2 trusts the operator to run the drill honestly and to keep the signing
  key. Verification can detect tampering with stored evidence, not a drill
  that was staged consistently in the first place.

## 7. Trust model — PLANNED (v3; not implemented)

v2 certificates are honest about what they are: chain-bound (every observed
block hash is re-checkable by anyone with RPC access) and signed, with
consensus attribution where the runtime exposed it, but the **drill itself
and the recovery metrics are operator-run and operator-measured**. v3
removes reliance on operator self-reporting. None of the items below is
built; they are recorded so the v2 record format stays forward-compatible.

### 7.1 Unpredictable drills (commit-reveal on a future block hash)

- The operator (or a scheduler) first **commits** on chain: validator id,
  network, and a target block number `N` in the future (e.g. current + 20).
- Drill parameters are derived only once block `N` is finalized:
  `seed = blake2_256("kaizen:drill:v3" ‖ validatorId ‖ hash(N))`;
  fault type = `seed mod |catalogue|`, start offset = a bounded window after
  `N` derived from the next seed bytes, duration likewise.
- The certificate records `drill = { commitBlock, commitTx, seedBlock: N,
  seedBlockHash, derived: { faultType, startAfterBlocks, durationMs } }`.
  A verifier re-fetches `hash(N)`, recomputes the derivation, and checks that
  the recorded fault and its timing match. A drill run at a time or with a
  fault the seed did not select is `mismatch`.

### 7.2 Chain-observable recovery evidence

BABE/GRANDPA observations now exist (T-9.7B), but v3 adds a **verifier-side
re-derivation** of the window: first authored block after the fault,
missed slots during it, and finality resumption from public RPC, recorded as
`chainObserved` with the block range. The v2 operator-measured metrics remain
as secondary evidence.

### 7.3 Score weighting by evidence class

- Evidence classes: `chain-observed` (7.2 independently re-derived),
  `chain-bound` (v2), `self-reported` (no verifiable chain binding).
- Planned v3 weight: `w_i = decay_i · c_i` with `c = 1.0 / 0.5 / 0.1`.
  Recovery time derived from slots replaces wall-clock time when present.
- This is a new version (`RESILIENCE_SCORE_VERSION = 3`); v2 scores stay
  recomputable from v2 inputs.

### 7.4 Format compatibility

- v3 fields (`drill`, `chainObserved`, `evidenceClass`) are optional additions
  to `ChainEvidence`. The canonical JSON encoder drops `undefined` members,
  so every v2 certificate's fingerprint is unchanged.
- `KaizenResilienceRegistry` stores an `evidenceFlags` bitfield per
  certificate (bit 0 chain-bound hashes, bit 1 dev key, bit 2 seeded drill,
  bit 3 chain-observed authorship) so v3 certificates fit the same contract;
  v2 writers set bits 0–1 and, when consensus is complete, may set an
  authorship flag in a future revision.
