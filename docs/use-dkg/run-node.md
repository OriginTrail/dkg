---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Daemon Lifecycle

Common commands:

```bash
dkg start
dkg start -f
dkg stop
dkg status
dkg logs
dkg auth show
dkg auth rotate
```

The daemon API defaults to:

```text
http://127.0.0.1:9200
```

The Node UI defaults to:

```text
http://127.0.0.1:9200/ui
```

## Boot Without Restoring Persisted Context Graph Subscriptions

By default, the daemon restores durable Context Graph subscription rows as
live gossip subscriptions and automatic sync work on every boot. To inspect or
query an existing store without reactivating that workload, set:

```json
{
  "contextGraphSubscriptionRehydrationEnabled": false
}
```

For a one-off boot, the strict environment override wins over `config.json`:

```bash
DKG_CONTEXT_GRAPH_SUBSCRIPTION_REHYDRATION_ENABLED=false dkg start -f
```

Accepted environment values are `1`, `0`, `true`, and `false`
(case-insensitive). Any other value fails startup so a typo cannot silently
enable network work.

Disabling rehydration does not delete subscription rows, membership records,
or stored RDF content. The content remains locally queryable. It only prevents
non-system persisted rows from becoming live subscriptions, gossip handlers,
or automatic sync scope during that boot. System Context Graph startup and
explicit subscribe/create/write operations remain unchanged. Remove the
setting, set it to `true`, or use the environment override to restore normal
default behavior on the next boot.

## Core Node Profile Registration

The two node roles are `edge` and `core`.

An Edge Node can run, sync, query, and serve local agents without an on-chain node profile. A Core Node needs an on-chain profile because Storage ACKs, Random Sampling, staking, and node-operator authorization use its numeric `identityId`.

Initialize a Core Node explicitly:

```bash
dkg init --role core --network mainnet-gnosis
dkg start
```

`dkg init` writes `nodeRole: "core"` to `~/.dkg/config.json` and creates `~/.dkg/wallets.json` if it does not exist. A fresh wallet file contains one admin wallet and three operational wallets. The admin wallet is used for profile/key-management transactions; the primary operational wallet creates the profile, signs node operations, and pays the initial staking transaction.

Before registration, fund the Core wallets for the selected network:

| Wallet | Needed for |
| --- | --- |
| Primary operational wallet | Native gas token and TRAC for profile creation, TRAC approval, and the initial staking conviction |
| Other operational wallets | Native gas token for node operations and publishing |
| Admin wallet | Native gas token for key-management transactions, including registering additional operational wallets |

Async publisher wallets are separate transaction signers stored in `publisher-wallets.json`. They need native gas plus PCA registration or TRAC for direct spend, but they do not need to be operational wallets unless you want them to carry a node identity for publisher-node attribution. See [Async Publisher Wallets](async-publisher-wallets.md).

On `testnet`, setup attempts to fund these generated wallets automatically when the faucet is reachable. On `mainnet-gnosis` and `mainnet-base`, fund them yourself. Use:

```bash
dkg wallet
```

### What The Daemon Does

At Core startup the daemon reads the primary operational wallet's on-chain identity:

1. If `identityId > 0`, the node uses the existing profile.
2. If `identityId == 0` and `nodeRole` is `core`, it calls the profile provisioning path.
3. If `identityId == 0` and `nodeRole` is `edge`, it skips profile creation.

The Core provisioning path sends `Profile.createProfile` from the primary operational wallet, sets the generated admin wallet as the profile admin, and does not pass extra operational keys in the initial call. It then approves TRAC to `StakingV10` and calls `DKGStakingConvictionNFT.createConviction(identityId, stakeAmount, lockTier)`. The current daemon default attempts to stake `50000` TRAC with lock tier `1`.

After the profile exists, the daemon can also register additional operational wallets for ACK signing. That follow-up path requires the admin wallet.

### Manual registration with an external admin key

If the operator does not want to store the admin wallet private key on the node host, do not rely on `POST /api/identity/ensure` for initial setup. That route is the daemon convenience path and requires `adminPrivateKey` for profile creation and later profile/key-management repair transactions.

Instead:

1. Run `dkg init --role core --network <network>` on the node host.
2. Run `dkg wallet` and collect the admin wallet address plus all operational / ACK wallet addresses. Treat the primary operational address as `op1`.
3. Register the profile manually on-chain:
   * If signing from the primary operational wallet, call `Profile.createProfile(adminAddress, [op2, op3, ...], nodeName, nodeId, initialOperatorFee)`.
   * If signing from the external admin wallet, call `Profile.createProfile(adminAddress, [op1, op2, op3, ...], nodeName, nodeId, initialOperatorFee)`.

Include all operational / ACK wallets in the initial `createProfile` call if the admin key will not be present on the node host. Otherwise the daemon cannot later run `addOperationalWallets`, because that repair path requires the admin private key. If `dkg init` generated the admin key on the host, move that private key into the external signer according to your key-management process and make sure the node host does not retain it.

After profile creation, stake from the primary operational wallet:

1. Approve TRAC to the `StakingV10` contract address resolved from the Hub.
2. Call `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`.
3. Verify `IdentityStorage.getIdentityId(op1)` or `GET /api/identity` returns a non-zero `identityId`.

Once this is done, the daemon should discover the existing profile on startup instead of creating one.

### Manual Trigger

If the daemon started before the wallets were funded, or a transient RPC failure left identity unresolved, fix the funding or RPC issue and trigger registration without restarting:

```bash
TOKEN=$(dkg auth show)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:9200/api/identity/ensure
```

The response is:

```json
{
  "identityId": "123",
  "hasIdentity": true
}
```

Registration is complete when `identityId` is not `"0"` and `hasIdentity` is `true`.

You can also check the read-only status:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/identity
curl http://127.0.0.1:9200/api/status
```

After identity exists, set the node ask if this Core Node should advertise a non-default ask:

```bash
dkg set-ask <amount>
```

For prover binding status, use:

```bash
dkg random-sampling status --json
```

### If Staking Fails After Profile Creation

Profile creation and staking are separate transactions. If `Profile.createProfile` succeeds but the TRAC approval or `createConviction` transaction fails, the node keeps the new `identityId`; the profile is not rolled back.

In that case, `POST /api/identity/ensure` will report the existing identity and will not submit a second automatic stake. Stake manually after funding the operational wallet:

1. Approve TRAC to the `StakingV10` contract address resolved from the Hub.
2. Call `DKGStakingConvictionNFT.createConviction(identityId, amount, lockTier)`.
3. Confirm the node's stake appears for that `identityId`.

Use the same `identityId` returned by `/api/identity`. Do not create another profile for the same node wallet, and do not use legacy V8 staking paths for V10 Core stake recovery.

If an agent gets auth errors, first identify the caller:

```bash
TOKEN=$(dkg auth show)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:9200/api/agent/identity
```

## Core VM Promotion And The StorageACK Finality Gate

A Core signs a StorageACK only when it can guarantee the acknowledged data
reaches its Verifiable Memory (VM). For a public Context Graph (publish or
update) it verifies the data, checks that its chain-driven VM reconciliation
is enabled and running, and durably records the graph as core-hosted in the
namespace it stores the copy in, so the reconciler promotes every Knowledge
Asset the chain registers to that graph, across restarts. Only then does it
store the copy with its SWM head, record it in a node-local ledger of signed
ACKs, and sign. A declined request stores nothing.

| Decline on the wire | When | Publisher behavior |
| --- | --- | --- |
| `CORE_TEMPORARILY_UNAVAILABLE`, message `VM promotion unavailable: ...` | The Core cannot commit right now: VM reconciliation is starting or stopping; the graph's liveness, access policy, on-chain name or core-hosted record could not be read, confirmed or written; its persisted subscription row is dormant for a reason that can clear (for up to 10 minutes); a same-version copy it signed may still land; or (for an update) the version being replaced is not in VM yet | Retries this Core with backoff (every deployed publisher, 10.0.18 included) |
| `CORE_VM_PROMOTION_DISABLED` | VM reconciliation is switched off or the chain adapter cannot run it; the SWM graph id the request names is not the graph it is signed for (see below); the namespace already reconciles a different live graph; the persisted subscription row stays dormant (rehydration disabled, authority denied, or 10 minutes without clearing); a curated graph was sent on the public path; or the intent is not graph-scoped | Moves on to other Cores |
| `CONFLICTING_KA_ASSERTION` | The Core signed and still owes a copy of this Knowledge Asset at a newer version, or at the same version with different content that has already landed on chain | Moves on to other Cores |

Logs, the `dkg.storage_ack.declines_total` metric and `/api/status` label the
transient case `CORE_VM_PROMOTION_UNAVAILABLE`; on the wire it travels as
`CORE_TEMPORARILY_UNAVAILABLE` because publishers before 10.0.19 treat any
code they do not know as final.

**Namespace binding.** The copy is stored under the SWM graph id the request
names (`swmGraphId`), which is also where the Core records the graph as
core-hosted. That id must belong to the graph the ACK is signed for: a numeric
id must be that graph's id, and a name must be the graph's committed on-chain
name (`keccak256(name)` equals the graph's name hash) or, for a graph created
without a committed name, bound to it locally. A mismatch is declined finally,
so a request cannot bind another graph's namespace; a name the Core cannot
confirm yet (for example a brand-new graph whose registration it cannot see)
is declined transiently.

**Which copy holds the head.** Only a copy this Core signed and still owes can
hold a Knowledge Asset's SWM head against a new request; any other head (a
synced or gossiped copy, a released copy) is replaced. A same-version request
with different content is declined once that version has landed on chain.
Before that it replaces the held copy (a retry after a failed round reuses the
version), but only once the held copy's own transaction can no longer be
pending: it is older than 5 minutes (`DKG_STORAGE_ACK_PENDING_TX_WINDOW_MS`)
or the audit has seen it absent on chain. Until then the request is declined
transiently. A copy whose version landed with different content is released. A newer version replaces the held copy once it is in VM,
or at once when the chain has already moved past it. SWM gossip of a newer
version waits, queued by its sender, until an owed copy is promoted.

**Legacy requests.** A Core declines public StorageACK requests that are not
graph-scoped (no `kaUal` / `assertionVersion` envelope) with
`CORE_VM_PROMOTION_DISABLED`: it cannot keep a copy of such a publish that it
could later promote. Every default publish and update path has sent
graph-scoped requests since 10.0.7. Raw-lift jobs queued before 10.0.7 (or
restored with the legacy raw-lift import) and `publishFromSharedMemory` called
without `contentScopeVersion` still send legacy requests and can no longer
collect ACKs from 10.0.19 Cores.

Chain-driven VM reconciliation has its own switch, on by default:

```json
{
  "vmReconcilerEnabled": true
}
```

`DKG_VM_RECONCILER_ENABLED` overrides `config.json` (accepted values: `1`,
`true`, `yes`, `on`, `enabled` and `0`, `false`, `no`, `off`, `disabled`;
anything else is ignored). **A Core with VM reconciliation off declines every
public StorageACK.** `syncReconcilerEnabled` / `DKG_SYNC_RECONCILER_ENABLED`
only control the periodic peer-sync reconciler and never switch VM
reconciliation off.

**Updates.** A Core stores a public update as its own ACK copy, replacing the
Knowledge Asset's SWM copy, only once the version it replaces is in its VM.
Until then it declines the update transiently and promotes that version at
once (it is on chain, since an update requires it). That promotion runs in the
foreground RPC class and the normal store lane, ahead of the background
catch-up, so the publisher's retry is usually signed within its retry window
(about 31 s on 10.0.18). After the update lands on chain, a pending-update
lane that runs with every VM sweep (`DKG_VM_RECONCILE_INTERVAL_MS`, default
60 s, keyset paged, at most 8 chain checks per run) promotes the new version.
Sub-graph copies follow the same rules; the ledger records the sub-graph.

Curated (private) Context Graphs never reach a Core as plaintext, so there is
nothing to promote. A curated ACK guarantees that the Core independently
verified the graph is curated on chain, rebuilt the publisher's catalog
commitment, and durably stored it in `<cg>/_catalog`, the artifact random
sampling proves for curated Knowledge Assets. It does not attest that the Core
holds the private payload, and it does not depend on VM reconciliation.

`GET /api/status` reports the effective switches under `syncLifecycle`
(`syncReconcilerEnabled`, `vmReconcilerEnabled`) and the Core's state under
`vmPromotion`:

| Field | Meaning |
| --- | --- |
| `storageAckGate` | `ready` (the gate would commit now), `starting`, `declining` (VM reconciliation off or unavailable) or `not-core` |
| `storageAckHandler` | `registered` when the Core is serving StorageACK requests, `not-registered` when it is not (for example, no ACK signer), `not-core` |
| `storageAckDeclinesLastHour` | StorageACK declines per reason over the last hour |
| `coreHostedGraphs` | Graphs recorded as core-hosted |
| `audit` | The last ACK promotion audit (below) |

### ACK promotion audit

A Core with VM reconciliation on runs an audit 1 to 6 minutes after startup
and then every 15 minutes (`DKG_VM_PROMOTION_AUDIT_INTERVAL_MS`). It runs in
the background chain-RPC class and store lane, like the VM reconcile walk.

- **Backfill.** It pages through the namespaces in the signed-ACK ledger and
  records the public ones as core-hosted, at most 32 per pass, through the
  same access-policy check as the gate; curated graphs stay excluded. This
  covers graphs acknowledged while VM reconciliation was off. A namespace it
  cannot resolve backs off, and the pages behind it still get their turn. The
  reconciler then promotes only Knowledge Assets the chain actually
  registered; copies of publishes that never landed are left to retention.
  The catch-up can be throttled with `DKG_VM_RECONCILE_CONCURRENCY` (graphs
  at once, default 2) and `DKG_VM_RECONCILE_ORDINAL_CONCURRENCY`
  (registrations per graph at once, default 5).
- **Watchdog.** It rotates through ledgered copies still not in VM 30 minutes
  after their ACK (`DKG_VM_PROMOTION_STALL_THRESHOLD_MS`), spending at most 32
  chain reads and 16 per-asset reconciles per pass and resuming where the
  previous pass stopped. A Knowledge Asset registered on chain but not
  promoted is marked registered, promoted with a per-asset reconcile, logged
  as `VM promotion watchdog: ...` and counted in
  `vmPromotion.audit.stalledOnChain` and the `dkg.vm_promotion.stalled_acks`
  gauge.

### Retention of StorageACK copies

The shared-memory TTL cleanup keeps every ledgered copy (one this Core signed,
or stored before the upgrade) whose Knowledge Asset is not confirmed in VM at
that version or later. Declined requests, copies synced from peers and gossip
operations that happen to use the `storage-ack-` prefix are not in the ledger
and expire as before. A ledgered copy leaves retention, and the ordinary TTL
applies, when:

- its Knowledge Asset is confirmed in VM at that version or later;
- the audit found it absent on chain twice, at least one audit interval apart
  and both after the SWM TTL (an ACK may still belong to a publish in
  flight); or
- the chain has moved past its version (a later version landed), so it can no
  longer be promoted as-is; or
- it is older than 90 days (`DKG_STORAGE_ACK_RETENTION_MAX_MS`) and the audit
  never saw it registered on chain. A copy seen registered is kept until it is
  promoted or superseded.

An ACK signature carries no on-chain deadline and does not name the Knowledge
Asset id, so the absence check is conservative evidence rather than proof; the
reference publisher never submits ACKs that late.

Copies stored before a Core first ran with the ledger are grandfathered into it
once per store (the bound is recorded as
`<urn:dkg:node:storage-ack-ledger> dkg:storageAckGrandfatheredThrough`). The
ledger also records when a ledger-keeping version last ran
(`dkg:storageAckLedgerSeenAt`, refreshed at every audit pass). If a Core comes
back after more than an hour without one, for example after a rollback to
10.0.18 and an upgrade again, the copies stored in between are grandfathered
too. After a shorter rollback, copies the older version signed rely on the
ordinary TTL; to grandfather them anyway, delete the bound before restarting
(the next start grandfathers every copy not yet in the ledger):

```sparql
DELETE WHERE { GRAPH <urn:dkg:node:storage-ack-ledger> {
  <urn:dkg:node:storage-ack-ledger> <http://dkg.io/ontology/storageAckGrandfatheredThrough> ?t
} }
```

## Private shared-memory recovery time budget

`DKG_PRIVATE_SWM_RECOVERY_BUDGET_MS` sets the elapsed-time allowance for one
private shared-memory recovery job. It defaults to `600000` (10 minutes). The
node resolves this setting at startup; each job starts its own monotonic clock
so a wall-clock correction cannot renew the allowance. Restart the node after
changing the setting. Blank, negative, fractional, non-finite and unsafe
integer values fall back to the default.

The same allowance covers all recovery rounds, metadata/data pages and snapshot
fetches. Once it is exhausted, the worker admits no new page, snapshot fetch or
transport attempt or retry round. Every transport attempt uses the remaining
allowance, including retries within one page fetch. Work
already admitted, including a verified asset's atomic write, is allowed to
finish; this is an admission budget, not a promise to interrupt a store write at
an exact instant. Verified snapshots remain reusable on the next recovery job;
incomplete metadata/data prefixes are discarded and their checkpoints reset.
Local budget expiry leaves recovery incomplete and retryable without placing the
peer in backoff. A request that was sent and failed retains its transport-failure
classification even if the allowance expires before its retry.

An explicit `0` disables extra recovery rounds while preserving the initial
round and its existing transport deadline. The page and round count limits
remain active for every setting. The public recovery lane retains its separate
`DKG_SWM_CATCHUP_PASS_BUDGET_MS` setting.
