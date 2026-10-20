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

The Blackbox managed-node profile already enables exact-batch streaming and
retains its local DKG store. It needs a serving core with the capability and
cache enabled, rather than a new Blackbox transport setting. A returning
client can also reuse its own verified assets; that differs from a fresh
client downloading from a warm core.

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
