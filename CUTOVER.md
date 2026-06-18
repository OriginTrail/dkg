# Proof-of-Storage Content-Binding — Cutover Runbook

Bounty Finding #3 remediation. Branch `security/rs-pos-content-binding`. Pre-mainnet — **no production data to migrate**.

## Why this needs an atomic cutover (not a rolling upgrade)

The fix changes three coupled things:
1. **On-chain commitment format** — `merkleRoot` goes flat-mixed → **structured** `hashPair(publicRoot, privateDataHash)`, and `merkleLeafCount` becomes **public-only**.
2. **`submitProof` ABI** — `submitProof(bytes32 leaf, …)` → `submitProof(bytes content, …)` (the chain derives `leaf = keccak256(content)`).
3. **Prover/publisher** must speak the new format together.

A challenge issued against the OLD flat root/leafCount pins `challenge.challengeRoot` + `challenge.challengeLeafCount` + `chunkId`. After cutover the prover rebuilds against the structured root + public-only count; if `chunkId` now indexes past the public-only count, an **honest proof fails**. So the switch must be **atomic + clear outstanding challenges** — never a rolling node-by-node upgrade.

## Preconditions

- All packages built and green: dkg-core (1062), random-sampling (64, incl. on-chain e2e + bypass-revert), chain (609), publisher (structured-root consumers), evm-module (RandomSampling 33 + curated 25), agent (compiles).
- `RandomSampling` is **v10.2.0** (content-binding); publisher emits the structured root; prover/adapter submit `content` (`bytes`).

## Steps (run as one window)

1. **Freeze.** Stop publishers; pause the random-sampling prover loop on every node (or drain the current period).
2. **Redeploy `RandomSampling` v10.2.0** and register it in the **Hub** (address-swap; no delegatecall proxy). KA storage is unchanged — only the committed VALUES change from this point forward.
3. **Clear outstanding challenges.** Ensure no per-node active challenge pinned against the old flat root/leafCount survives — either an admin clear or advance the proof period so old challenges are stale and the next `createChallenge` re-pins against the structured root.
4. **Roll out the off-chain stack in lockstep** to ALL nodes: new publisher (structured root), prover (submits `content`), chain adapter (`bytes` ABI + synced `RandomSampling.json`). Every node must run the new code before re-publishing.
5. **Re-publish fixtures.** Re-publish all devnet/testnet KCs (including any `--private-file` / `privateQuads` flows) so every on-chain `merkleRoot == hashPair(publicRoot, privateDataHash)` and `merkleLeafCount` is public-only. Old flat-root KCs are abandoned — the agent verify now **rejects** non-anchored roots (the legacy `(quads, [])` fallback was removed).
6. **Unfreeze.** Resume publishing + the prover loop.

## Verification (post-cutover)

- `RandomSampling.version() == "10.2.0"` and ABI is `submitProof(bytes,bytes32[])`.
- A real prover tick → on-chain `solved == true` (the `e2e-hardhat-chain` honest path).
- An empty-proof / echo-root submission **reverts** (the `e2e-hardhat-chain` bypass-revert path) — the bypass is dead.
- Spot-check a re-published KC: `getLatestMerkleRoot(kaId)` is the structured root and `getMerkleLeafCount(kaId)` is the public-leaf count.
- Curated CGs: challenges draw the public `_catalog`; the prover submits the catalog triple bytes (`content`), proof accepts.

## Rollback

Pre-mainnet, rollback is symmetric: redeploy the prior `RandomSampling`, revert the off-chain packages, clear challenges, re-publish. No funds at risk.

## What was NOT changed (out of scope for this cutover)

- `_verifyV10MerkleProof` loop (unchanged — it already folds the extra `privateDataHash` sibling correctly).
- The picker / value-weighting / challenge issuance (unchanged — `chunkId` scoping to public leaves falls out of the public-only `merkleLeafCount`).
- The curated catalog tree (RFC-49) — already public-only; content-binding applies on submit, no structural change.
