# OT-RFC-27 marketplace scenario on Base Sepolia

A multi-day marketplace on the live OT-RFC-27 contracts: six buyers fund
subscriptions for three services, and four real, proving Core Nodes land receipt
batches for them, day after day, with scripted events. It feeds the query/inference
pool of every epoch from the activation epoch on, so its numbers can be followed on
the chain.

## What is real and what is simulated

**The service calls are simulated: there is no inference and no query.** The calls
are computed from a seed. Each seller derives the buyers' session keys from that
seed and signs the requests itself, which stands in for the buyer's hop to the
seller. A receipt's result commitment is a hash of nothing that was ever served.

**Everything on the chain is real**: the subscriptions and their TRAC, the Conviction
Accounts and their allowances, the grants with both parties' consent, the receipt
batches, sent from real operational keys of real nodes, their counting, the served
and weighted values, and each epoch's pool.

## The cast

`config.ts` holds all of it. `public.testnet.json` is its public form, with the
derived addresses and the account ids.

- **Sellers**: four Core Nodes, each with an operational key of its own for this,
  so that nothing clashes with the nonces of the node's own proofs. Each has its own
  unit prices.
- **Services**, with `serviceId = keccak256(label)`: `inference/model-alpha` (unit:
  token), `inference/model-beta` (unit: token, pricier), `query/knowledge` (unit:
  query).
- **Buyers**, with keys `keccak256(seed || "rfc27-scenario/<role>")`:

| Buyer | Pays from | Uses of its budgets | |
|---|---|---|---|
| `wallet-heavy` | wallet | about 90% | |
| `wallet-light` | wallet | about 25% | |
| `wallet-bursty` | wallet | about 90% | tops up mid-epoch |
| `account-plain` | Conviction Account | about 60% | no discount |
| `account-30` | Conviction Account | about 70% | commits 100,000 TRAC, 30% discount |
| `account-75` | Conviction Account | about 80% | commits 1,000,000 TRAC, 75% discount |

Each account has an owner of its own, distinct from its buyer.

## The script

By epoch offset from the scenario's first epoch. `EVENTS` in `config.ts` is the
data; the plan and the ticks read it.

| Offset | What happens |
|---|---|
| 0 | Baseline. |
| 1 | `wallet-bursty` tops up at about 12:00 UTC. The owner of `account-30` removes its buyer at about 16:00 UTC: a request issued from then on is refused, and one served before it still lands. |
| 2 | The owner adds the buyer back at the epoch's start. **The race**: from 22:30 UTC, two sellers serve `wallet-heavy`'s model-beta budget past its limit, so batches count in landing order and the later lander counts only what is left. **The held batch**: `beacon-03` holds its calls from 22:30 UTC past the epoch's end, then sends that batch once, early in offset 3, so the chain records a failed transaction. Its refusal, `GroupFault` with `OutsideEpoch`, is read back and logged as expected, and those calls never count. |
| 3 | Only funding, and no calls. No node has served value, so the pool is 0 and the money rolls forward. |
| 4 and on | Baseline with varied demand. Offset 4's pool takes offset 3's money. |

## How it works

- **The plan is pure**: `plan.ts` is a function of the seed and the epoch, in
  integers. A call is a function of (seed, epoch, buyer, service, time slot), which
  gives its seller, its units and its nonce. Nothing about the calls is stored.
- **A tick runs every five minutes on each beacon**, on a systemd user timer, under a
  `flock`, with `MemoryMax=256M`, `CPUQuota=25%` and `Nice=10`. Each beacon fires in
  its own minute of the five, to spare the public endpoint.
- **Its home duties come first.** Each buyer's funding, top-up and grant transactions
  run on exactly one home beacon, never its main seller. Each is decided from the
  chain: fund if `subscriptionExists` says no, top up while the subscription's value
  is what it was funded for, remove the buyer while its grant is live, and add it
  back once its removal lies in an earlier epoch.
- **Then its seller's**: every 30 to 60 minutes, and at every tick of the epoch's last
  20 minutes, a seller computes the calls assigned to it up to now, drops those
  whose nonce bit is set (`QueryInferenceStorage.nonceWord`), those issued before
  the recorded `startsAt`, and those issued after the grant ended, and lands the rest
  at a `minCounted` of 0, up to the batch bounds. A crash or a rerun never lands a call
  twice.
- **Every transaction is simulated first.** A revert is decoded and logged, and the
  tick goes on. A faulty item is left out of its batch, which is simulated again.
  `NoNodeScore` is normal early in an epoch: the next tick tries again. The one
  exception is the held batch, sent unsimulated with a fixed gas limit, as its failure
  is meant to reach the chain.
- **What a tick keeps** in `~/.rfc27-scenario/state.json` is only whether to retry at
  the next tick, and that the held batch was sent. Losing it costs one extra look, and
  at worst a second failed send of that batch.
- **Logs** are JSON lines in `~/.rfc27-scenario/logs/tick.jsonl`, at most 5 MB each,
  with three older files kept.

## Running it

From `packages/evm-module`:

```sh
node scripts/rfc27/scenario/build.mjs        # bundles cache/rfc27-scenario/driver.cjs
DRIVER=cache/rfc27-scenario/driver.cjs
```

The seed is 32 random bytes in `~/.rfc27-scenario/seed` (0600). It is never printed.
`openssl rand -hex 32` makes one, and `node $DRIVER public --out <file>` writes the
public file from it.

**1. On a fork first.** `fork-run` runs the setup and the same ticks as the beacons,
from one process, through a warped clock. It impersonates the funder and the sellers,
and writes stand-in node scores as `RandomSampling` would. After each epoch it checks
the bookings, budgets, totals, gross rewards and pools against the plan, the rollover
rule and each batch's own receipt. It refuses to run anywhere but on a local anvil
fork, and exits nonzero if a check fails.

```sh
anvil --fork-url https://sepolia.base.org --fork-block-number <recent block> \
  --host 127.0.0.1 --port 8547 --retries 12 --fork-retry-backoff 800 &
node $DRIVER fork-run --rpc http://127.0.0.1:8547 --epochs 5
```

It runs each beacon's ticks at their real cadence, about six minutes an epoch. With
`--stride <n>`, it runs only every nth of the ticks where nothing is due. With
`--journal <setup journal>`, on a fork of the chain after the real setup, it sends
nothing for the setup and rehearses from what the setup left.

A five-epoch run leaves about 4 GB of anvil's state under `~/.foundry/anvil/tmp`,
which stopping anvil does not remove. Delete that run's directory when it is done.

**2. Setup, once, from one machine, before any timer runs.** It takes the funder's key
and endpoint from `EVM_PRIVATE_KEY_BASE_SEPOLIA_V10` and `RPC_BASE_SEPOLIA_V10`, and
prints neither. Without `--send` it only lists what it would send. It has spending
limits of its own, sends only what is not there yet, keeps a journal in
`~/.rfc27-scenario/setup-journal.json`, and so can be run again; but never while the
timers run, as it signs for the same buyers and owners. The funder's key sends plain
ETH and TRAC transfers and makes no other call. The accounts get a beacon node as
their primary node, and each buyer is added with both parties' signatures.

```sh
node $DRIVER setup                                              # the plan, sends nothing
node $DRIVER setup --send --out scripts/rfc27/scenario/public.testnet.json
```

**3. Install, one beacon first.** The seller key must already be in
`~/.rfc27-scenario/seller.key` there, as an operational key of the node:

```sh
scripts/rfc27/scenario/install.sh <ssh target> beacon-01
```

Before the first epoch, a tick reads what it needs and simulates each funding, which
the chain refuses with `QueryInferenceNotActive`. That shows the endpoint, the keys and
the decoding work, at no cost.

**To follow it**, read-only, from anywhere with the seed:

```sh
node $DRIVER status --public scripts/rfc27/scenario/public.testnet.json
```

## Stopping and uninstalling

**To stop a beacon**, at once and from its next tick on:

```sh
touch ~/.rfc27-scenario/stop          # to resume: rm ~/.rfc27-scenario/stop
```

The timer goes on firing and does nothing. A tick in progress finishes.

**To stop the timer too:**

```sh
systemctl --user disable --now rfc27-scenario-tick.timer
```

**To uninstall from a beacon:**

```sh
systemctl --user disable --now rfc27-scenario-tick.timer
rm ~/.config/systemd/user/rfc27-scenario-tick.service ~/.config/systemd/user/rfc27-scenario-tick.timer
systemctl --user daemon-reload
rm -rf ~/.rfc27-scenario/logs
rm -f ~/.rfc27-scenario/driver.cjs ~/.rfc27-scenario/public.json ~/.rfc27-scenario/seed \
  ~/.rfc27-scenario/state.json ~/.rfc27-scenario/tick.lock ~/.rfc27-scenario/stop
```

This leaves `~/.rfc27-scenario/seller.key` in place: it is still an operational key of
the node's profile, and removing it from there is the node admin's call. None of this
touches the node, its service or its wallets. What the derived keys hold stays with them.

## How long it runs

It runs until stopped. Each of these ends a part of it, logged, with no harm done:

- **The Conviction Accounts last 12 epochs**, `ParametersStorage.publishingConvictionEpochs`.
  From an account's expiry, its buyer funds nothing (`account-expired`), and requests
  issued after its grant's expiry are left out. The wallets go on.
- **The wallet buyers hold about 30 epochs of TRAC.** After that their funding is
  simulated and refused, and logged.
- **The ETH**: a seller holds 0.008 ETH. An epoch's batches cost about 14M gas per
  seller, at a base fee of about 0.005 gwei when this was written, and Base's L1 data
  fee adds little. A send waits while the base fee is above 0.25 gwei, or 1 gwei in the
  epoch's last 20 minutes. `low-eth` in the log says when a key runs short.
