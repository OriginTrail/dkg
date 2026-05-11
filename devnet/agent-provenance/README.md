# Agent-provenance devnet validation runbook

End-to-end validation for the agent-provenance work shipped in PR #436
(`feat/agent-provenance-onchain-attestation`). Walks an operator
through standing up a 5-node devnet (4 core + 1 edge), exercising the
four operating modes from the spec §4, and capturing the artefacts
the §9.7 cross-cutting checklist needs as evidence.

## Automated test suites

Two automated suites cover the same surface this runbook describes —
prefer running them before falling back to the manual recipes below.

| Suite | Scope | Runtime | Command |
| --- | --- | --- | --- |
| Hardhat e2e | All 10 sequence diagrams from `RFC-001-implementation-walkthrough.md` (incl. Phase 4 author override + pre-signed AuthorAttestation), run against an in-process Hardhat EVM. Covers contract correctness + publisher integration in a single process. | ~30s | `pnpm test:e2e:agent-provenance` |
| 5-node devnet | All 4 modes (a/b/c/d) + negative case from §4 + §9.5, run against `./scripts/devnet.sh start 5`. Mode (b) registers a custodial agent on core 2 and validates `KC.author = agent.wallet` while `publisherNodeIdentityId = core2.id`. | ~35s after devnet is up | `pnpm test:devnet:agent-provenance` |

Phase 4 author override (RFC §4(b)) is now wired end-to-end via the
agent-keystore: end-user agents register on a daemon (`POST
/api/agent/register`) and publish through that daemon's
`/api/shared-memory/publish` route. The route resolves the bearer
token to an `AgentKeyRecord`, looks up the custodial private key, and
threads it into the publisher as `authorPrivateKey` so the on-chain
`AuthorAttestation` is signed by the *agent*, not the daemon. See
diagrams 9–10 in `RFC-001-implementation-walkthrough.md` for the full
sequence; see the `(b)` recipe below for the manual equivalent.

The devnet suite expects an already-running devnet (boot once, run
many times). To opt into auto-boot+teardown for nightly CI, set
`DKG_DEVNET_AUTO_BOOT=1` before invoking the script — adds ~90s of
bring-up to the run.

The remainder of this document is the original manual runbook,
preserved for one-off debugging and as the source of truth on what
each mode is meant to assert.

The intent is to give a human operator a concrete, copy-paste-able
sequence per mode, including:

- **Setup** — what fixtures (PCAs, `authorizedKeys`, identities) the
  mode requires before any `publish` call.
- **Action** — the actual `dkg publish` (or HTTP) call.
- **Assertions** — the on-chain reads + log checks that ratify the
  mode succeeded with the right authorship / attribution / payment
  shape.

The four modes are taken verbatim from the spec §4 and §9.5; the
acceptance criteria in §9.7 #1, #6-#9 are folded into the per-mode
"assertions" sections.

## Bring-up

The repo already ships a Hardhat-based devnet. Re-using it.

```bash
# from repo root
pnpm run build:runtime:packages  # ensure dist/ is current with this branch
./scripts/devnet.sh clean        # wipe any prior state
./scripts/devnet.sh start 5      # 4 core + 1 edge (the "edge" is just
                                 # node5 with hostingNodes=[] later)
./scripts/devnet.sh status       # confirm 5 daemons + hardhat are up
```

### Driving CLI commands per node

The `dkg` CLI resolves its target daemon from `$DKG_HOME` (and reads the
auth token from `<DKG_HOME>/auth.token`) plus `$DKG_API_PORT`. The
`./scripts/devnet.sh start` command leaves each node's data dir under
`.devnet/nodeN/` with both files in place, so a one-liner suffices:

```bash
# alias for "drive the CLI as node N"
node1() { DKG_NO_BLUE_GREEN=1 DKG_HOME="$PWD/.devnet/node1" DKG_API_PORT=9201 \
            node packages/cli/dist/cli.js "$@"; }
node5() { DKG_NO_BLUE_GREEN=1 DKG_HOME="$PWD/.devnet/node5" DKG_API_PORT=9205 \
            node packages/cli/dist/cli.js "$@"; }
```

`DKG_NO_BLUE_GREEN=1` bypasses the auto-update / installed-binary
resolver so the CLI invocation runs against the local source build —
required while this PR is on a feature branch (the npm-published `dkg`
binary doesn't ship the new `pca` subcommand yet).

A globally-installed `dkg` (`/Users/...nvm.../bin/dkg` or
`~/.local/bin/dkg`) WILL work with this branch only after
`pnpm install -g packages/cli` is rerun on top of `pnpm run build:runtime:packages`.

Note on edge vs core: the daemons are identical binaries; what
makes a daemon "edge" in the spec sense is having an empty
`hostingNodes` set on its CG. The Phase 1 contract change
(`ContextGraphStorage.sol` — drop the `hostingNodes.length == 0`
revert) is what unblocks this. In the runbook we treat **node5** as
the edge.

After bring-up, sanity-check the agent-provenance contract changes
landed in the deployed bytecode:

```bash
node scripts/verify-agent-provenance-deployment.mjs
```

(see `scripts/verify-agent-provenance-deployment.mjs` below — it
replays the Phase 5 acceptance ABI checks against the `localhost`
deployment.)

## Per-mode recipes

Each mode produces a transcript at
`devnet/agent-provenance/<mode>.transcript.md`. The
transcript template is `transcript.template.md`; copy it, fill in
the holes from the daemon log + on-chain reads.

### (a) Self-publishing edge attributed to home core (PCA path)

> **Spec §4(a) / §9.5(a):** Edge wallet on core 1's PCA
> `authorizedKeys`. Edge publishes; core 1's PCA discount applies;
> on-chain `author = edge.agent`, `publisherNodeIdentityId = core1.id`,
> `publisherAddress = edge.publisher`.

```bash
# Fixture (one-time)
node1 pca create --tokens 100000 --epochs 12
# → records accountId (typically 1 on a fresh devnet); save for next step

# Authorize node5's publisher EOA on the PCA. Read it from node5's
# wallets.json (look for the publisher / submitter wallet, NOT the agent
# identity — the wallet that calls msg.sender into KAv10):
NODE5_PUBLISHER=$(jq -r '.adminWallet // .publisher // .wallet' .devnet/node5/wallets.json)
node1 pca authorize 1 "$NODE5_PUBLISHER"
node1 pca info 1 --probe-key "$NODE5_PUBLISHER"
# → expect `probedKey.authorized: true`

# Action
node5 publish <cgId> \
  --file devnet/agent-provenance/turns/turn-a.nq \
  --publisher-node-identity-id 1     # core1's identityId on this devnet
```

**Assertions** (capture into the transcript):

- `KnowledgeCollectionStorage.getLatestMerkleRootAuthor(kcId) ==
  edge.agent.wallet.address` (matches §9.7 #1).
- `getLatestMerkleRootPublisher(kcId) == edge.publisher` (the EOA
  that called `publish`, i.e. `msg.sender`).
- `KnowledgeCollectionCreated(kcId, indexed author=edge.agent, ...)`
  log entry present in the receipt.
- Core 1's PCA epoch allowance decremented by ≥ the discounted fee
  (read via `PublishingConvictionAccount.epochAllowance`).
- `dkg:Publication` triple present in CG meta graph: `<urn:dkg:kc:N>
  dkg:authoredBy "<edge.agent.wallet.address>"`.
- `/api/kc/<kcId>/author` returns `{author: <edge.agent.address>,
  attested: true}`.

### (b) Publisher-as-a-service via core 2 PCA

> **Spec §4(b) / §9.5(b):** Core 2 runs a publisher service; its
> submitter EOA is on its OWN PCA `authorizedKeys`; agents on
> devnet route publishes through it. `author = end-user.agent`,
> `publisherNodeIdentityId = core2.id`, `publisherAddress =
> core2.publisher`.

```bash
# Fixture (one-time) — register a custodial agent on core 2.
# Returns { agentAddress, authToken, privateKey } the first time.
AGENT_TOKEN=$(curl -s -X POST \
  -H "Authorization: Bearer $(cat .devnet/node2/auth.token)" \
  -H "Content-Type: application/json" \
  -d '{"name":"mode-b-agent","framework":"phase4-runbook"}' \
  http://127.0.0.1:9202/api/agent/register | jq -r .authToken)

# Action — end-user agent writes quads + publishes through core 2,
# authenticating with its OWN bearer token. The daemon resolves the
# token → agent → custodial privateKey → AuthorAttestation signer.
curl -s http://127.0.0.1:9202/api/shared-memory/write \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "contextGraphId": "<cgId>",
        "quads": [{
          "subject": "urn:test:mode-b:1",
          "predicate": "https://schema.org/name",
          "object": "\"mode-b\"",
          "graph": "did:dkg:context-graph:<cgId>"
        }]
      }'

curl -s http://127.0.0.1:9202/api/shared-memory/publish \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "contextGraphId": "<cgId>", "selection": "all", "clearAfter": true }'
```

Optional: register on core 2's PCA so the publish is discounted (this
mirrors the spec wording where core 2's submitter EOA sits on its own
PCA `authorizedKeys`). Without the PCA fixture the publish still
succeeds; core 2's publisher wallet just pays the full TRAC fee.

```bash
node2 pca create --tokens 200000 --epochs 12
NODE2_PUBLISHER=$(jq -r '.adminWallet // .publisher // .wallet' .devnet/node2/wallets.json)
node2 pca authorize <accountId_from_create> "$NODE2_PUBLISHER"
```

**Assertions:** same shape as (a), substituting core 2 for core 1
and `end-user.agent` for `edge.agent`. Verifies §9.7 #6
("publisher-service flow with zero-ETH zero-TRAC edge").

### (c) Same-operator edge + core, no PCA (direct-spend with attribution)

> **Spec §4(c) / §9.5(c):** Edge and core 3 share an operator;
> core 3 has no PCA; edge publishes naming `core3.id` for
> attribution; pays full TRAC from edge wallet.

```bash
# Fixture: nothing — no PCA needed for this mode.

# Action
node5 publish <cgId> \
  --file devnet/agent-provenance/turns/turn-c.nq \
  --publisher-node-identity-id 3     # core3's identityId on this devnet
```

**Assertions:** §9.7 #7 ("direct-spend with self-claimed
attribution"):

- Edge wallet TRAC balance decremented by full fee (no discount).
- Core 3's publishing-factor counter incremented (read via the
  RandomSampling / scoring storage).
- On-chain `author = edge.agent`, `publisherNodeIdentityId =
  core3.id`.
- `PublishingConvictionAccount.epochAllowance` for core 3
  unchanged (no PCA was drawn down).

### (d) Unattributed self-publishing edge

> **Spec §4(d) / §9.5(d):** Edge has no PCA authorization;
> `publisherNodeIdentityId = 0`; pays full TRAC from its own
> wallet; no core gets attribution.

```bash
# Fixture: none.

# Action
node5 publish <cgId> \
  --file devnet/agent-provenance/turns/turn-d.nq \
  --publisher-node-identity-id 0
```

**Implementation note — `--publisher-node-identity-id 0` is a real on-chain publish.**
The publisher's gate distinguishes "no override" (use the daemon's own
identityId, skip on-chain when that's `0`) from "explicit override = `0n`"
(go on-chain with no attribution; the contract validates and accepts).
Reviewer feedback: the gate previously skipped on-chain whenever the
attribution target was `0n` regardless of how it got there, so mode (d)
silently fell back to a tentative SWM-only publish. Fixed in this PR
by threading `publisherNodeIdentityIdOverride` as a per-call publisher
option — explicit `0n` proceeds on-chain.

**Assertions for mode (d):**

- Edge wallet TRAC balance decremented by full fee.
- No core's publishing-factor counter incremented:
  `EpochStorage.getNodeEpochProducedKnowledgeValue(coreId, epoch)` is
  unchanged across all known core identityIds.
- `KnowledgeCollectionCreated` event has `author = edge.agent`,
  emitted with `publisherNodeIdentityId = 0` (verifiable via the
  `merkleRoots` accessor: the on-chain attribution field is `0`).
- `dkg publish` returns `Status: confirmed` (not `tentative`).

### Negative case: unauthorized PCA fall-through

> **Spec §9.7 #9:** Publisher names a core that has a PCA but
> `msg.sender` is *not* on `authorizedKeys`. Publish succeeds via
> the direct-spend branch; the named core gets attribution; the
> PCA is *not* drawn down.

```bash
# Fixture: core 1 still has the PCA from mode (a). DON'T add the
# new edge wallet to core 1's authorizedKeys.

# Action — publish from a fresh wallet not on the allowlist.
# Use `dkg publisher wallet add <pk>` on node5 first to enroll a
# fresh signing wallet, then drive `dkg publish`. Do NOT pass that
# fresh wallet through `node1 pca authorize` — that would defeat
# the purpose. Verify with `node1 pca info 1 --probe-key <addr>`
# that `authorized: false` BEFORE the publish.
node5 publish <cgId> \
  --file devnet/agent-provenance/turns/turn-fallthrough.nq \
  --publisher-node-identity-id 1     # core1's identityId on this devnet
```

**Assertions:**

- `PublishingConvictionAccount.epochAllowance` for core 1 unchanged.
- Edge wallet TRAC balance decremented by full fee (no discount).
- Core 1's publishing-factor counter still incremented (attribution
  preserved).

## Quick smoke check (run this first)

Before driving any of the four modes, confirm the new operator surface
is wired up correctly. This three-step smoke test takes < 30s and
validates the full pipeline (CLI → daemon → chain → event read-back):

```bash
# 1. Stand up a PCA on node1
node1 pca create --tokens 100000 --epochs 12
# → expect: accountId=1, tx hash, block number

# 2. Authorize a random address and verify it's on chain
TARGET=$(node -e "console.log(require('ethers').Wallet.createRandom().address)")
node1 pca authorize 1 "$TARGET"
node1 pca info 1 --probe-key "$TARGET"
# → expect: probedKey.authorized: true, discountBps ~1428 (14.28%)

# 3. Publish without attribution to confirm --publisher-node-identity-id
#    threads through (this exercises the override-and-restore plumbing)
echo '<urn:test:1> <https://schema.org/name> "smoke" .' > /tmp/smoke.nq
node1 publish smoke-test --file /tmp/smoke.nq --publisher-node-identity-id 0
# → expect: Status: tentative (NOT confirmed; daemon log shows "Identity
#   not set (0) — skipping on-chain publish")
node1 publish smoke-test --file /tmp/smoke.nq
# → expect: Status: confirmed, valid kcId, valid txHash
#   (the publisher's identity was restored after the override)
```

If steps 1-3 produce the expected output, the operator surface is
working and you can proceed to the per-mode recipes below.

## Final §9.7 sweep

Once all four modes (and the unauthorized-PCA fall-through) have
clean transcripts, run the static cross-cutting suite to confirm
nothing regressed during devnet bring-up:

```bash
pnpm --filter @origintrail-official/dkg-chain test \
  test/agent-provenance-cross-cutting.test.ts

pnpm --filter @origintrail-official/dkg test \
  test/kc-author-route.e2e.test.ts
```

Both should be 13/13 + 5/5 green, matching the CI pin.

## Out of scope for this runbook

- §9.7 #5 ("replay protection on chain"): covered by the existing
  Solidity unit tests in
  `packages/evm-module/test/unit/KnowledgeAssetsV10.test.ts` (the
  five negative cases — wrong chainId, wrong contract, wrong cgId,
  wrong merkleRoot, wrong scheme version, wrong author address —
  each have their own `it()` block). Run them once on devnet
  bring-up but don't repeat per-mode.
- Adapter-side signing (Phase 4 / OpenClaw `ChatTurnWriter` and
  Hermes daemon-side): not implemented in this PR. The on-chain
  `author` field for Hermes/OpenClaw-driven publishes is therefore
  the daemon's publisher EOA, NOT the originating user's agent
  EOA. See the Phase 4 design discussion in PR #436 for the
  options.
