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
sits one layer above: it assumes you already know how to call `dkg_assertion_*`
and focuses on **how to call them at scale, repeatedly, without losing data on
restart and without fragmenting the graph against parallel producers**.

## 1. The chunking contract (read first)

The daemon's `/api/assertion/<name>/{create,write,promote}` loop **is** the
chunked-write API. There is no `/api/import/bulk` and there will not be one
(see [ADR 0002](../../../../docs/adr/0002-importer-chunking-contract.md) for
the rejected-alternative analysis). To push a large graph you call the loop
many times, with each call staying under fixed budgets.

| Constant | Value | Where it lands |
|---|---|---|
| `CHUNK` | **5,000 quads** | Per `POST /api/assertion/<name>/write` call |
| `ROOT_CHUNK` | **1,000 URIs** | Per `POST /api/assertion/<name>/promote` `entities` array |
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
| `POST /api/assertion/<name>/write` | **10 MB** request body | `MAX_BODY_BYTES` | N-Quads payload too large | `HTTP 413` "Request body too large (>10485760 bytes)" |
| `POST /api/assertion/<name>/promote` | **256 KB** request body | `SMALL_BODY_BYTES` | `entities` array too long (~4,000+ URIs at 60-char average) | `HTTP 413` "Request body too large (>262144 bytes)" |
| `POST /api/assertion/<name>/promote` | **10 MB** gossip message | hard-coded in gossipsub publish | Promoted assertion's N-Quads serialisation exceeds 10 MB | `HTTP 500` "Promoted assertion too large for gossip (XXXX KB, limit 10 MB). Promote fewer entities per call." |

The two `/promote` caps are independent: the 256 KB body cap is on the
**request** you send (URI count × URI length); the 10 MB gossip cap is on the
**assertion** that ends up in SWM (triples × N-Quads length). It is possible
to hit the gossip cap with a single-URI `entities` array, if the assertion
under that root is large enough. `entities: "all"` triggers it most often
because it asks the daemon to gossip every root in one message; for any
assertion above ~30k triples, expect to split.

In practice this means a robust importer needs **two independent halve-and-
retry paths on `/promote`**: one for 413 (shrink the `entities` array) and
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
POST /api/assertion/create   { name, subGraphName, contextGraphId }
POST /api/assertion/<name>/write   { quads: [...] }   ── one or more times
POST /api/assertion/<name>/promote { entities: [...] }
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

for (const partition of partitions) {                       // one source artefact
  const triples = generateTriples(partition);               // ≤ tens of thousands typical
  const assertionName = `import-${partition.slug}`;
  await client.request('POST', '/api/assertion/create', {
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
import requests
token = open(os.path.expanduser('~/.dkg/auth.token')).read().strip()
H = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
BASE = f'http://localhost:{port}/api'
CHUNK = 5000
ROOT_CHUNK = 1000

def write_assertion(cg, name, sg, triples, entities):
    requests.post(f'{BASE}/assertion/create',
                  headers=H, json={'contextGraphId': cg, 'name': name, 'subGraphName': sg}).raise_for_status()
    for i in range(0, len(triples), CHUNK):
        requests.post(f'{BASE}/assertion/{name}/write',
                      headers=H, json={'contextGraphId': cg, 'subGraphName': sg,
                                        'quads': triples[i:i+CHUNK]}).raise_for_status()
    for i in range(0, len(entities), ROOT_CHUNK):
        requests.post(f'{BASE}/assertion/{name}/promote',
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

### HTTP 413 on `/write` (`MAX_BODY_BYTES` = 10 MB)

You exceeded the request-body cap with too many N-Quads. Halve and retry:

```ts
try {
  await client.writeOne(slice);
} catch (err) {
  if (err.statusCode !== 413) throw err;
  // Halve the chunk size for the next attempt; exponential backoff is fine.
  await client.writeOne(slice.slice(0, slice.length / 2));
  await client.writeOne(slice.slice(slice.length / 2));
}
```

If you hit 413 frequently on `/write`, check `/api/status` for the daemon's
current `importLimits` and tune your `CHUNK` constant down. Don't paper over
it by bumping retries.

### HTTP 413 on `/promote` (`SMALL_BODY_BYTES` = 256 KB)

This is a **different** 413 from the `/write` one: the promote route uses a
smaller body limit because its requests should be small (just root URIs).
You hit it by sending too many URIs in `entities` — roughly 4,000+ URIs at
typical lengths. Recovery is to shrink the `entities` array, not the
underlying assertion:

```ts
async function promoteRoots(assertion, roots, batchSize = 1000) {
  for (let i = 0; i < roots.length; i += batchSize) {
    const batch = roots.slice(i, i + batchSize);
    try {
      await client.request('POST', `/api/assertion/${assertion}/promote`, {
        contextGraphId: client.cgId, subGraphName, entities: batch,
      });
    } catch (err) {
      if (err.statusCode !== 413) throw err;
      // Smaller batch and retry the same range.
      i -= batchSize;
      batchSize = Math.max(50, Math.floor(batchSize / 2));
    }
  }
}
```

### HTTP 500 on `/promote` with "too large for gossip"

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
loops — they're orthogonal. PR #643's async promote queue removes both
failure modes by promoting one root at a time in the background; until that
lands, importers must implement both halve-and-retry paths.

### HTTP 401 / 403

Token problem, not a chunking problem. See
[`dkg-node/SKILL.md`](../dkg-node/SKILL.md) §4 "If you get 401 or 403 on a
protected route, diagnose in this order" — call `GET /api/agent/identity`
to confirm who the daemon thinks you are.

### Connection errors / 5xx

Standard retry with exponential backoff. The daemon does not implement
idempotency tokens, but `assertion/create` returns 200 for both first and
duplicate calls — safe to retry. `assertion/write` is also safe to retry
with the same payload (duplicate triples are deduped server-side). Retrying
`assertion/promote` is safe too.

### Daemon restart mid-import

WM survives restarts ([docs/bugs/wm-persistence-regression.md](../../../../docs/bugs/wm-persistence-regression.md)
characterises the bug fixed in OriginTrail/dkg#636-639). On resume,
`loadImportManifest` gives you the "where was I?" answer; if a particular
assertion's WM state is partial, you can either:

- **Retry the assertion** — `assertion/create` is idempotent and re-running
  `assertion/write` re-asserts the same triples (no duplication).
- **Discard the partial assertion** with `POST /api/assertion/<name>/discard`
  and start over from your last `done` partition.

## 6. Anti-patterns (don't do this)

- **Don't push a million-quad payload in one `/write` call.** It will hit 413
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
- **Don't call `/api/shared-memory/publish` mid-import.** That's the SWM → VM
  on-chain transition (costs TRAC, human-gated). It is **not** the
  `assertion/promote` step. Confusing the two is the most common
  "where did my money go?" mistake.

## 7. Cheat sheet

```
1. Decide your import id and partition keys (one per source artefact).
2. createImportManifest({ client, importId, partitions, subGraphName: 'meta' })
3. For each partition (≤ 4 concurrent):
   a. markPartitionStatus(..., 'in_progress')
   b. POST /api/assertion/create   { name, subGraphName, contextGraphId }
   c. POST /api/assertion/<name>/write   { quads }      // chunks of ≤ 5000
   d. POST /api/assertion/<name>/promote { entities }   // chunks of ≤ 1000 URIs
   e. markPartitionStatus(..., 'done')
4. On 413: halve chunk + retry.
5. On crash: loadImportManifest → pendingPartitions → resume from step 3.
6. (Optional, human-gated) /api/shared-memory/publish promotes SWM → VM.
```

## References

- [ADR 0002 — Importer chunking contract](../../../../docs/adr/0002-importer-chunking-contract.md)
- [ADR 0003 — Code-graph ontology convergence](../../../../docs/adr/0003-code-graph-ontology-convergence.md)
- [`scripts/lib/manifest.mjs`](../../../../scripts/lib/manifest.mjs) — reference manifest implementation
- [`scripts/lib/dkg-daemon.mjs`](../../../../scripts/lib/dkg-daemon.mjs) — `DkgClient` with built-in chunking
- [`scripts/lib/ontology.mjs`](../../../../scripts/lib/ontology.mjs) — canonical `code:*` ontology constants
- [`packages/cli/skills/dkg-node/SKILL.md`](../dkg-node/SKILL.md) — node API surface (auth, CGs, SWM/VM, SPARQL)
