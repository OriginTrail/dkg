---
name: dkg-importer
description: Bulk-import a large RDF graph (code graph, corpus, GitHub history, etc.) into a DKG node's working memory. Use this skill when you need to push more than a few thousand triples in a single import — it codifies the chunking budgets, the assertion-loop shape, the resumability manifest, and the canonical URI rules so your importer converges with every other importer in the workspace.
---

# DKG Importer Skill

This skill is the **agent-readable manual for bulk imports** against a DKG V10
node. If you are about to write more than a few thousand triples in one logical
operation — a code graph, a Markdown corpus, a GitHub issue archive, a
domain-specific dataset — read this first. It documents the contract every
existing in-tree importer follows, so the graphs you produce join naturally with
graphs other agents and the scanners produce.

For the general node API surface (auth, contextGraphs, SWM/VM publish, SPARQL)
see [`packages/cli/skills/dkg-node/SKILL.md`](../dkg-node/SKILL.md). This skill
sits one layer above: it assumes you already know how to call `dkg_knowledge_asset_*`
and focuses on **how to call them at scale, repeatedly, without losing data on
restart and without fragmenting the graph against parallel producers**.

## 1. The chunking contract (read first)

The daemon's `/api/knowledge-assets` create + `/api/knowledge-assets/<name>/{wm/write,swm/share}` loop **is** the
chunked-write API. There is no `/api/import/bulk` and there will not be one
(see [ADR 0002](../../../../docs/adr/0002-importer-chunking-contract.md) for
the rejected-alternative analysis). To push a large graph you call the loop
many times, with each call staying under fixed budgets.

| Constant | Value | Where it lands |
|---|---|---|
| `CHUNK` | **5,000 quads** | Per `POST /api/knowledge-assets/<name>/wm/write` call |
| `ROOT_CHUNK` | **1,000 URIs** | Per `POST /api/knowledge-assets/<name>/swm/share` `entities` array |
| Max concurrent writes within one assertion | **1** (sequential) | The daemon does not parallelise intra-assertion writes; the manifest in §3 tracks per-assertion state anyway |
| Max concurrent assertions | **4** | Safe across assertions; keeps memory bounded for laptop-class nodes |

These constants are conservative: a 5,000-quad N-Quads payload serialises at
roughly 1.0-1.5 MB, well under the daemon's 10 MB `MAX_BODY_BYTES` cap. Going
larger gives no throughput win and risks a 413 on URIs that serialise on the
heavy end.

### 1.1 Known daemon caps and the exact error strings they produce

These are the three hard caps you will hit if you push past the constants
above, with the verbatim error text the daemon emits. The cap source lives in
[`packages/cli/src/daemon/http-utils.ts`](../../../../packages/cli/src/daemon/http-utils.ts).

| Endpoint | Cap | Constant | Trigger | Error response |
|---|---|---|---|---|
| `POST /api/knowledge-assets/<name>/wm/write` | **10 MB** request body | `MAX_BODY_BYTES` | N-Quads payload too large | `HTTP 413` "Request body too large (>10485760 bytes)" |
| `POST /api/knowledge-assets/<name>/swm/share` | **256 KB** request body | `SMALL_BODY_BYTES` | `entities` array too long (~4,000+ URIs at 60-char average) | `HTTP 413` "Request body too large (>262144 bytes)" |
| `POST /api/knowledge-assets/<name>/swm/share` | **10 MB** gossip message | hard-coded in gossipsub publish | Promoted assertion's N-Quads serialisation exceeds 10 MB | `HTTP 500` "Promoted assertion too large for gossip (XXXX KB, limit 10 MB). Promote fewer entities per call." |

The two `/swm/share` caps are independent: the 256 KB body cap is on the
**request** you send (URI count × URI length); the 10 MB gossip cap is on the
**assertion** that ends up in SWM (triples × N-Quads length). It is possible
to hit the gossip cap with a single-URI `entities` array, if the assertion
under that root is large enough. `entities: "all"` triggers it most often
because it asks the daemon to gossip every root in one message; for any
assertion above ~30k triples, expect to split.

In practice this means a robust importer needs **two independent halve-and-
retry paths on `/swm/share`**: one for 413 (shrink the `entities` array) and
one for 500 (shrink the per-root scope or switch from `"all"` to explicit
batches of N ≤ 1000 root URIs). See [§5 Error handling](#5-error-handling)
for the recipes.

**Self-tune from `/api/status`.** Future versions of the daemon advertise their
current per-call limits at `/api/status` under an `importLimits` block. If
present, use those values — they reflect any operator-side tuning. If absent
(older daemon), use the constants above verbatim.

## 2. The write loop

For each logical slice of triples (one slice ≈ one source artefact: one file,
one PR, one document, one record group):

```
POST /api/knowledge-assets   { name, subGraphName, contextGraphId }
POST /api/knowledge-assets/<name>/wm/write   { quads: [...] }   ── one or more times
POST /api/knowledge-assets/<name>/swm/share { entities: [...] }
```

Reference implementation — see [`scripts/lib/dkg-daemon.mjs`](../../../../scripts/lib/dkg-daemon.mjs)
for `DkgClient`. `writeAssertion` auto-chunks at a conservative 500-triple
default (override via the second-argument `batchSize`); `promote` does **not**
chunk — split the `entities` array yourself before calling it for big imports.

### TypeScript sketch

```ts
import { DkgClient } from './scripts/lib/dkg-daemon.mjs';

const client = new DkgClient({ token: process.env.DKG_TOKEN });
await client.ensureProject({ id: 'my-corpus', name: 'My Corpus' });
await client.ensureSubGraph(client.cgId, 'code');

async function ensureAssertion(client, body) {
  try {
    await client.request('POST', '/api/knowledge-assets', body);
  } catch (err) {
    if (err.status === 400 && /already exists/i.test(JSON.stringify(err.body ?? err.message))) {
      return;
    }
    throw err;
  }
}

for (const partition of partitions) {                       // one source artefact
  const triples = generateTriples(partition);               // ≤ tens of thousands typical
  const assertionName = `import-${partition.slug}`;
  await ensureAssertion(client, {
    contextGraphId: client.cgId,
    name: assertionName,
    subGraphName: 'code',
  });
  await client.writeAssertion({                             // auto-chunks at 500 quads
    contextGraphId: client.cgId,
    assertionName,
    subGraphName: 'code',
    triples,
  }, { batchSize: 5000 });                                  // bump if your triples are small
  const entities = rootUrisFor(partition);
  for (let i = 0; i < entities.length; i += 1000) {         // chunk promote ourselves
    await client.promote({
      contextGraphId: client.cgId,
      assertionName,
      subGraphName: 'code',
      entities: entities.slice(i, i + 1000),
    });
  }
}
```

### Python sketch

```python
import os
import requests

PORT = int(os.environ.get('DKG_PORT', '9200'))
TOKEN_PATH = os.path.expanduser('~/.dkg/auth.token')
with open(TOKEN_PATH) as f:
    token = f.read().strip()
H = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
BASE = f'http://localhost:{PORT}/api'
CHUNK = 5000
ROOT_CHUNK = 1000

def ensure_assertion(cg, name, sg):
    res = requests.post(f'{BASE}/knowledge-assets',
                        headers=H, json={'contextGraphId': cg, 'name': name, 'subGraphName': sg})
    if res.status_code == 400 and 'already exists' in res.text.lower():
        return
    res.raise_for_status()

def write_assertion(cg, name, sg, triples, entities):
    ensure_assertion(cg, name, sg)
    for i in range(0, len(triples), CHUNK):
        requests.post(f'{BASE}/knowledge-assets/{name}/wm/write',
                      headers=H, json={'contextGraphId': cg, 'subGraphName': sg,
                                        'quads': triples[i:i+CHUNK]}).raise_for_status()
    for i in range(0, len(entities), ROOT_CHUNK):
        requests.post(f'{BASE}/knowledge-assets/{name}/swm/share',
                      headers=H, json={'contextGraphId': cg, 'subGraphName': sg,
                                        'entities': entities[i:i+ROOT_CHUNK]}).raise_for_status()
```

## 3. Resumability via the import manifest

A 10,000-partition import that fails on partition 7,453 must not start over
from partition 1. The pattern is a small RDF manifest assertion the importer
maintains as it works. The reference implementation lives in
[`scripts/lib/manifest.mjs`](../../../../scripts/lib/manifest.mjs).

### Setup

```ts
import { createImportManifest, markPartitionStatus, loadImportManifest, pendingPartitions }
  from './scripts/lib/manifest.mjs';

const importId = 'my-corpus-2026-01-15';
const partitions = enumerateSourceArtefacts().map((p) => p.key);   // strings, one per slice
await createImportManifest({
  client, importId, partitions, subGraphName: 'meta',
});
```

`createImportManifest` writes a single `urn:dkg:import:<id>` assertion to the
`meta` sub-graph listing every partition with `initialStatus = "pending"`.
Manifests follow the chunking contract automatically: the import root **and**
every partition URI are promoted to SWM in chunks of `ROOT_CHUNK ≤ 1000` so a
peer node (or this node after a restart) can read the manifest back from SWM
to resume — promoting only the root would leave partition triples in WM only.

### Per-partition lifecycle

```ts
for (const part of partitions) {
  await markPartitionStatus({
    client, importId, partitionKey: part, status: 'in_progress', subGraphName: 'meta',
  });
  try {
    await importOne(part);
    await markPartitionStatus({ client, importId, partitionKey: part, status: 'done', subGraphName: 'meta' });
  } catch (err) {
    await markPartitionStatus({ client, importId, partitionKey: part, status: 'failed', subGraphName: 'meta' });
    throw err;       // or continue, depending on policy
  }
}
```

Status events are append-only — each `markPartitionStatus` call writes a fresh
`StatusEvent` triple with a timestamp **and promotes BOTH the partition root
and the new event root to SWM** so peers (or a resume on a different node)
see the progress, not just the local WM. (The promote root list is `[partIri,
evIri]` because the new `partIri imp:statusEvent evIri` edge has subject
`partIri`; promoting only `evIri` would leave that edge in WM and a peer-side
`loadImportManifest` would never observe the new status.)
`loadImportManifest` resolves the "current" status as the latest event per
partition using a standard "max row" SPARQL pattern (`FILTER NOT EXISTS`
against any later event), which avoids the classic `SAMPLE`+`MAX`
decorrelation foot-gun. This append-only pattern also avoids needing SPARQL
DELETE/INSERT and gives you a complete audit trail for free.

### Resume

```ts
const { partitions: state } = await loadImportManifest({ client, importId, subGraphName: 'meta' });
const pending = pendingPartitions(state);
for (const part of pending) {
  await importOne(part.key);   // pick up where we left off
}
```

## 4. Canonical URIs (look-before-mint)

If your import is producing nodes that other producers also produce — files,
packages, GitHub PRs, etc. — **reuse their URIs**, don't fork a new namespace.

Canonical patterns ([ADR 0003](../../../../docs/adr/0003-code-graph-ontology-convergence.md)):

```
urn:dkg:code:package:<pkgName>                  Package (workspace name)
urn:dkg:code:file:<pkgName>/<relPath>           Source file (relPath ≡ path inside the package)
urn:dkg:github:repo:<owner>/<name>              GitHub repo node
urn:dkg:github:pr:<owner>/<name>/<num>          GitHub PR
urn:dkg:github:issue:<owner>/<name>/<num>       GitHub issue
urn:dkg:import:<id>                             Your own import manifest
```

**Encoding rule**: every path segment is `encodeURIComponent`'d. A file with
spaces, `@`, `+`, parens, etc. would otherwise produce an IRI Oxigraph
rejects with `Invalid IRI code point`.

**Pre-mint check:**
1. Compute the normalised slug for your would-be URI (lowercase → ASCII-fold →
   strip stopwords → hyphenate → ≤60 chars).
2. Call `dkg_memory_search` with the unnormalised label.
3. If any hit's normalised slug matches yours, **reuse the existing URI** —
   prefer hits in higher layers (VM > SWM > WM).
4. Otherwise mint per the pattern above.

If you're producing the canonical code-graph triples for the workspace's own
packages, use the helpers in [`scripts/lib/ontology.mjs`](../../../../scripts/lib/ontology.mjs)
rather than redeclaring class/property IRIs.

## 5. Error handling

### HTTP 413 on `/wm/write` (`MAX_BODY_BYTES` = 10 MB)

You exceeded the request-body cap with too many N-Quads. Halve and retry:

```ts
try {
  await client.writeOne(slice);
} catch (err) {
  if (err.status !== 413) throw err;
  // Halve the chunk size for the next attempt; exponential backoff is fine.
  await client.writeOne(slice.slice(0, slice.length / 2));
  await client.writeOne(slice.slice(slice.length / 2));
}
```

If you hit 413 frequently on `/wm/write`, check `/api/status` for the daemon's
current `importLimits` and tune your `CHUNK` constant down. Don't paper over
it by bumping retries.

### HTTP 413 on `/swm/share` (`SMALL_BODY_BYTES` = 256 KB)

This is a **different** 413 from the `/wm/write` one: the share route uses a
smaller body limit because its requests should be small (just root URIs).
You hit it by sending too many URIs in `entities` — roughly 4,000+ URIs at
typical lengths. Recovery is to shrink the `entities` array, not the
underlying assertion:

```ts
async function promoteRoots(assertion, roots, batchSize = 1000) {
  for (let i = 0; i < roots.length; i += batchSize) {
    const batch = roots.slice(i, i + batchSize);
    try {
      await client.request('POST', `/api/knowledge-assets/${assertion}/swm/share`, {
        contextGraphId: client.cgId, subGraphName, entities: batch,
      });
    } catch (err) {
      if (err.status !== 413) throw err;
      // Smaller batch and retry the same range.
      i -= batchSize;
      batchSize = Math.max(50, Math.floor(batchSize / 2));
    }
  }
}
```

### HTTP 500 on `/swm/share` with "too large for gossip"

The assertion you're promoting serialises to more than 10 MB of N-Quads.
This is independent of how many root URIs you pass — even
`entities: ["<one-uri>"]` can trip this if that one root's transitive
triple set is bigger than 10 MB. The error message is verbatim:

```
HTTP 500 "Promoted assertion too large for gossip
(XXXX KB, limit 10 MB). Promote fewer entities per call."
```

Recovery is to **shrink the per-promote scope**, which means: if you were
promoting with `entities: "all"`, switch to an explicit URI batch sized so
its transitive triples land under 10 MB. There is no formula because triple
fan-out varies; in practice 500-1000 roots per call works for code graphs
and 100-200 for prose corpora with long string literals.

```ts
async function promoteAllInBatches(assertion, allRoots) {
  let batch = 1000;
  for (let i = 0; i < allRoots.length; i += batch) {
    try {
      await promoteRoots(assertion, allRoots.slice(i, i + batch));
    } catch (err) {
      if (!/too large for gossip/.test(err.message)) throw err;
      i -= batch;
      batch = Math.max(50, Math.floor(batch / 2));
    }
  }
}
```

If both 413 and 500-gossip fire on the same import, you need both recovery
loops — they're orthogonal. **As of PR #4 the daemon ships an
in-process async promote queue** (`POST /api/knowledge-assets/<name>/swm/share-async`)
that removes both failure modes by promoting one classifying-and-retrying
job at a time in the background. See [§6 Async promote queue](#6-async-promote-queue)
for the new contract — for a fresh importer, prefer the async path and skip
both halve-and-retry loops above.

### HTTP 401 / 403

Token problem, not a chunking problem. See
[`dkg-node/SKILL.md`](../dkg-node/SKILL.md) §4 "If you get 401 or 403 on a
protected route, diagnose in this order" — call `GET /api/agent/identity`
to confirm who the daemon thinks you are.

### Connection errors / 5xx

Standard retry with exponential backoff. The daemon does not implement
idempotency tokens. `wm/write` is safe to retry with the same payload
(duplicate triples are deduped server-side), and retrying `swm/share`
is safe too. Raw `POST /api/knowledge-assets` (create) returns HTTP 400 when the
assertion already exists; higher-level helpers can normalize that into
idempotent success by treating an `already exists` response as reuse.

### Daemon restart mid-import

WM survives restarts ([docs/bugs/wm-persistence-regression.md](../../../../docs/bugs/wm-persistence-regression.md)
characterises the bug fixed in OriginTrail/dkg#636-639). On resume,
`loadImportManifest` gives you the "where was I?" answer; if a particular
assertion's WM state is partial, you can either:

- **Retry the assertion** — treat `POST /api/knowledge-assets` (create) "already exists" as reuse
  (or call a helper that does), then re-run `wm/write` to re-assert the
  same triples without duplication.
- **Discard the partial assertion** with `POST /api/knowledge-assets/<name>/wm/discard`
  and start over from your last `done` partition.

### HTTP 400 on finalize/publish with `Rule 4: rootEntity ... already exists`

This is the **#1 trap for "real-world" graph importers** — Wikidata, schema.org,
Graphify-style code graphs, EPCIS event streams, anything where the same
subject URI legitimately appears across many logical artefacts. It fires from
the daemon's `autoPartition` step (during `finalize: true` on `create`, or as
part of `/api/knowledge-assets/{name}/vm/publish`) and looks like:

```
HTTP 400 "Rule 4 violation: rootEntity <http://www.wikidata.org/entity/Q2831>
already exists as the root of knowledge collection 17 in context graph 4.
Use POST /api/update to extend the existing knowledge collection."
```

**The rule**: every Knowledge Asset (KA) within a context graph has exactly
one root entity, and a given subject URI can be the root of **at most one KA
per CG**. Multiple KAs sharing a root would make on-chain ownership /
attribution ambiguous, so the contract enforces uniqueness. The error
message's `/api/update` hint is correct *if you want to extend the existing
KA* — but for a bulk import producing many KAs that mention the same
entities ("Michael Jackson appears in 500 of my 5,000 album KAs"), updating
isn't what you want. You want each KA to have its own unrelated root.

**The fix — partition-scoped blank-node rewrite**. Before submitting quads
for partition `N`, rewrite every Wikidata / external URI to a partition-scoped
blank node and anchor them under a single, unique-per-partition root:

```ts
function buildPartitionQuads(partitionIdx, rawQuads, anchorUri) {
  // 1. Mint one partition-scoped anchor — this becomes the KA's sole root.
  //    URI is unique per partition; blank nodes underneath it inherit
  //    partition scope so Q2831 in partition 17 != Q2831 in partition 18
  //    from the contract's perspective.
  const anchor = `<${anchorUri}>`;     // e.g. urn:dkg:miles-stress:partition:17
  const blankFor = new Map();          // subject-URI -> deterministic _:bN
  let bnCounter = 0;
  const blankNodeFor = (uri) => {
    if (!blankFor.has(uri)) {
      // Deterministic skolem-ish label keeps the rewrite repeatable across
      // resume runs without coordinating state.
      blankFor.set(uri, `_:p${partitionIdx}_b${bnCounter++}`);
    }
    return blankFor.get(uri);
  };

  // 2. Rewrite every non-anchor URI in the subject (and object, when an IRI)
  //    position to its partition-scoped blank node.
  //
  // Detect IRIs generically via the RFC 3986 scheme grammar rather than
  // hard-coding a scheme list. Earlier drafts checked only `http` / `urn:`,
  // which silently misses valid RDF IRIs that use other schemes — `did:`,
  // `ipfs:`, `tag:`, `file:`, plain-IRI imports etc. — and lets colliding
  // root entities leak through to keep hitting Rule 4 on subsequent
  // partitions. If your parser exposes `term.termType === 'NamedNode'`,
  // prefer that over the regex.
  const ABS_IRI = /^[A-Za-z][A-Za-z0-9+\-.]*:/;
  const isIri = (s) => ABS_IRI.test(s);
  const out = [];
  for (const { s, p, o } of rawQuads) {
    const subj = isIri(s) ? blankNodeFor(s) : s;
    const obj  = (o.kind === 'iri' && o.value !== anchorUri)
      ? blankNodeFor(o.value)
      : serializeObject(o);
    out.push(`${subj} <${p}> ${obj} .`);
  }

  // 3. Link the anchor to every rewritten root with `<anchor> stress:contains <_:bN>`
  //    so the KA's transitive triple set is reachable from the single root.
  for (const blank of new Set(blankFor.values())) {
    out.push(`${anchor} <urn:dkg:stress:contains> ${blank} .`);
  }
  out.push(`${anchor} a <urn:dkg:stress:Partition> .`);
  return out;
}
```

The result: each KA has **one** root (the anchor), every Wikidata URI inside
appears only as a blank-node label, and partitions sharing entities don't
collide. Battle-tested in `scripts/testnet-publish-stress/publish-loop.mjs`
(Base Sepolia, `miles-publish-stress-26may`, 5000-partition stress run); see
that file for a full reference implementation including pace-control,
checkpointing and retry-with-unique-name.

If your data has a natural "real" root that's already unique per artefact
(e.g. an EPCIS event ID, a GitHub PR URL, a build ID), use that as the
anchor instead of minting a synthetic one — the blank-node rewrite still
applies for everything *under* it.

Both the synchronous per-KA `/api/knowledge-assets/{name}/vm/publish` and the async promote queue
run through `autoPartition`, so this trap exists on both paths. Fix it
at the importer level, before any quads reach the daemon.

## 6. Async promote queue

As of PR #4 in the async-promote-queue series the daemon ships an in-process
queue that converts the synchronous `POST /api/knowledge-assets/<name>/swm/share`
round-trip into a fire-and-forget enqueue. For bulk imports — where the
synchronous promote round-trip is the bottleneck — this is the recommended
path. See [`docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md`](../../../../docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md)
for the design and `packages/cli/skills/dkg-node/SKILL.md` §8 for the
in-daemon worker configuration.

### Why use it

The synchronous `/swm/share` route blocks on SWM insert + gossip publish. For a
multi-thousand-partition import that's the single biggest source of wall-clock
time: tens of minutes spent in the 413 / 500-gossip halve-and-retry recipes in
[§5](#5-error-handling). The async route returns `HTTP 202 { jobId, state:
"queued" }` immediately; an in-daemon worker dequeues, runs the same promote
logic, and writes the result back into a Control Graph for inspection.

You still need to chunk **writes** at `CHUNK=5,000` per §1 — that cap hasn't
changed. The async queue specifically targets the **promote** half of the
loop.

### Route inventory

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/knowledge-assets/<name>/swm/share-async` | Enqueue. Body: `{ contextGraphId, entities?: [...] \| "all", subGraphName? }`. Returns `202 { jobId, state: "queued", enqueuedAt }`. Returns `409 { existingJobId }` if there is already an active job for the same `(contextGraphId, subGraphName, name)`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs` | List jobs. Query: `state=queued,running,failed_retrying,succeeded,failed` (comma-separated), `contextGraphId=...`, `limit=N`. Returns `{ jobs: [...] }`. |
| `GET`  | `/api/knowledge-assets/swm/share-jobs/<jobId>` | Read one job: `state`, `attempt.count`, `commitMarker`, `result`, `attempt.lastError` with `classification: transient\|cap_exceeded\|fatal`. |
| `DELETE` | `/api/knowledge-assets/swm/share-jobs/<jobId>` | Cancel a `queued` / `failed_retrying` job. `409` if the job is `running` (let the lease expire). |
| `POST` | `/api/knowledge-assets/swm/share-jobs/<jobId>/recover` | Re-queue a `failed` job after fixing whatever was wrong (subdivide an over-large entity set, restart an upstream, etc.). |

### The async write loop

Identical to §2 right up to the promote step, then swap the synchronous
call for the enqueue + poll-or-fire-and-forget pattern:

```ts
for (const part of partitions) {
  await markPartitionStatus({ client, importId, partitionKey: part.key, status: 'in_progress', subGraphName: 'meta' });

  // CREATE + WRITE — unchanged from §2.
  await client.request('POST', '/api/knowledge-assets', { name: part.assertion, subGraphName: part.subGraphName, contextGraphId: client.cgId });
  for (const slice of chunks(part.quads, 5000)) {
    await client.writeAssertion({ contextGraphId: client.cgId, assertionName: part.assertion, subGraphName: part.subGraphName, triples: slice });
  }

  // PROMOTE — async path. Returns immediately; the worker takes over.
  const { jobId } = await client.request(
    'POST',
    `/api/knowledge-assets/${encodeURIComponent(part.assertion)}/swm/share-async`,
    { contextGraphId: client.cgId, subGraphName: part.subGraphName, entities: part.roots },
  );

  // For a typical importer: track the jobId in your own state and move on.
  // Mark partition `done` only after the job reaches state="succeeded".
  await trackAsyncPromote({ client, jobId, partitionKey: part.key });
}
```

`trackAsyncPromote` can either:

- **Poll** `GET /api/knowledge-assets/swm/share-jobs/<jobId>` on a backoff until
  `state === "succeeded"` (call `markPartitionStatus(..., 'done')` then) or
  `state === "failed"` (recover or escalate per §6 below). Use a 250-1000ms
  interval — the worker polls the queue at ~100ms by default.
- **Fire-and-forget**: keep the `jobId` in the manifest as a `partitionStatus`
  metadata field and let a separate reconciliation pass at the end of the
  import walk all in-flight jobs to a terminal state.

### Failure classification (`attempt.lastError.classification`)

The worker classifies every failure into one of three buckets. Read it from
`GET /api/knowledge-assets/swm/share-jobs/<jobId>`:

| Classification | Retry? | Typical cause | Importer action |
|---|---|---|---|
| `transient` | yes (until `maxRetries=5` reached) | `fetch failed` / `ECONNRESET` / `timeout` | Wait — the worker auto-retries with backoff. No-op for the importer until the job leaves `failed_retrying`. |
| `cap_exceeded` | no | `Promoted assertion too large for gossip` (10 MB) or `Request body too large` (256 KB) | Re-enqueue with a smaller `entities` slice (the queue can't subdivide on its own — that's a future enhancement). Same halve-and-retry shape as the synchronous recipe, just applied at the queue layer. |
| `fatal` | no | Bad request, missing assertion, etc. | Inspect the error message, fix the cause, then `POST /api/knowledge-assets/swm/share-jobs/<jobId>/recover` to re-queue. |

Note that `cap_exceeded` jobs reach `state: "failed"`, not `failed_retrying`,
because retrying the same payload would just hit the cap again. The importer
is on the hook for subdivision — see [§5](#5-error-handling) for the same
halve-and-retry recipe, except you re-enqueue rather than retry inline.

### Migration from synchronous `/swm/share`

The synchronous route is **not** deprecated. Use it when:

- You're doing a small interactive import (single assertion, single promote)
  and the round-trip cost is below your latency budget.
- Your client doesn't want to track job IDs or implement polling.
- You explicitly need the SWM-insert-and-gossip-complete signal in-band.

Otherwise, prefer `/swm/share-async`. The contract is identical (same body
shape, same chunking budgets, same per-root semantics) — the only difference
is **when** the SWM insert lands.

### Inspecting the queue in-flight

A running import can be inspected without interrupting it:

```bash
# Everything still queued for this context graph
curl -H "Authorization: Bearer $DKG_TOKEN" \
  "http://localhost:9200/api/knowledge-assets/swm/share-jobs?contextGraphId=$CG_ID&state=queued,running"

# Anything that failed and is waiting on operator action
curl -H "Authorization: Bearer $DKG_TOKEN" \
  "http://localhost:9200/api/knowledge-assets/swm/share-jobs?state=failed&contextGraphId=$CG_ID"
```

This is the queue-level view; per-partition state still lives in the
manifest in §3. The two are complementary: the manifest tracks logical
progress (`pending` → `in_progress` → `done`); the queue tracks the
mechanical promote step. A partition stays `in_progress` while its
promote job is queued / running.

## 7. Anti-patterns (don't do this)

- **Don't push a million-quad payload in one `/wm/write` call.** It will hit 413
  and you'll learn the chunk size the slow way.
- **Don't invent a new URI namespace for nodes that already exist** — fork the
  schema and merge later with `owl:sameAs` ([ADR 0003 §Reconciliation](../../../../docs/adr/0003-code-graph-ontology-convergence.md#reconciliation))
  is the recovery path, not the steady state.
- **Don't promote URIs you haven't actually written triples for.** The daemon
  silently accepts ghost-promotes; the resulting SWM looks valid but contains
  no data.
- **Don't skip the manifest because "this import will only take 30 seconds".**
  30-second imports are exactly the ones interrupted by a laptop sleep / OS
  update / coffee refill that breaks the network. Manifest cost is one
  assertion; restart cost without one is the entire import.
- **Don't `await Promise.all(partitions.map(importOne))` with N > 4.** The
  daemon serialises intra-assertion writes anyway; >4 concurrent assertions
  just inflates memory pressure without throughput gain.
- **Don't call `/api/knowledge-assets/{name}/vm/publish` mid-import.** That's the SWM → VM
  on-chain transition (costs TRAC, human-gated). It is **not** the
  `/swm/share` (WM → SWM share) step. Confusing the two is the most common
  "where did my money go?" mistake.
- **Don't publish multiple KAs with overlapping subject URIs in the same CG.**
  The contract enforces "one root per KA per CG" (Rule 4) — if your raw data
  has subjects that recur across artefacts (very common: Wikidata, schema.org,
  any real-world knowledge graph), apply the partition-scoped blank-node
  rewrite in [§5 "HTTP 400 with `Rule 4`"](#http-400-on-finalizepublish-with-rule-4-rootentity--already-exists)
  before any quads reach the daemon. The error message will tell you to use
  `/api/update`, which is correct for "extend an existing KA" but wrong for
  "produce many independent KAs that happen to mention the same entities".

## 8. Cheat sheet

### Synchronous loop (small / interactive imports)

```
1. Decide your import id and partition keys (one per source artefact).
2. createImportManifest({ client, importId, partitions, subGraphName: 'meta' })
3. For each partition (≤ 4 concurrent):
   a. markPartitionStatus(..., 'in_progress')
   b. POST /api/knowledge-assets   { name, subGraphName, contextGraphId }
   c. POST /api/knowledge-assets/<name>/wm/write   { quads }      // chunks of ≤ 5000
   d. POST /api/knowledge-assets/<name>/swm/share { entities }   // chunks of ≤ 1000 URIs
   e. markPartitionStatus(..., 'done')
4. On 413: halve chunk + retry.
5. On crash: loadImportManifest → pendingPartitions → resume from step 3.
6. (Optional, human-gated) per-KA /api/knowledge-assets/{name}/vm/publish mints a sealed KA SWM → VM.
```

### Async loop (bulk imports — recommended for >100 partitions)

```
1. Decide your import id and partition keys.
2. createImportManifest({ client, importId, partitions, subGraphName: 'meta' })
3. For each partition (≤ 4 concurrent):
   a. markPartitionStatus(..., 'in_progress')
   b. POST /api/knowledge-assets   { name, subGraphName, contextGraphId }
   c. POST /api/knowledge-assets/<name>/wm/write   { quads }      // chunks of ≤ 5000
   d. POST /api/knowledge-assets/<name>/swm/share-async { entities }   // returns 202 { jobId }
   e. Persist jobId; do NOT mark partition done yet.
4. Reconciliation pass: for each in-flight jobId,
     GET /api/knowledge-assets/swm/share-jobs/<jobId> until state ∈ {succeeded, failed}.
     - succeeded → markPartitionStatus(..., 'done')
     - failed + classification=cap_exceeded → subdivide entities + re-enqueue
     - failed + classification=fatal → fix root cause + POST .../recover
     - failed_retrying → wait; worker will auto-retry transient errors
5. On crash: loadImportManifest → pendingPartitions → resume from step 3.
6. (Optional, human-gated) per-KA /api/knowledge-assets/{name}/vm/publish mints a sealed KA SWM → VM.
```

## References

- [ADR 0002 — Importer chunking contract](../../../../docs/adr/0002-importer-chunking-contract.md)
- [ADR 0003 — Code-graph ontology convergence](../../../../docs/adr/0003-code-graph-ontology-convergence.md)
- [SPEC — Async promote queue (WM → SWM)](../../../../docs/specs/SPEC_ASYNC_PROMOTE_QUEUE.md)
- [`scripts/lib/manifest.mjs`](../../../../scripts/lib/manifest.mjs) — reference manifest implementation
- [`scripts/lib/dkg-daemon.mjs`](../../../../scripts/lib/dkg-daemon.mjs) — `DkgClient` with built-in chunking
- [`scripts/lib/ontology.mjs`](../../../../scripts/lib/ontology.mjs) — canonical `code:*` ontology constants
- [`packages/cli/skills/dkg-node/SKILL.md`](../dkg-node/SKILL.md) — node API surface (auth, CGs, SWM/VM, SPARQL), incl. §8 async promote queue worker config
