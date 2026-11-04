# Kaizen — Week 2 demo video (≤ 3:00)

Story: **create a real Portaldot network → watch it live → break it on purpose
→ prove the experiment on the Portaldot V3 test network.**

## Before recording

- Host: Linux x86_64 or macOS (upstream ships no linux-arm64 `portaldot_dev`;
  on arm64 only the qemu-user workaround works — RSK-31, slow on camera).
- `npm install && npm run build && node packages/cli/dist/index.js setup`.
- Start the API **with the signer in its environment** (never on screen):
  `set -a; . <path-to>/kaizen-v3-deployer.env; set +a; node apps/api/dist/index.js`
  then `npm run dev -w @kaizen/web` and open `http://127.0.0.1:5173/`.
- **Funds**: the deployer holds ≈3.15 tPOT. A contract anchor reserves ≈4 tPOT
  and will fail its dry run — **use Remark mode** for the live anchor (≈0.02
  tPOT), or only show the existing anchors. A run hash can be anchored once
  per method: pick a run that has no remark anchor yet (e.g. a run you
  complete during recording, or `run-mvim7jct-5df7ea0f` if you use the
  evidence data dir).
- **Consensus evidence**: if you show the run evidence, point at the BABE
  author and GRANDPA set-id fields, not just the block heights. Say
  "inconclusive" when the console shows it; do not narrate a validator name
  the evidence did not establish. The live CI workflow asserts those reads;
  a local drill that cannot read them records them as unavailable.
- Pre-warm: network start is health-gated and takes ~1–2 min. Either start
  a two-node network before recording and cut the wait, or record the
  create and jump-cut to "running".
- Optional pre-step so the V3 screen has a fresh run to anchor: in Scenarios,
  save `pause-alice-drill` (Pause · alice · 10 s hold) and run it once.
- Browser at 1440×900+, dark OS theme, notifications off.

## Shot list

| Time | Screen | Clicks / action | Narration |
|---|---|---|---|
| 0:00–0:15 | Landing (`/`) | Slow scroll over hero → lifecycle strip; hover the "Control plane connected" hint | "Kaizen is a node-operations platform for Portaldot: create real networks, monitor them, break them on purpose, and prove every experiment on the Portaldot V3 testnet." |
| 0:15–0:35 | Create (`/create`) | Click **Launch console** → **New network** → name `demo` → preset **2 node** → **Create network** | "One click spawns real `portaldot_dev` processes with a generated chain spec. The progress lines are live engine events — nothing scripted." |
| 0:35–1:00 | Overview (`/overview`) | (jump cut to running) Point at the two nodes, block height ticking, finalized, peer links; click **alice** to open the node drawer → scroll to logs → **Run diagnostics** → close | "Everything here is real RPC: best and finalized heads, peers observed via `system_peers`, the node's own log file, and diagnostics computed from the latest sample." |
| 1:00–1:40 | Failure Lab (`/lab`) | Fault **Pause**, target **alice**, hold **10s** → **Dry run** (preflight checks pass) → **Inject fault** → confirm. Watch topology turn amber/red and the live fault log stream (requested → executing → verifying → completed); result card shows all five claims "yes" | "Disconnect and partition are disabled because the engine can't do them reliably yet — they're labelled, not faked. Pause sends SIGSTOP to the real process; Kaizen verifies the effect over RPC, removes the fault, and independently verifies recovery." |
| 1:40–1:55 | Scenarios (`/scenarios`) | Show the saved drill + run history; click **Anchor** on the completed run | "The same faults script into replayable scenarios; every run is persisted with its evidence and can be replayed." |
| 1:55–2:40 | Portaldot V3 (`/v3`) | Probe cards show Substrate WS / EVM RPC / node console **ok** → scroll to **Anchored runs**: registry `0x08fd…ef07`, contract anchors #136899 / #136919, remark anchors #136940 / #136947 → click **Verify** on #136899 (verdict **verified**, registry code present, anchoredAt) → in **Anchor a finished run**, keep **Remark** → **Anchor run** → confirm → wait for "remark anchor finalized in block #…" | "Each finished run is fingerprinted — SHA-256 of its canonical record — and written to Portaldot V3, either through our KaizenRunRegistry contract on pallet-revive or as a remark. Verify recomputes the hash and re-reads the chain." |
| 2:40–2:55 | Node console (new tab) | Click the block number link of the new anchor (or #136899) → node console block page shows the extrinsic + events | "Anyone can check it on the public Portaldot node console." |
| 2:55–3:00 | Back to console / end card | GitHub URL `github.com/Shaydez-Defi/kaizen` | "Kaizen — break it on purpose, prove it on chain." |

## Fallbacks during recording

- Anchor fails (balance / endpoint): keep the take — the console records the
  attempt as **failed** with the reason; switch to showing the existing
  finalized anchors + Verify.
- V3 endpoint slow: the probe and verify calls are bounded (60 s); cut the wait.
- Network won't start on camera: use the pre-started network (selector in the
  top bar).
