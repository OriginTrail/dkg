# Warm sync defaults

Public snapshot recovery uses the existing exact transport. Capable cores
advertise exact-batch streaming by default, and requesters select it only for
eligible public assets on a peer that advertises support. Older peers,
unsupported stores and ineligible assets retain the existing recovery paths.
Bulk transport remains opt-in.

Cores with a persistent `dataDir` retain verified compressed exports in
`<dataDir>/prepared-content-v1` by default. A later fresh client can reuse those
exports, including after the core restarts. Each response still checks current
authority and metadata; each receiver still verifies identity and the payload
root before committing. Cached content never supplies permission.

The companion Blackbox change gives fresh default Base profiles direct DKG
queries and registered-core snapshot recovery. Existing explicit profiles
remain unchanged. A returning client can also reuse its own verified assets;
that differs from a fresh client downloading from a warm core.

Enable **Lower RPC usage by using the DKG Core chain cache** with
`"DKG_Core_chain_cache": true` in the Edge's `config.json`. Upgraded cores
on an official deployment serve the cache by default; `false` disables it.
Mainnet accepts cores registered on any locally bundled official mainnet
chain; testnet uses the same code with only official testnet registries.
Neither environment accepts the other or an arbitrary private deployment.
Pre-deployment placeholders remain unavailable until their official configuration is ready.
The data graph keeps its own chain, Hub and numeric registration ID.

The peer signs a fresh challenge binding requester, responder, nonce, graph,
data chain/Hub and its separate registration chain/Hub. The Edge verifies the
operational key and active ShardingTable membership on that locally configured
registration deployment. A peer never nominates an RPC endpoint or contract.
Registration checks stay on the Edge; public inventory, version and root
reads are delegated to the cache core. Those are DKG records stored on-chain,
not arbitrary blockchain history, and transaction/publishing RPC is unchanged.

One job probes at most 16 hints, four concurrently, and pins at most four
verified cache sources. Official relay addresses, connected peers and bounded
phonebook results supply hints, not trust. Other cores are eligible if found
and reachable. Cache-only foreign peers may use only the two public cache
protocols. Normal networking, private graphs and publishing retain their
original network admission. The core validates public graph access, name,
finality and block consistency before supplying a snapshot.

The inventory supplier need not host the RDF content. Content is fetched from
up to sixteen data-network hints, admitted four at a time as recovery needs
more suppliers. Empty relays cannot exclude a later content host. Each asset
retains its identity/root verification. Start and final inventory comparisons, the job
lifetime, transfer deadlines and retries remain unchanged. Content export
caches and chain-inventory caches are distinct: the former improve repeated
content transfers; the latter reduce Edge RPC work.

The source policy in the authenticated snapshot job is `DKG_Core_chain_cache`.
The API advertises it only when the local node has it configured. The old
`base-mainnet-registered-cores` policy and explicit peer jobs remain compatible;
existing profiles are not silently widened. Completed jobs report physical
registry RPC counts in `chainCacheRpcUsage`, excluding unrelated node RPC.
The daemon's ordinary RPC telemetry includes those registry requests too.

## Local RPC measurement

A controlled 12-asset fixture uses real libp2p nodes, Oxigraph and deployed
local EVM contracts, with separate data and registration chain namespaces.
Both exact and opt-in bulk recovery committed all 12 public assets, excluded
private content and matched independent recovery's inventory. This exercises
cross-chain routing and verification; it is not a live multi-chain benchmark.

The two inventory observations took 22 direct RPC requests. Delegating them
left five Edge requests for operational-key and active-registration checks.
Including ordinary graph-authority work, the latest measured jobs used 16–19 Edge
requests, versus 42 for independent recovery. Ordinary authority work varies
with runtime state; these counts do not predict a whole-session bill or a
production latency. The core still pays for inventory cache misses/refreshes.

The Blackbox automatic profile requires this new local daemon capability.
DKG 10.0.25 supports explicit-core snapshot jobs but not this source policy;
older daemons fail with an upgrade requirement before transfer. Publish a
compatible DKG patch and update Blackbox's pinned package/integrity before
releasing the automatic onboarding default. Do not merge the companion
Blackbox draft against its current 10.0.25 installer pin.

## Rollout and validation

1. Upgrade a selected serving core first. Preserve its data directory and
   graph subscriptions. Existing explicit off switches remain effective.
2. Run one complete fresh-client sync to populate the cache. A truly empty
   cache still pays export and verification costs; startup does not launch
   an unbounded graph scan or compete with live queries.
3. Repeat with another fresh client, then restart the core and repeat again.
   Check prepared-cache hits and whole-payload export counts as well as time.
   All three runs must retain full identity/root coverage, current-snapshot
   evidence and the initial/final positive and negative query checks.
4. Test concurrent fresh clients and ordinary publishing/query traffic before
   rolling out to more cores. Preserve the existing deadlines and budgets.

The cache remains bounded to 1 GiB / 8,192 entries by default, with an absolute
maximum age of six hours. Expiry, eviction and newly published versions require
fresh preparation. Operators should size within the existing hard limits and
warm a newly provisioned core before directing onboarding traffic to it.
Automatic background prebuilding is separate from these defaults.

The observed 7m47s warm result is a measurement for one dataset, core and
client. Bandwidth, client commit speed, competing load, cache coverage and
dataset growth still affect completion time. It is not a latency guarantee.

## Rollback

- Set `DKG_Core_chain_cache` to `false` to disable this automatic cache capability.
- Set `preparedContentCache.enabled` to `false` to stop retaining disk copies.
- Set `DKG_EXACT_BATCH_STREAM_ENABLED=0` to disable the accelerated stream.
  The older `DKG_EXPERIMENTAL_EXACT_BATCH_STREAM=0` spelling is also honored
  when the current spelling is absent.

Neither switch removes graph data. Cache files are performance copies and
continue to be subject to the existing bounded ownership and retention rules.
