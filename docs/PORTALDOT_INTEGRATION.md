# Portaldot Integration — consensus, evidence, and anchoring

Status: written 2026-11-04 (T-9.7). This document separates what Kaizen
**implements**, what is **verified**, and what is **planned**. It does not
claim a live-network result that has not been run.

Verification vocabulary used here:

- **IMPLEMENTED** — code exists and has offline tests.
- **VERIFIED** — the stated acceptance was executed and the result recorded
  (live runs are named).
- **PARTIAL** — some reads/paths work; the named part is unverified.
- **PLANNED** — designed only; no code.

## 1. Summary

| Area | State | Where |
|---|---|---|
| Read-only validator discovery (`session.*`, `babe.*`, `grandpa.*`, staking era) | IMPLEMENTED, live run NOT executed in this environment | `packages/engine/src/resilience/discovery.ts`, `consensus-runtime.ts` |
| BABE authorship from the block's pre-runtime digest | IMPLEMENTED, offline-tested | `consensus.ts` |
| GRANDPA `setId` tracking and transition classification | IMPLEMENTED, offline-tested | `consensus.ts`, `evidence.ts` |
| Evidence recomputation / outcome classification | IMPLEMENTED, offline-tested | `integrity.ts` |
| Certificate evidence hash + verification verdicts | IMPLEMENTED, offline-tested | `certificate.ts`, `verify.ts` |
| Score v2 eligibility/coverage | IMPLEMENTED, offline-tested | `score.ts` |
| V3 run anchoring (EVM registry + remark) | VERIFIED live on V3 test (T-8.2, 2026-10-21) | `packages/engine/src/v3/anchor/*` |
| Anchoring verification (chain id, address, receipt, record) | IMPLEMENTED, offline-tested; live re-check NOT run in this change | `v3/anchor/service.ts` |
| `KaizenResilienceRegistry` (Solidity/EVM) | IMPLEMENTED, **UNDEPLOYED** (RSK-30) | `contracts/KaizenResilienceRegistry.sol` |
| ink!/pallet-contracts registry | **NOT PRESENT in this repository** | — |
| Certificate-fingerprint anchoring in CI demo (`remarkWithEvent`) | IMPLEMENTED in the demo script; not an engine API | `scripts/demo/publish-drill.mjs` |

## 2. BABE evidence methodology

### 2.1 Authorship is read, not derived from a slot rotation

Every BABE block header carries a pre-runtime digest. The SCALE layout
(Substrate `sp_consensus_babe::digests`) is a variant byte followed by
`authority_index: u32` and `slot: u64`:

| codec index | variant |
|---|---|
| 1 | `Primary` (VRF) |
| 2 | `SecondaryPlain` |
| 3 | `SecondaryVRF` |

Kaizen decodes that digest and uses the **encoded `authority_index`** as the
author. It never computes an author from `slot / period`. The earlier
uncommitted implementation did that; it was removed because an invented
rotation can silently name the wrong validator.

### 2.2 The applicable authority set

The authority set is read from the **state of the block being attributed**
(`babe.authorities` at that block hash), together with:

- `babe.epochIndex` — epoch number;
- `babe.epochStart` — `(sessionIndex, startSlot)`;
- `babe.epochDuration` — epoch length in slots (runtime constant);
- `babe.randomness` — epoch randomness.

The block's slot must fall inside `[startSlot, startSlot + duration)`. If the
epoch bounds cannot be read, the authorship is still recorded but the
evidence notes that membership was not checked; if the slot is outside the
bounds, the attribution is `inconclusive` because the observed set is not
the block's epoch set.

### 2.3 Secondary-slot cross-check

For `SecondaryPlain` / `SecondaryVRF`, Kaizen recomputes the Substrate rule

```
index = U256::from_big_endian(blake2_256(randomness ++ slot_le_u64)) % authorities_len
```

If the digest's `authority_index` disagrees with this computation, the
observed authority set is not the block's epoch set. The record is
`inconclusive` and **no validator id is emitted**. This is the protection
against attributing a production failure to the wrong authority set.

Primary slots cannot be cross-checked without verifying the VRF proof
against every candidate key; Kaizen records `verification: 'digest'` and does
not claim the stronger check.

### 2.4 Authority key → validator account

`babe.authorities` publishes consensus keys, not account ids. Kaizen maps
them through `session.queuedKeys` (current session) and
`session.nextKeys` (next session), comparing raw key bytes. If no mapping
exists, the authorship remains `authored` (the authority key is known) but
`validatorId` is null and the evidence is marked incomplete with that
reason. Kaizen does not guess an account.

### 2.5 Session, epoch, and transition handling

- Each authorship record stores the epoch, epoch start/duration,
  `authoritySetId`, authority key and validator id.
- The evidence stores every authority set used for attribution, so a reviewer
  can re-check the key list and epoch bounds.
- BABE epoch transitions observed during capture are stored as
  `babeEpochTransitions` (from epoch, to epoch, block).
- Historical blocks are always read at that block's hash. Kaizen never
  substitutes the current authority set for a historical one; if the node
  cannot answer at that hash, the result is `unavailable`/`inconclusive`.

### 2.6 Era and staking are context, not identity

Era information (`staking.activeEra`, `staking.erasRewardPoints`) is exposed
as context for elections/rewards. It is **never** used to decide BABE
authorship. Era points, when readable, are recorded next to the consensus
context; when staking is absent, the field is null and the read is listed as
unavailable.

## 3. GRANDPA evidence methodology

Each finality observation records the best/finalized heads, the finalized
block, `grandpa.currentSetId` at the observation, the authority count, the
lag in blocks, and a classification:

| classification | meaning |
|---|---|
| `normal` | lag ≤ `DEFAULT_EXPECTED_FINALITY_LAG_BLOCKS` (5) |
| `expected-transition` | lag above the threshold at/around a recorded `setId` change, or a change spanning the observation |
| `stalled` | lag above the threshold with no transition evidence |
| `unknown` | set id unreadable — never treated as a validator failure |

Set changes are recorded with `fromSetId`, `toSetId`, finalized block and
time. The history is validated for duplicates, non-increasing ids, and
missing previous ids. Classification is recomputed at evidence finalisation
with the run's full transition history plus any pre-drill transitions the
source observed, because a set change shortly before the drill still
explains finality settling during it.

**Not claimed:** GRANDPA vote-level evidence. Kaizen records finality
observations and set ids, not individual precommits; it cannot prove which
validator withheld a vote.

## 4. Runtime queries

Discovery uses `@polkadot/api` over an HTTP provider (read-only, no
subscriptions, no writes). One snapshot is cached per block hash; a
no-argument snapshot reuses the cache while the best block is unchanged.

| Query | Purpose | On failure / absence |
|---|---|---|
| `session.validators` | current validator accounts | null + `unavailable` |
| `session.queuedKeys` | account → current session keys | null + `unavailable` |
| `session.nextKeys` (entries) | next-session accounts/keys | null + `unavailable` |
| `session.currentIndex` | session number in evidence | null |
| `babe.authorities` | epoch authority keys/weights | null; attribution inconclusive |
| `babe.epochIndex`, `babe.epochStart`, `babe.epochDuration`, `babe.randomness` | epoch bounds + secondary rule | null; the corresponding check is skipped and noted |
| `grandpa.authorities` | set size/context | null |
| `grandpa.currentSetId` (fallback `grandpa.state`) | set-id tracking | null; lag `unknown` |
| `staking.activeEra`, `staking.erasRewardPoints` | era context only | null + `unavailable` |

Malformed values are coerced through explicit shape checks and return null;
they are never guessed. The polling stance (~1 request per block) is
mentor guidance; the engine now guarantees at most one snapshot per block,
but endpoint load has not been measured by Kaizen.

## 5. Evidence and certificate integrity

- Recovery metrics are recomputed from the observations at verification time
  and compared with the stored values (`checkEvidenceIntegrity`).
- Block references, `finalized ≤ best`, phase order, fault-window ordering
  and derivable metrics are checked.
- A drill is `passed` (finality advanced, all metrics derivable), `failed`
  (observed no recovery, or terminal failed run), or `inconclusive`
  (tampered, contradictory, or incomplete evidence).
- Certificates carry an `evidenceHash` and `outcome`. They are outside the
  signed fingerprint document (so v1 certificates still verify), but
  verification recomputes and compares them.
- Verification verdicts: `verified`, `mismatch` (fingerprint/signature/
  evidence tampering, chain fork, failed transaction), `unverifiable`
  (network/EVM RPC unreachable), `inconclusive` (valid signature + verified
  chain, but incomplete evidence or incomplete consensus context).
- A valid signature proves integrity and control of the signing key. It does
  not prove the operator is trustworthy, that the drill was not staged, or
  that the validator is reliable in general.

## 6. Contract architecture evaluation

### 6.1 Inventory (evidence, not intention)

| Artifact | State | Evidence |
|---|---|---|
| `KaizenRunRegistry.sol` | **deployed on Portaldot V3 test** via pallet-revive; contract anchors at blocks 136899 / 136919, remark anchors 136940 / 136947 | `docs/PROGRESS.md` 2026-10-21; `docs/evidence/`; API re-verification |
| `KaizenResilienceRegistry.sol` | implemented, reproducible artifact, codec, in-memory EVM tests; **not deployed** | `contracts/`, `resilience-registry.test.ts` (7), `contracts/test-resilience-registry.mjs` 6/6; RSK-30 |
| ink!/pallet-contracts registry | **no source, artifact, or deployment record in this repository** | repository inventory 2026-11-04 |

### 6.2 Documentation correction

The README and DEC-031 previously stated that a 6.8 KB ink! registry was
deployed on V3 with measured deposits (~548 tPOT upload+instance, ~1.4 tPOT
per anchor). **No ink! source, build artifact, or deployment record exists
in this repository**, and no recorded transaction evidences that deployment.
Those figures are therefore treated as **UNVERIFIED** here. The README has
been corrected to describe the actual deployed path (Solidity → EVM bytecode
on pallet-revive) and the undeployed resilience registry. DEC-031 carries an
addendum rather than a rewrite of the original decision.

### 6.3 revive/EVM vs ink!/pallet-contracts

Portaldot feedback recommends **revive** for EVM-oriented development and
notes that ink! is supported. The official ink! documentation states that
active maintenance and development ceased from January 2026
(<https://use.ink/docs/v6/faq/>).

| Criterion | revive + Solidity/EVM (current) | ink! + pallet-contracts |
|---|---|---|
| Existing Kaizen code | deployed `KaizenRunRegistry`, ABI codec, artifacts, live anchors, `reviveApi` dry-run | none in repo |
| Toolchain | `solc` bytecode accepted by `revive` (`allowEVMBytecode` observed live) | Rust + `cargo-contract` |
| Ecosystem direction | recommended by Portaldot feedback | maintenance ended Jan 2026 |
| Migration cost now | zero | new artifact, codec, dry-run path, tests, deployment, audit |
| Interface preservation | current deployed interface stays | new interface; old anchors remain on EVM path |
| Storage deposits | measured for run registry (see §7) | unmeasured here; claimed numbers unverified |

**Decision (proposed, not executed): retain revive/EVM.** There is no
working ink! deployment to preserve, the EVM path is the one already
deployed and verified, and the ink! maintenance horizon argues against
adopting it now. No migration is performed. If Portaldot later mandates
pallet-contracts or removes revive, the registry is isolated behind
`V3AnchorService`, so the change is bounded to that boundary (as DEC-031
already anticipated).

## 7. Anchoring economics

All figures below are **recorded from live V3 test runs** (RSK-30, T-8.2) or
explicitly labelled as estimates. They are not re-measured in this change.

| Operation | Observed cost | Confidence |
|---|---|---|
| Deploy `KaizenRunRegistry` (code + storage deposit) | ≈85 tPOT | measured from signer balance delta, 2026-10-21 |
| Contract anchor (`revive.call` + storage deposit) | ≈4 tPOT | measured from balance delta |
| Remark anchor (`system.remarkWithEvent`) | ≈0.02 tPOT | measured from balance delta |
| Deploy `KaizenResilienceRegistry` | **not measured** (undeployed; deployer balance ≈3.15 tPOT, RSK-30) | unknown |
| Per-certificate record in `KaizenResilienceRegistry` | **not measured**; structurally similar to a contract anchor (one record + one event) → order of a few tPOT, not a quote | estimate only |

Recurring certificate anchoring is the cost that matters. Options, in order
of implementation risk:

1. **Remark per certificate (current demo):** ~0.02 tPOT, already exercised;
   no registry state, but the fingerprint is visible in the block and
   verifiable. Cheapest, weakest queryability.
2. **Per-certificate contract record (implemented, undeployed):** a few tPOT
   each; queryable per validator/score. Blocked by the deployer balance and
   the undeployed duplicate-fingerprint design (T-9.4).
3. **Batched anchoring (PLANNED):** one transaction anchors a Merkle root of
   N certificate fingerprints; each certificate carries an inclusion proof.
   Storage deposit is paid once per batch, so per-certificate cost falls
   roughly with N (minus proof verification). This needs a new registry
   function and is **not implemented or deployed**.
4. **Off-chain evidence + on-chain root only:** store full certificates in
   the public demo bundle, anchor one root per drill cycle. Same as (3) with
   a different cadence.

No batching code or contract change is included in this task; changing a
deployed interface requires explicit authorization.

## 8. Anchoring verification (read-only)

`V3AnchorService.verify(anchorId)` now checks and reports:

| Check | Field |
|---|---|
| recorded run hash equals a fresh `computeRunHash` | `hashMatches`, `recomputedRunHash` |
| block hash at the recorded height | `blockHashMatches` |
| EVM chain id vs configured expected id | `evmChainId`, `chainIdMatches` |
| registry address is H160 and the current/recorded registry | `contractAddressMatches` |
| registry `anchoredAt(runHash)` > 0 / remark text equals payload | `onChainRecordMatches` |
| non-empty code at the registry (`eth_getCode`) | `contractCodePresent` |
| transaction exists in the recorded block and succeeded | `txHashMatches`, `txSucceeded` |
| `RunAnchored(runHash)` log when logs are available | folded into `onChainRecordMatches` |

A missing transaction, failed dispatch, wrong chain id, unknown registry,
missing on-chain record, or a fork makes the verdict `mismatch`; an
unreadable endpoint makes it `unverifiable`. The check is read-only: no
deployment, no transaction, no interface change.

**Not implemented:** an engine API to verify the demo's certificate-fingerprint
remark. That remark is produced and recorded by
`scripts/demo/publish-drill.mjs`; its verification is currently manual/
bundle-level, not an `engine.v3Anchors` method.

## 9. Reproducible CI drill

`.github/workflows/resilience-live.yml` (x86_64) runs a real two-node
`portaldot_dev` network, pauses a validator, captures chain + consensus
evidence, certifies with the public dev key, verifies online and offline,
and uploads the certificate/verification/score artifacts. The live test now
also asserts that `session.validators`, `babe.authorities` and
`grandpa.authorities` are readable and that the observed best block is
attributed to a validator account. **This workflow has not been run for this
change in the local arm64 sandbox**; its result must be read from the PR's
CI run, not assumed.

## 10. Known limitations and manual steps

- Live consensus reads and live anchoring re-verification are **unverified**
  until the x86_64 workflow runs. If `session.nextKeys` or
  `staking.erasRewardPoints` are absent, the evidence records them as
  unavailable; if `session.queuedKeys` is absent, authorship has no
  validator account and is marked incomplete.
- GRANDPA evidence is finality/set-level, not vote-level.
- The deployed run registry uses EVM bytecode on revive; the resilience
  registry remains undeployed. Any deployment requires a funded signer and
  explicit authorization.
- Certificate-fingerprint anchoring exists only in the demo script; the
  engine does not expose a verifier for it.
- No mainnet interaction of any kind is performed or supported.
