---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Updates and Rollback

> **Tip:** point the node at a **reliable chain RPC** before updating — public
> endpoints rate-limit and can silently stall publishing.

Use the CLI update path for packaged installs:

```bash
dkg update --check
dkg update
dkg rollback
```

Before updating:

- stop long-running imports or publisher jobs
- check wallet and daemon status
- record the current package version
- keep a copy of local config and auth material outside the repo

After updating:

```bash
dkg status
dkg wallet
dkg mcp setup --force
```

Use `dkg rollback` when the latest installed version breaks daemon startup or a critical integration.

## Rolling back

`dkg rollback` returns the node to the version it ran before the last update:

1. It checks that the local stores can be given back in a form the older version
   opens. If they cannot, it stops here and changes nothing.
2. It stops the daemon.
3. It readies the stores for the older version (see below).
4. It switches versions: an Edge reinstalls the previous npm release, a Core
   flips to the other blue-green slot.

Then start the node with `dkg start`. If the reinstall fails, the daemon stays
stopped on the current version; `dkg start` starts it again.

If a service manager restarts the node by itself (for example systemd with
`Restart=always`), stop the service first, run `dkg rollback`, then start the
service. While `dkg rollback` readies the stores it holds them, so a node the
service manager starts in that window fails to open them instead of changing
them.

### Stores that a newer version migrated

A release can move a local store to a newer schema that older releases refuse.
`dkg rollback` gives such a store back in the older form:

- 10.0.26 moves the RFC-64 inventory database
  (`rfc64-sync/inventory-v1.sqlite3`) to schema v6. Releases from 10.0.17 to
  10.0.25 open schema v5 at most and stop at start-up on schema v6.
- `dkg rollback` lowers the database from v6 to v5. Schema v6 adds only the
  retry history of private placement repairs, which 10.0.25 does not use, so
  every row 10.0.25 reads is kept, including those written after the update.
- Before migrating, 10.0.26 keeps a copy of the database as it was. The name
  says the schema the copy holds and the one the migration moves to, for
  example `rfc64-sync/inventory-v1.schema-v5-to-v6.pre-migration.sqlite3`. A
  node keeps one such copy per store, and the next migration replaces it; a
  migration that stopped part-way keeps its first copy. Migrating needs free
  disk space for the copy, twice the database's write-ahead log and 64 MiB;
  with less, the node stops at start-up and says so, and the database stays
  as it was.
- If the database is not exactly the v6 schema, `dkg rollback` restores that
  copy instead and keeps the replaced database next to it as
  `rfc64-sync/inventory-v1.schema-v6.before-rollback.sqlite3`. The restored
  copy lacks what the node recorded after the update.
- If neither works, `dkg rollback` refuses, names the database and its schema,
  and changes nothing.

To install an older version by hand, for example with
`npm install -g @origintrail-official/dkg@<version>` or by switching a git
checkout, stop the node and ready its stores first:

```bash
dkg rollback --stores-for 10.0.25
```

This only readies the stores. It does not switch versions.

### Publisher jobs that failed on 10.0.26

10.0.26 records a cause with each publish job that fails before its
transaction is sent, and a new failure code, `validation_unknown`. 10.0.25
cannot read these job records: it leaves them out of job lists, answers an
error when asked for one by id, and refuses to publish the same Knowledge Asset
to Verified Memory again while such a record exists. Before rolling back, clear
the failed jobs you no longer need:

```bash
dkg publisher clear failed
```

It keeps failed jobs that may still have a transaction on chain.

## Updating from 10.0.27

10.1.0 needs no new setting. A node that does not opt in to the marketplace
gets no store migration or schema change, and its `config.json` works as it
is.

- **The NeuroSymbolic Marketplace is available on testnet.** Its contracts
  are deployed on Base Sepolia, and a node opts in through `config.json`:
  - Buying: set `marketplace.enabled` to `true`. The node then buys
    inference through its OpenAI-compatible gateway under
    `/api/marketplace/v1`, which takes `dkgmk_` access keys.
  - Selling: set `marketplace.seller.enabled` to `true` and configure an
    inference backend for each service under `marketplace.seller.services`.
    A seller serves only while its node is a Core Node.
  - Sellers publish their offers to the Verifiable Memory of the
    Marketplace Context Graph, and buyers read them there. Publishing an
    offer is a publish on chain and costs TRAC; until an offer is listed,
    its offering's `listing` in `GET /api/marketplace/seller` says why. A
    testnet node uses the testnet Marketplace Context Graph,
    `testnet-marketplace`, by default; set `marketplace.contextGraphId`
    only to use another graph.
  - With both unset, the node starts no marketplace work, and the
    `/api/marketplace` routes answer that the marketplace is off.
  - On mainnet the marketplace stays inactive until its contracts are
    deployed there.
- **What the marketplace does when it is busy or fails to start.**
  - A busy gateway answers with a `Retry-After` header: 429 `budget_busy`
    when too many calls wait on one service, or 503 `gateway_busy` when the
    gateway holds as many calls as it takes. A client should wait that long
    and try again.
  - Subscription top-ups are idempotent per key. A top-up that carries an
    `idempotencyKey` is sent at most once for that key, and a repeat gets
    the first answer, also after a restart.
  - If buying or selling fails to start, that part stays off and the node
    keeps running. The log says why.
- **The node UI has a new look.** Its Marketplace section stays hidden
  until you open the node UI once with `?marketplace` in its address; that
  browser then keeps showing it.
- **RPC usage diagnostics report vocabulary version 4.**
  `GET /api/diagnostics/rpc-usage` reports `consumerVocabularyVersion` 4,
  which adds the marketplace's contract lookups and views to its consumer
  labels. A tool that reads the snapshot and pins those labels should
  accept version 4.
- **A new optional setting for new Edges, `publicSnapshotBootstrap`.** It
  sets up the experimental public snapshot bootstrap for a new Edge and
  refuses a data directory that is already in use, so it does not affect a
  node that updates. Leave it unset unless you are setting up a new Edge
  this way.
- **A new optional setting for nodes with a remote signer,
  `chain.signer.nodeHeldAuthor`.** It is off by default. With it on, the
  node's own agent keys author, and the remote signer signs payer
  transactions only; see
  [Authors held on the node](external-signer.md#authors-held-on-the-node).

Going back to 10.0.27 works with `dkg rollback`. No store moves to a new
schema in 10.1.0, so `dkg rollback` leaves the stores as they are. 10.0.27
ignores the `marketplace` block in `config.json` and the `marketplace`
folder in the node's data directory. On a node that sells, run
`dkg marketplace seller land` before you roll back: a seller's receipts
land only during their epoch. 10.0.27 refuses `chain.signer.nodeHeldAuthor`
as an unknown setting and does not start with it, so remove it from
`config.json` before you roll back.

## Updating from 10.0.26

The first release after 10.0.26 changes two things to check before you update.

- **Finished-job cleanup ships for evaluation, off by default.** Leave it off
  on production nodes until a later release says it is ready. 10.0.26 ignores
  the `queueRetention` block of `config.json`; the new release reads it. A mode
  already set there starts that cleanup at the first start. A wrong value or an
  unknown key stops the daemon from starting. See
  [Clean up finished jobs](async-queue-operations.md#clean-up-finished-jobs).
- **The async queues get store slots of their own.** This is on by default
  for Blazegraph and managed Oxigraph stores on hosts with more than 2 CPUs,
  and off for other backends, including `sparql-http`, and on hosts with 2 CPUs
  or fewer. The embedded store never uses it. Nodes set up with `dkg init` use
  managed Oxigraph. If share or publish jobs
  get slower after the update, turn it off and restart: see
  [Store control path](async-queue-operations.md#store-control-path). The
  daemon logs `Store control path: on (...)` or `off (...)` once at start.

Going back to 10.0.26 works with `dkg rollback`. The newer release keeps a
publication that is confirmed on chain, but whose catalog step it has not
stored yet, as a confirmed catalog placement, and 10.0.26 does not start on an
inventory database that holds one. `dkg rollback` removes these placements
first and names the assets; 10.0.26 does not finish their catalog step. Before
you start 10.0.26 that you installed by hand, run
`dkg rollback --stores-for 10.0.26` with the newer release.

## Node.js security releases

Node.js 22.23.4, 24.22.1 and 26.12.1, released on 21 October 2026, fix
CVE-2026-111497, an out-of-bounds write in the Brotli decoder that Node.js
bundles. Upgrade Node.js on every host that runs a node to one of these
releases or a later one on the same line. The 23 and 25 lines get no fix:
move to 22, 24 or 26. A running node keeps the Node.js it started with, so
restart it after the upgrade.

On a host that installs Node.js from NodeSource packages:

```bash
node --version
sudo apt-get update && sudo apt-get install --only-upgrade nodejs
node --version
```

Then restart the node: `dkg stop` and `dkg start`, or restart the service that
runs it. `dkg status` shows the Node.js release the running daemon uses on its
`Runtime:` line.

From 10.0.26 a node also refuses Brotli-encoded responses on its outbound HTTP
requests. That is defence in depth and does not replace the upgrade.
