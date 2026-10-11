# Persistent prepared content for public graph recovery

A core may retain the verified, encoded body of each public Knowledge Asset (KA)
so later consumers can reuse it after a responder restart. This extends the
existing in-memory exact-asset export cache. It is a performance copy of immutable
content, not cached permission or chain authority.

## Configuration

The daemon and `DKGAgent.create` accept this opt-in setting:

```json
{
  "preparedContentCache": {
    "enabled": true,
    "maxBytes": 1073741824,
    "maxEntries": 8192,
    "ttlMs": 21600000
  }
}
```

The default directory is `<dataDir>/prepared-content-v1`. Without `dataDir`, an
absolute `directory` is required. Use a private local directory dedicated to one
node and backing store. Do not share it between running daemons or mount it as
an untrusted upload directory. The feature uses the existing exact-batch stream;
streaming must already be enabled on a serving core. It does not enable a
protocol or change graph subscriptions by itself.

## What is reused

The first successful root-verified export prepares the ordinary negotiated
compressed representation. After the source fence, its body and manifest are
published in one atomic file. The manifest contains a format version, full
cache key, encoded/plain sizes, creation time and SHA-256 of the encoded body.
The key binds the context graph, KA identity, assertion graph, full metadata
identity, assertion version, Merkle root, public/private counts and wire format.
Each file contains one bounded KA, not an entire graph or a new wire chunk.

Every hit first reads the current metadata and checks the public profile. The
responder's existing graph authority checks still run. A checksum, strict byte
bounds, absolute retention age and manifest-key equality validate the disk
copy before use. Metadata and available source write revisions are fenced again
before completing the asset. A changed version or any changed metadata selects
a different key. An unstable source revision cannot reuse a prepared copy.

Process-local write-generation numbers are deliberately absent from disk keys:
a restart can reuse a previously verified immutable assertion selected by the
same confirmed metadata. This is not a claim that present physical DATA has been
re-read. The receiver still authenticates the KA against its selected chain
snapshot and independently checks the payload root before commit.

Only the existing bounded public exact-asset profile is eligible. Private
commitments, non-public metadata and unsupported shapes retain existing refusal
or recovery behavior. Old versions become unreachable through changed metadata
and are eventually evicted. Cache deletion does not delete graph data.

## Resource and failure behavior

- Default retention is 1 GiB and 8,192 entries; hard operator ceilings are
  16 GiB and 65,536 entries. Absolute age is at most six hours.
- The existing per-asset encoded/inflated limits and responder memory budget
  also apply. A disk read holds a response-sized reservation; no whole-graph
  payload is loaded into memory.
- IO is serialized per cache instance and awaited inside the admitted response.
  No background persistence job can outlive its response. Concurrent cold misses
  may still prepare the same asset independently; this feature does not add a
  graph-wide preparation scheduler.
- Least-recently-used files are evicted to make room. Atomic rename prevents
  readers seeing a partially published file. Entries are rebuildable; cache
  persistence is not a new graph durability boundary.
- Missing, truncated, oversized, expired or corrupt copies are misses. IO failure
  falls back to verified export and emits one bounded warning per responder.
  Authorization, root and source-fence failures do not become cache misses.
- Only owned digest-named cache files are considered; file reads do not follow
  symlinks, and a symlinked cache root is refused. Unrelated files are untouched.

## Scope and measurement

This change removes repeated source export/canonicalization/compression after
restart. It cannot improve an already warm in-memory hit materially, and it adds
persistence work to a truly empty cache. Preparation cost is paid by the first
successful request, not hidden as free startup work.

The transport remains ten-asset requests with the existing two-asset window and
per-KA commit acknowledgements. 100 MB graph chunks, multiple suppliers,
background prebuilding, grouped local commits and a new protocol are separate
work. This cache does not remove receiver verification or storage commits.

The local 564-KA measurement compares fresh receivers and cold source caches,
then a restarted source using the persisted cache, plus RPC-only with a fresh
source cache. The restarted-source trial must record zero whole-payload exports
and complete identity/root coverage; elapsed time alone cannot prove reuse.

Completed local results: [564-KA comparison](prepared-content-cache-benchmark.md).
