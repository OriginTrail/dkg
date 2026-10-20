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

Every registered Base mainnet core is eligible, without a hardcoded serving
peer. Connected peers and a bounded phonebook page provide routing hints.
Before selection the peer signs a fresh challenge naming both peers, the
graph, registration ID and exact chain/Hub deployment. The receiver verifies
the signature's operational key and active ShardingTable membership on its
configured chain. An unsigned phonebook role or copied wallet address cannot
establish eligibility.

One job probes at most 16 candidates, four concurrently, and pins at most four
verified sources. Candidate order varies by job to avoid a permanent first
core. Selection occurs inside the existing job deadline; new peers are not
added during transfer. The source protocol is available only on upgraded
Base cores hosting the public graph. Registration does not convert core-cache
chain statements into independently verified asset RPC evidence.

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

- Set `preparedContentCache.enabled` to `false` to stop retaining disk copies.
- Set `DKG_EXACT_BATCH_STREAM_ENABLED=0` to disable the accelerated stream.
  The older `DKG_EXPERIMENTAL_EXACT_BATCH_STREAM=0` spelling is also honored
  when the current spelling is absent.

Neither switch removes graph data. Cache files are performance copies and
continue to be subject to the existing bounded ownership and retention rules.
