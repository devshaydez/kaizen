# Resilience Score — specification (v1)

Status: v1 IMPLEMENTED (T-9.3); v2 trust model PLANNED (§7) — `packages/engine/src/resilience/score.ts`,
pinned by `packages/engine/test/resilience-score.test.ts`. Decision: DEC-029.

The resilience score is a **0–100 number per validator** computed from the
validator's **certified** Failure Lab runs. It is a pure, deterministic
function: anyone holding the certificates can recompute it. Kaizen never
shows a score it did not compute from certificates.

## 1. Inputs: certified runs

A certified run is a `ResilienceCertificate` (T-9.2): the finished run
record plus **chain evidence** — best and finalized heads (number + hash)
observed by a reference node before the fault, during it, and after
recovery — fingerprinted with SHA-256 over canonical JSON and signed with
the operator's sr25519 key.

Certificates whose integrity check fails (fingerprint or signature) are
**excluded**. Certificates whose chain binding is `unverifiable` (e.g. the
local network has since been stopped) still count — the score always
reports how many inputs it used, and `kaizen score --verify` shows each
certificate's verdict. Certificates signed with the public DEV key are
labelled; they prove integrity, not operator identity.

## 2. Per-run metrics (from chain evidence)

All three are derived by `computeRecoveryMetrics` from the observations
alone; a metric that cannot be derived is `null`.

| Metric | Definition |
|---|---|
| `recovered` | some after-recovery observation has a finalized number strictly greater than every finalized number observed before/during the fault (block production without finality is **not** recovery) |
| `timeToRecoverMs` | first recovered observation time − fault end time (fault start if no end was recorded) |
| `finalityGapBlocks` | max over during/after observations of `best.number − finalized.number` |
| `blocksMissed` | `floor(elapsed / expectedBlockTime) − produced`, clamped at 0, where elapsed and produced span the last before-fault to the last during-fault observation; `expectedBlockTime` defaults to 6 000 ms and is recorded in the evidence |

## 3. Formula

Per run *i*:

```
survived_i = recovered_i AND state_i ∈ {completed, completed-with-warnings}
R_i = 1 / (1 + timeToRecoverMs_i / 60 000)      null → 0
F_i = 1 / (1 + finalityGapBlocks_i / 10)        null → 0
M_i = 1 / (1 + blocksMissed_i / 10)             null → 0
q_i = survived_i ? 0.5·R_i + 0.3·F_i + 0.2·M_i : 0
w_i = 0.5 ^ (ageDays_i / 30)                    age from certification time; future → 0
```

Aggregate:

```
quality    = Σ w_i·q_i / Σ w_i                  (0 when there are no runs)
confidence = 1 − e^(−Σ w_i / 2)
score      = round(100 · quality · confidence), clamped to [0, 100]
```

Rationale:

- **Recovery time dominates (0.5)** — the question a delegator or network
  operator asks is "how fast does finality come back after this validator
  is hit?" A 60 s recovery halves R.
- **Finality gap (0.3)** measures how far finality fell behind production;
  10 blocks halves F.
- **Liveness (0.2)** penalises missed slots during the fault window; 10
  missed blocks halves M.
- **Failed runs count as 0** and still carry weight, so failures pull the
  score down rather than being ignored.
- **Recency decay (30-day half-life)** — resilience must be re-proven;
  old runs fade.
- **Confidence** stops one lucky run from scoring high: one fresh run caps
  at ≈39, five at ≈92, ten at ≈99.

Parameters are exported as `RESILIENCE_SCORE_PARAMS`; changing any of them
is a new score version (`RESILIENCE_SCORE_VERSION`).

## 4. Worked examples (pinned by tests)

"Typical" run: recovered, `completed`, ttr 12 s, gap 6, missed 6 → q ≈ 0.729.

| # | Certified runs (as of 2026-10-24) | Score |
|---|---|---|
| A | one fresh typical run | 29 |
| B | five fresh typical runs | 67 |
| C | five fresh perfect runs (0 s, gap 0, missed 0) | 92 |
| D | four fresh typical + one failed | 54 |
| E | five typical runs, all 30 days old | 52 |
| F | ten fresh perfect runs | 99 |

## 5. On-chain form

`KaizenResilienceRegistry` (contracts/) stores per-validator certificates
(fingerprint, sr25519 signer key, metrics, score, timestamp) and exposes
`getLatest` / `getScore`. The **contract does not compute the score** (no
floating point or sr25519 verification in the EVM); it stores the score
the operator computed with this spec next to the inputs, so anyone can
recompute it from the certificates and compare. The signature itself is
emitted in the `CertificateRecorded` event (not stored) and is verified
off-chain by `kaizen score --verify` / the API.

## 6. Limits (honest scope)

- Evidence comes from one reference observer node per run; a partitioned
  observer would see its own fork (verification then reports `mismatch`).
- `blocksMissed` assumes a fixed slot time; it is a liveness signal, not a
  slashing-grade measure.
- Scores from local test networks show what the validator setup survives
  under Kaizen's fault catalogue (pause, terminate); they are not a claim
  about mainnet behaviour.

## 7. Trust model — PLANNED (v2; not implemented)

v1 certificates are honest about what they are: chain-bound (every
observed block hash is re-checkable by anyone with RPC access) and signed,
but the **drill itself and the recovery metrics are operator-run and
operator-measured**. v2 removes reliance on operator self-reporting. None
of the items below is built yet; they are recorded here so the v1 record
format stays forward-compatible.

### 7.1 Unpredictable drills (commit-reveal on a future block hash)

- The operator (or a scheduler) first **commits** on chain: validator id,
  network, and a target block number `N` in the future (e.g. current + 20).
- Drill parameters are derived only once block `N` is finalized:
  `seed = blake2_256("kaizen:drill:v2" ‖ u32le(len(validatorId)) ‖ validatorId ‖ hash(N))`
  (the length prefix keeps id/hash boundaries unambiguous; implemented in
  `packages/engine/src/resilience/drill-seed.ts`, catalogue defaults to the
  real-node-verified faults `pause`, `terminate`);
  fault type = `seed mod |catalogue|`, start offset = a bounded window
  after `N` derived from the next seed bytes, duration likewise.
- The certificate records `drill = { commitBlock, commitTx, seedBlock: N,
  seedBlockHash, derived: { faultType, startAfterBlocks, durationMs } }`.
  A verifier re-fetches `hash(N)`, recomputes the derivation, and checks
  that the recorded fault and its timing (block numbers in the evidence)
  match. A drill run at a time or with a fault the seed did not select is
  `mismatch`. Operators therefore cannot pre-stage or cherry-pick a drill.

### 7.2 Chain-observable recovery evidence (preferred over operator metrics)

- **Authorship**: for each block in the window [before-fault − K,
  after-recovery + K], read the BABE pre-runtime digest (slot + authority
  index) from public RPC and map the index to the session's authority set
  (`Session.Validators` / `Babe.Authorities` at that block). Record which
  slots the validator's keys **authored** before the fault, which they
  missed during it, and the **first block authored after the fault** — the
  chain-observable recovery point.
- **Finality progress**: finalized-head numbers at the same blocks, from
  GRANDPA justifications / `chain_getFinalizedHead` history — also
  re-derivable by any verifier.
- Recorded as `chainObserved = { authoredBefore, missedSlots,
  firstAuthoredAfter: { number, hash, slot }, finalityResumedAt: { number,
  hash } }` plus the block range so a verifier can recompute it
  independently from public RPC.
- The v1 operator-measured metrics (`timeToRecoverMs`, wall-clock based)
  remain as **secondary** evidence.

### 7.3 Score weighting by evidence class

- Each run gets an evidence class: `chain-observed` (7.2 present and
  independently re-derived), `chain-bound` (v1: hashes verifiable, metrics
  operator-measured), `self-reported` (no verifiable chain binding).
- Planned v2 run weight: `w_i = decay_i · c_i` with `c = 1.0` for
  chain-observed, `0.5` for chain-bound, `0.1` for self-reported; recovery
  time derived from slots (first authored block after the fault) replaces
  the wall-clock `timeToRecoverMs` when present. Seeded drills (7.1) are
  required for the `chain-observed` class.
- This is a new score version (`RESILIENCE_SCORE_VERSION = 2`); v1 scores
  stay recomputable from v1 certificates.

### 7.4 Format compatibility

- v2 fields (`drill`, `chainObserved`, `evidenceClass`) are **optional
  additions** to `ChainEvidence`. The canonical JSON encoder drops
  `undefined` members, so every v1 certificate's fingerprint is unchanged
  and v1 verification keeps working; v2 verifiers treat their absence as
  "class = chain-bound".
- `KaizenResilienceRegistry` stores an `evidenceFlags` bitfield per
  certificate (bit 0 chain-bound hashes, bit 1 dev key, bit 2 seeded drill,
  bit 3 chain-observed authorship, bit 4 `0x10` independently attested —
  a valid attestation by a key other than the signer exists, see
  docs/ATTESTATION_SPEC.md) so v2 certificates fit the same
  contract; v1 writers set only bits 0–1.
