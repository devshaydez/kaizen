# Phase 8B + 3G Report — V3 On-Chain Run Anchoring (T-8.2) & Console Integration (T-3.6B)

**Date**: 2026-10-21 · **Context**: Portaldot Hacker House — Week 2 submission
· **Status**: T-8.2 VERIFIED (live on the V3 test network; console screen
IMPLEMENTED) · T-3.6B IMPLEMENTED (jsdom-verified; live browser smoke
pending) · Prior report archived verbatim as `docs/reports/PHASE_03F_REPORT.md`.

## 1. Task & scope

- **T-8.2** — anchor finished Failure Lab runs on the Portaldot V3 TEST
  network: deterministic run hash, `KaizenRunRegistry` contract (Solidity,
  EVM bytecode on pallet-revive) plus an explicit `remarkWithEvent`
  fallback, verify, CLI/API surfaces, and a console screen.
- **T-3.6B** — port the user's new framer-motion console design into
  `apps/web` with every screen on the real API/WS (no simulated store).
- Out of scope: incident detection (Phase 4), validator operations
  (Phase 5), Docker/K8s adapters (Phase 6), wallet-based signing (unbriefed
  T-8.x). These appear in the console as disabled, labelled affordances.

## 2. Architecture & files

- `contracts/KaizenRunRegistry.sol` + `compile-registry.mjs` + committed
  artifact; `packages/engine/src/v3/anchor/*` (canonical hash, ABI codec,
  signer, chain session with runtime dry runs, `V3AnchorService`); SQLite
  migrations 19–22; CLI `kaizen v3 …`; API `/api/v3/*` (see ARCHITECTURE §5,
  mermaid diagram of the anchoring path).
- `apps/web/src`: `App.tsx` (shell), `state/ConsoleContext.tsx`,
  `lib/model.ts` (view model), `lib/eventText.ts`, `components/{ui,
  Topology,Backdrop,NodeDrawer}.tsx`, `pages/{Landing,Create,Overview,
  Validators,Lab,Scenarios,Incidents,Deployments,V3,Settings}.tsx`, tests in
  `pages/*.test.tsx`, `lib/model.test.ts`, `test-utils/{mockApi,renderConsole}`.
- Client changes: `dryRunFault` typed (`FaultDryRunResponse`); error
  bodies without an `{error}` envelope are kept in `ApiError.details`
  (the 403 dry-run preview). Dependency: `framer-motion` 12 (the design's
  motion system; nothing else added).
- Decisions: DEC-026 (explicit, env-signed, persist-first writes), DEC-027
  (contract primary, remark explicit), DEC-028 (real data only; unbuilt
  features disabled + labelled). Risks: RSK-30 (deposit costs), RSK-31
  (arm64 host), RSK-23 updated (no browser E2E).

## 3. Acceptance criteria

| Criterion | Verdict | Evidence |
|---|---|---|
| Registry deployed on the V3 TEST network | PASS | `0x08fdadd1ebe16234c03b723255cc12fd98a5ef07`, block 136822, tx `0x2fa1c5ae…5eff30` (`docs/evidence/v3-anchors.json`) |
| Real runs anchored via contract | PASS | blocks 136899 (tx `0xa06abaa0…f8c5b7`) and 136919 (tx `0x8ae9cfc0…bd4df9`), finalized |
| Real runs anchored via remark | PASS | blocks 136940 (tx `0xa9b15505…1173ff`) and 136947 (tx `0x84027d23…774f49`), finalized |
| Verify recomputes + re-reads chain | PASS | all four re-verified via API 2026-10-21 → `verified` (TESTING §17.1) |
| Failed submissions never shown as anchored | PASS | two failed contract attempts recorded with reasons (decoder bug pre-fix; `StorageDepositNotEnoughFunds`) |
| Secrets never logged/committed | PASS | env-only signer, scrubbing tests; `.secrets/` outside the repo |
| Console V3 screen: probe, anchors + links, verify, confirmed anchor | PASS (jsdom) | `V3.test.tsx` 6/6 rendering the committed evidence; live API read smoke |
| Every console screen renders only API/WS data | PASS (jsdom) | 55 web tests; mock client only in tests |
| Destructive UI actions confirm first | PASS (jsdom) | fault execute, run/replay, remove, anchor tests assert no call before confirm |
| Full Failure Lab flow usable from the UI against a live network | NOT VERIFIED | no browser / x86_64 userland in this session (RSK-23, RSK-31) |

## 4. Commands and results (2026-10-21)

`npm run typecheck` PASS · `npm run lint` PASS · `npm run build` PASS ·
unit suite **379/379 PASS (29 files)**, run in chunks because of the
sandbox's 120 s per-command cap (TESTING §17.4). V3 live read smoke and
re-verification: TESTING §17.1.

## 5. Mocked vs live evidence

- **Live**: V3 deploy/anchor/verify (previous session, under qemu-user
  emulation for the local `portaldot_dev` network — RSK-31); V3 probe /
  status / verify re-run against the public endpoints in this session.
- **Mocked**: all web screens (jsdom with an API double primed with
  real-shaped records — the V3 test renders the committed evidence file);
  engine anchoring unit tests (fake chain transport).

## 6. Not implemented (deliberate)

Incident detection/correlation (Phase 4); staking/session keys
(Phase 5); Docker/K8s deploy + cluster connect (Phase 6); node restart
operation; peer-disconnect/partition faults (engine-blocked, R-22);
custom ring/star wiring; browser wallet signing.

## 7. Security & risks

Writes only via explicit, confirmed requests; signer in env only; runtime
dry run before every write; registry deploy CLI-only; UI holds no key.
Deployer balance ≈3.15 tPOT → contract anchoring needs a refund (RSK-30).

## 8. Cleanup

No portaldot processes were started in this session; the temporary API
process used for the live smoke was stopped. No secrets in the diff.

## 9. Remaining work & next step

1. Live UI smoke on an x86_64 host: create two-node network → Failure Lab
   pause → Scenarios run → V3 anchor (remark) → verify (promotes T-3.6B /
   T-3.6 to VERIFIED).
2. Refund the deployer for further contract anchors (RSK-30).
3. Phase 4 incident detection; Playwright smoke in Phase 7 (RSK-23).
