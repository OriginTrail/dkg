# OT-RFC-38 LU-6 — Two-laptop testnet validation runbook

End-to-end validation of the LU-6 stack on real testnet infrastructure
(Base Sepolia + the public DKG testnet peer mesh) using two operator
laptops as edge nodes and an existing core operator's node as the
opaque host.

This runbook is the **C4** companion to the local-devnet harnesses
that ship in `scripts/devnet-test-rfc38-*.sh`. It exists because the
local harnesses use a libp2p-private mesh (loopback dialing, no DHT,
no NAT traversal); they do not cover the failure modes that only
surface when peers traverse real internet hops. Those failure modes
are the LAST remaining gate before mainnet.

## What this runbook verifies (and what it doesn't)

Validates on real network conditions:
- Curated CG creation + on-chain registration on Base Sepolia
- Discovery-beacon propagation across the public mesh
- Cross-NAT/DHT gossip delivery of opaque SWM ciphertext to a core
- Host-catchup wire protocol over real RTT (≥ 50–200ms per hop)
- Signature-based host-catchup authorization (B1 PR #618)
- Member catchup resume across NAT/connection churn (B-series)
- VM publish from edge nodes with deferred on-chain registration
- Cross-laptop attestation cross-verification

NOT covered here (separate tracks):
- LU-11 chunked ciphertext commitment (still in design — #617)
- RFC-39 random sampling (depends on LU-11)
- Multi-million-message scale (run the synthetic `…-scale.sh` for that)

## Topology

```
Laptop A (operator-A)              Laptop B (operator-B)
  ┌────────────────────┐             ┌────────────────────┐
  │ dkg daemon (edge)  │             │ dkg daemon (edge)  │
  │ role: curator      │             │ role: member       │
  │ wallet: 0xA…       │             │ wallet: 0xB…       │
  │ Cursor / Node UI   │             │ Cursor / Node UI   │
  └────────┬───────────┘             └────────┬───────────┘
           │                                  │
           │       Base Sepolia RPC           │
           │       (CG registry on-chain)     │
           │                                  │
           └────────┬─────────────────────────┘
                    │
            Public DKG testnet
            peer mesh (libp2p)
                    │
       ┌────────────┴───────────┐
       │ Core operator's node   │
       │ role: opaque host      │
       │ wallet: 0xC…           │
       └────────────────────────┘
```

You need:
- 2 laptops on different networks (e.g. home NAT + office NAT)
- a core operator's existing testnet node, OR a third VPS-hosted core
  you operate (cores can NOT live on the same NAT as laptop A to test
  NAT-traversal honestly — different machine + different network is
  required for an honest C4)
- some Base Sepolia ETH on each of the three wallets (faucet links in
  `docs/setup/TESTNET_FAUCET.md`)

## 0. Pre-flight (both laptops + the core)

Cut a release tag off the merged LU-6 stack (PRs #595 → #608 → #609 →
#610 plus the B-series follow-ups), publish a canonical npm build, and
run on all three nodes:

```bash
npm install -g @origintrail-official/dkg@<release-tag>
dkg init     # writes ~/.dkg/config.json defaulted to testnet
dkg start
```

Confirm in each daemon's log:
```
Network config: DKG V10 Testnet (genesis v1)
SWM host-mode store initialized at … (role=core)   # on the core only
SWM host-mode store initialized at … (role=edge)   # on each laptop
```

Capture the three agent addresses + libp2p peer IDs:
```bash
dkg show
# → wallet:  0x…
# → peerId:  12D3KooW…
```

## 1. Curator (laptop A) creates a curated CG without on-chain registration

From laptop A's Node UI:

- **Create Project** → fill in name + description
- **Access:** `Curated`
- **Publish policy:** `Curators-only` (default) — we'll test `Open` in §6
- **Allowed agents:** add laptop B's wallet address
- **Register on chain:** **leave UNCHECKED** for this run

Click **Create Project**. The modal completes without a blockchain
transaction. The CG is in the "freemium / pre-registration" tier.

Verify on laptop A:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  http://localhost:9200/api/context-graph/list | jq '.[] | select(.access=="curated")'
```

You should see the new CG with `registered: false`.

## 2. Discovery beacon propagation

The unregistered CG triggers the LU-6 Phase B discovery beacon
mechanism. The curator broadcasts a signed beacon on the global
`dkg/cg-discovery` topic; cores receive it and auto-engage host mode
for the wire-id (keccak256(cleartext)) — no on-chain transaction yet.

On the core, after 5–15s:
```bash
grep "Beacon-driven auto-host engaged" ~/.dkg/daemon.log | tail
```
should show one or more lines with the wire id matching the curator's
CG (translate via `dkg show-cg <id>` on laptop A).

If the beacon never arrives at the core, the gossip topic isn't
propagating. Check:
- Both nodes subscribed to `dkg/cg-discovery` (grep the topic in logs)
- DHT bootstrap completed on the core (`peerStore size > 0`)
- Curator's wallet appears in the core's `beaconCuratorByWireId` cache
  (no direct API; check via `dkg shared-memory host-mode stats`)

## 3. Curator writes triples → core hosts opaque ciphertext

Laptop A:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<cg-id>", "quads": [
    { "subject": "urn:c4/alpha", "predicate": "http://schema.org/name", "object": "\"alpha\"", "graph": "" },
    { "subject": "urn:c4/beta",  "predicate": "http://schema.org/name", "object": "\"beta\"",  "graph": "" }
  ]}' \
  http://localhost:9200/api/shared-memory/write
```

Wait 10–30s for gossip propagation over the public mesh. On the core:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  http://localhost:9200/api/shared-memory/host-mode/stats | jq
```
You should see `perCg[<cg-id>].entries: 1` (one envelope = one write
batch) and `registered: false`. The byte count is the gossip-envelope
size, NOT the cleartext (cores can't decrypt).

## 4. Member (laptop B) catches up via the core

On laptop B (pre-create the CG locally with matching allowedAgents so
the sender-key handshake completes):
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "id": "<cg-id>", "name": "c4-test (member view)",
        "accessPolicy": 1, "publishPolicy": 0,
        "allowedAgents": ["<curator-wallet>", "<member-wallet>"] }' \
  http://localhost:9200/api/context-graph/create
```

Trigger an explicit catchup:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<cg-id>" }' \
  http://localhost:9200/api/shared-memory/catchup
```

List the local triples:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  "http://localhost:9200/api/shared-memory/list?contextGraphId=$(printf %s '<cg-id>' | jq -sRr @uri)" | jq '.triples | length'
```
Expected: ≥ 2.

If catchup returns `denied: 'no authority source authorized requester EOA'`,
the chain context hasn't propagated yet (you haven't registered the CG
on-chain) AND the beacon-pinned curator fallback didn't match.
Double-check that the core received the beacon from this curator
specifically (step 2).

## 5. Curator registers the CG on chain + publishes to VM

Still on laptop A:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "id": "<cg-id>" }' \
  http://localhost:9200/api/context-graph/register
```

Wait for the tx receipt (10–60s on Sepolia). Then publish:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<cg-id>", "selection": "all" }' \
  http://localhost:9200/api/shared-memory/publish
```

Capture `kcId` + `txHash` + `merkleRoot` from the response.

## 6. Outsider verifies the published KC

From any third party (or just laptop B):
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  "http://localhost:9200/api/kc/<kcId>" | jq '.merkleRoot'
```

The merkleRoot must match what laptop A's publish reported.

Cross-verify the attestation:
```bash
curl -sH "Authorization: Bearer $(cat ~/.dkg/auth.token)" \
  -H 'Content-Type: application/json' \
  -d '{ "contextGraphId": "<cg-id>", "batchId": "<kcId>", "merkleRoot": "<merkleRoot>", "plaintextLeafHash": "<leaf>" }' \
  http://localhost:9200/api/attestation/mint
```

…and verify on the other party's node via `/api/attestation/verify`.
This proves attestations are portable across the public mesh, not just
across a libp2p-local one.

## 7. Stress + restart scenarios

Run the local devnet harnesses against this same topology by setting
`API_PORT_BASE` + `DEVNET_DIR` to point at the laptops' actual paths,
or run the equivalent flows by hand:

- **C1 (revocation):** laptop A removes laptop B from the allowlist,
  writes another batch, verifies laptop B can't see the new writes.
- **C5 (unclean restart):** `kill -9` the core's daemon during step 4,
  restart it (`dkg start`), confirm laptop B's catchup resumes and
  the core's `host-mode/stats` reports `enabled: true`.

Both exercise the cross-NAT path; the local devnet scripts cover the
same logic over loopback.

## Acceptance checklist

- [ ] Both laptops bootstrap from the published release npm package
- [ ] Discovery beacon reaches the core within 30s of CG create
- [ ] Pre-registration host-mode store on core shows the CG with `registered: false`
- [ ] Member catchup succeeds against the core BEFORE the curator registers
- [ ] Curator registers the CG → core's `host-mode/stats` flips `registered: true`
- [ ] Curator publishes to VM → outsider observes merkleRoot on chain
- [ ] Outsider verifies attestation minted by either laptop
- [ ] Revocation test: kicked laptop can't read post-revocation batch
- [ ] Unclean-restart test: core resumes hosting after `kill -9` + restart

If every item is checked, the LU-6 stack is mainnet-launch-ready.

## Reporting back

When you run this, capture:

- Release tag used on all three nodes
- Wall-clock time spent on each step (gives us beacon + gossip latency)
- Any deviation from the expected response shapes
- Daemon log excerpts for any step that needed a retry

File the report in this repo as a new doc under `docs/runbooks/`, or
attach to the PR that bumps the next mainnet release.
