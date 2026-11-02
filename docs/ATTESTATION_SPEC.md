# Attestation spec (A2)

An attestation is an **independent third-party verification statement**
attached to a resilience certificate. It is signed by a verifier key that
is **NOT** the certificate signer, saying the verifier re-verified the
certificate against chain data.

## Signed statement

The attester signs with sr25519 the domain-separated message:

    kaizen:attestation:v1:<certificateFingerprint>:<verdict>:<checkedAtISO>

- `certificateFingerprint` — the certificate fingerprint (`0x` + SHA-256 of
  the canonical certificate document, docs/RESILIENCE_SCORE.md).
- `verdict` — one of `verified` or `mismatch`.
  - `verified`: the verifier re-fetched every observed block hash (best,
    finalized, genesis when recorded) from the network and everything
    matched, i.e. `verifyCertificate` returned `verified`.
  - `mismatch`: any integrity failure, hash difference, or an unverifiable
    network. An attestation NEVER upgrades a certificate on its own; a
    `mismatch` verdict is recorded, not hidden.
- `checkedAtISO` — when the verifier re-checked, ISO-8601 UTC.

## Attestation record

    {
      "kaizenAttestation": 1,
      "certificateFingerprint": "0x…",
      "verdict": "verified",
      "checkedAt": "2026-10-29T00:00:00.000Z",
      "attester": {
        "address": "5FHn…",          // SS58 prefix 42, display only
        "publicKey": "0x…",          // 0x + 32-byte sr25519 key
        "scheme": "sr25519",
        "source": "env",             // env | file | dev
        "dev": false,
        "signature": "0x…"           // 0x + 64-byte signature
      }
    }

## Independence and validity (`checkAttestation`)

An attestation is VALID only when ALL hold:

1. shape: `kaizenAttestation: 1`, a known verdict, ISO-8601 `checkedAt`;
2. binding: `certificateFingerprint` equals the certificate fingerprint;
3. freshness: `checkedAt` is not in the future at check time and not
   older than 30 days (`ATTESTATION_MAX_AGE_DAYS`) — expired or replayed
   statements are invalid, never upgraded;
4. independence: the attester `publicKey` differs from the certificate
   signer key. A self-attestation is refused (`ATTESTATION_SAME_KEY` on
   issue, invalid on check);
5. authenticity: the sr25519 signature verifies over the message above,
   and the SS58 address matches the attester public key.

Invalid or same-key attestations are ignored and listed in the score
notes (`<fingerprint>: attestation by <address> excluded (<reason>)`).

## Effect on scoring (score v2)

A certificate with at least one valid attestation (different key,
`verdict: verified`) counts as **attested**: its evidence-class factor is
1.0, the same as `signed-chain-verified`. This never overrides an invalid
signature — an unsigned certificate stays `unsigned` (0.4).

## Effect on the anchor path

When a valid attestation exists, the registry record sets evidence flag
bit 4 (`0x10`, `independentlyAttested`) in the existing `uint8`
`evidenceFlags` bitfield (docs/RESILIENCE_SCORE.md §7.4). No contract ABI
changes; the deployed `KaizenResilienceRegistry.record` already carries
the full byte.

## Storage and portability

- State store: `resilience_attestations` table, one row per
  (fingerprint, attester) pair; re-attesting by the same key replaces its
  record. Backward compatible (append-only migration).
- Exported certificate bundles may carry `attestations: [...]`;
  `kaizen verify-certificate --bundle` lists them. Verification of each
  attestation is `checkAttestation`, always independent of the chain
  check of the certificate itself.

## Keys and secrets

The attester key comes from `KAIZEN_ATTESTER_SURI` (or
`KAIZEN_ATTESTER_SURI_FILE`, which must point outside the working
directory). There is NO dev fallback for attestations: an attestation
only means something from a configured independent key. The secret is
never logged, persisted, committed or printed; only the public address
and key leave the signer loader.

## CLI

    kaizen attest <fingerprint> [--rpc <url>]
    kaizen verify-certificate <fingerprint|--bundle f.json> [--rpc <url>]

`attest` re-verifies (with `--rpc`, else the running network, else the
chain check is unverifiable -> `mismatch`) and signs. It does NOT spend
tPOT and never anchors anything.
