# Testnet publish stress + Random Sampling observability

End-to-end harness for stress-testing V10 publishing against a local DKG
node, and observing on-chain Random Sampling activity. Built and battle-tested
on Base Sepolia (chain id 84532, May 2026) but every script reads its chain
config from env vars — point them at any V10-deployed EVM testnet or mainnet.

## What's in here

| File | Role | Side effects |
|---|---|---|
| [`fetch-wikidata-music.mjs`](./fetch-wikidata-music.mjs) | Pull music-themed RDF from Wikidata's public SPARQL endpoint into partitions of ~100 triples each. | Writes `~/.dkg-publish-stress/data/music-partitions.jsonl`. Resumable. |
| [`preflight.mjs`](./preflight.mjs) | Verify the node is up and on the right chain; print wallet balances; idempotently create a public context graph for the run. | Submits one on-chain CG-create tx if the CG doesn't already exist. |
| [`approve-op-wallets.mjs`](./approve-op-wallets.mjs) | One-shot `MAX_UINT256` TRAC approval from every operational wallet to the V10 KA contract. **Workaround for [PR #720](https://github.com/OriginTrail/dkg/pull/720) — drop this step once #720 lands in `rc.12`.** | Submits one `approve` tx per op-wallet (reads `~/.dkg/wallets.json` to get the keys). |
| [`publish-loop.mjs`](./publish-loop.mjs) | The actual stress driver. Reads partitions from the JSONL, publishes each as one VM-bound KC, checkpoints every N publishes so it's crash-resumable. | Submits one publish tx per partition. Calibrate (`PHASE=calibrate`) caps at 10 publishes for cost measurement. |
| [`rs-scan.mjs`](./rs-scan.mjs) | Read-only Random Sampling observability scan. Pulls `ChallengeGenerated` / `EpochNodeValidProofsCountIncremented` / `NodeEpochProofPeriodScoreAdded` events in a rolling window and reports per-core challenge & proof submission rates, plus which of *our* published KCs are being sampled. | None — read-only. |

Every script writes its own state under `~/.dkg-publish-stress/` (data,
checkpoints, logs). Wipe that directory to start over from scratch.

## End-to-end happy path (45 minutes for 100 publishes)

```bash
# 0. (one-time, while PR #720 hasn't merged) pre-approve op-wallets so publishes
#    from zero-cost-pricing CGs don't revert with TooLowAllowance(token,0,1).
#    After #720 lands in your daemon binary, skip this step.
node scripts/testnet-publish-stress/approve-op-wallets.mjs

# 1. Pull Wikidata music partitions in the background. ~5-10 partitions/sec
#    sustained against the public endpoint. Resume-safe.
nohup node scripts/testnet-publish-stress/fetch-wikidata-music.mjs \
  > ~/.dkg-publish-stress/logs/fetch.log 2>&1 &

# 2. Pre-flight — confirm the daemon is up, wallets funded, CG registered.
#    Idempotent. Echoes the CG_ID you need to pass to publish-loop.
node scripts/testnet-publish-stress/preflight.mjs
# => CG created with id `miles-publish-stress-26may` (on-chain id: 4)

# 3. Calibrate: publish 10, measure actual cost/duration, then exit.
CG_ID=miles-publish-stress-26may \
PHASE=calibrate \
node scripts/testnet-publish-stress/publish-loop.mjs

# 4. Decide on full-run size from the calibration numbers, then go.
#    Defaults: 5000 partitions, 10s between publishes, checkpoint every 50.
CG_ID=miles-publish-stress-26may \
PHASE=main \
TARGET_PARTITIONS=5000 \
nohup node scripts/testnet-publish-stress/publish-loop.mjs \
  > ~/.dkg-publish-stress/logs/main.log 2>&1 &

# 5. While it runs, watch RS sampling activity. Re-run as often as you like.
node scripts/testnet-publish-stress/rs-scan.mjs
```

## Configuration knobs

All scripts accept overrides via env vars; see each file's top-of-file
docblock for the full inventory. The most useful for retargeting:

| Var | Default | Notes |
|---|---|---|
| `DKG_HOST` | `http://127.0.0.1:9200` | Local daemon. |
| `DKG_TOKEN_FILE` | `~/.dkg/auth.token` | First non-comment line is used. |
| `RPC_URL` | `https://sepolia.base.org` (rs-scan, approve-op-wallets) | Override for mainnet / private RPC. |
| `STRESS_RUN_ID` | `26may` | Stable id for this run. Embedded in CG short id, anchor URIs, checkpoint filename, log filenames. Bump it to start a fully isolated parallel run. |
| `TARGET_PARTITIONS` | `5000` | Hard cap on the publish loop. |
| `PUBLISH_SLEEP_MS` | `10000` | Pause between publishes; tune down to push the daemon harder, up to be gentler on the public RPC. |
| `WINDOW_HOURS` | `4` (rs-scan) | RS scan look-back window. |

## Reproducing the bugs we found

### #720 — `TooLowAllowance(token, 0, 1)` on first publish from a fresh op-wallet

Skip step 0 (`approve-op-wallets.mjs`) above and run the calibration directly.
Publishes will succeed from the first op-wallet that happened to be approved
during node init, then revert with `TooLowAllowance(token, 0, 1)` once the
round-robin reaches any unapproved op-wallet — typically by publish #3-5.
Root cause + fix: [PR #720](https://github.com/OriginTrail/dkg/pull/720).

### Rule 4 root-entity collision on real-world data

If you bypass `publish-loop.mjs`'s `buildPartitionQuads()` and submit raw
Wikidata triples directly (any reasonable corpus has recurring subjects),
the second partition referencing any reused subject reverts with:

```
HTTP 400 Rule 4 violation: rootEntity <...Q...> already exists as the root
of knowledge collection N in context graph M. Use POST /api/update to extend
the existing knowledge collection.
```

The partition-scoped blank-node rewrite in `buildPartitionQuads` is what
makes the loop work; the contract enforces "one root per KA per CG" so
real-world graphs need the rewrite at the publisher boundary. Reference and
recipe in [`packages/cli/skills/dkg-importer/SKILL.md`](../../packages/cli/skills/dkg-importer/SKILL.md)
§5 "HTTP 400 on finalize/publish with `Rule 4: rootEntity ... already exists`".

### Public RPC rate limits during the publish loop

Run the loop without [PR #684's multi-RPC failover](https://github.com/OriginTrail/dkg/pull/684)
(i.e. against `rc.11` or earlier) and watch for HTTP 500 errors quoting
`{ "code": -32016, "message": "over rate limit" }` from
`eth_getTransactionCount` / `eth_sendRawTransaction`. With `rc.12` and
`rpcUrls: [...]` configured, these vanish.

## What we learned (May 2026 stress run)

| Metric | Value |
|---|---|
| Successful publishes (after approve workaround) | 200+ (still running) |
| Cost per publish | ~0 TRAC (testnet pricing), ~3.9e-6 ETH gas |
| Avg latency per publish | ~13-15s (combined create+promote+publish) |
| Settle wait before publish | 3s needed to avoid `NO_DATA_IN_SWM` / `MERKLE_MISMATCH_IN_SWM` at quorum check |
| RS sampling visibility | 4 of our KCs sampled within 2h of mint |
| RS proof submission rate | **1/6 cores submitted valid proofs (17%)** — concerning, see linked issue |

## Mainnet caveats

These scripts target *testnet* publishing where TRAC cost rounds to zero.
For mainnet:

- **Cost accounting matters.** Calibrate carefully — at non-zero TRAC
  pricing, 5000 publishes can be expensive. `PHASE=calibrate` exists for
  this.
- **Drop `approve-op-wallets.mjs` once PR #720 ships.** It was a workaround
  for a testnet pathology; mainnet's non-zero `tokenAmount` doesn't hit the
  same auto-approve gap (though PR #720 closes the door anyway).
- **`PUBLISH_SLEEP_MS` of 10s is generous** for testnet's small validator
  set. Mainnet can tolerate tighter cadence; tune to your network's tx
  throughput.
- **Switch `RPC_URL` to a private node** for `rs-scan.mjs` and
  `approve-op-wallets.mjs`. Public endpoints rate-limit aggressively for
  any sustained `getLogs` workload.
