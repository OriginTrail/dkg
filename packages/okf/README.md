# @origintrail-official/dkg-okf

Deterministic **Google Open Knowledge Format (OKF v0.2) → DKG** mapper.

OKF standardises *how* knowledge is written and exchanged — portable Markdown +
YAML frontmatter + untyped cross-links — and, since v0.2, *records* trust
signals: who generated a concept, who verified it, what it derives from, when
it goes stale, and how a number must be computed. What OKF deliberately does
**not** ship is a verification, provenance or ownership layer: a `verified`
entry is a string in a file, not a signature. This package is the bridge. It
turns an OKF bundle into owned, verifiable RDF **Knowledge Assets**,
reconstructing the bundle's cross-concept link graph and carrying every v0.2
family as queryable triples. The same portable Markdown, now cryptographically
provenanced, owned and shareable across agents.

Pure, no LLM, no network — the same bundle always yields **identical triples and
IRIs**.

## Use it from the CLI

```bash
# Deterministic, offline — prints the mapping + trust summary, never touches a node
dkg okf import ./bundle --dry-run --print-nquads

# Import into a Context Graph (defaults to private Working Memory)
dkg okf import ./bundle --context-graph-id my-graph --create-context-graph

# Finalize + share to Shared Working Memory (free, team-visible)
dkg okf import ./bundle --context-graph-id my-graph --share

# Import into a private invite-only Context Graph; still one KA per concept
dkg okf import ./bundle --context-graph-id private-graph --private --create-context-graph

# Serialise a Context Graph back into a conformant OKF v0.2 bundle (clean inverse)
dkg okf export my-graph ./out
```

Import defaults to **Working Memory** and never publishes to Verifiable Memory.
`--share` advances to **Shared Working Memory**. On-chain VM promotion (real
TRAC) is a separate, explicitly-gated operator step with `dkg ka publish` or
`dkg ka publish-async`.
`--private` creates or uses an invite-only Context Graph and keeps the same
per-concept Knowledge Asset lifecycle, sharing each concept asset to SWM without
VM promotion.

The import summary reports the §5 trust picture of the bundle alongside the
triple counts: `trustTiers` (human-reviewed / machine-confirmed / unverified),
`sources`, `derivedFromConcepts`, `draft`, `deprecated`, `stale` (evaluated
against the current time) and `attestedComputations`.

## Use it as a library

```ts
import { loadBundleDir, importBundle, quadsToNQuads, isStale } from '@origintrail-official/dkg-okf';

const result = importBundle(loadBundleDir('./bundle'));
console.log(result.concepts.length, 'Knowledge Assets');
console.log(quadsToNQuads(result.quads)); // canonical, byte-stable N-Quads

for (const c of result.concepts) {
  // §5.3 tier, §5.4 status, §5.5 stale_after, generated/verified/sources counts …
  console.log(c.conceptId, c.trust.tier, c.trust.status, isStale(c.trust.staleAfter));
}
```

## OKF v0.2 → RDF

Every triple is a pure function of the frontmatter; nothing is inferred from
prose. `type` is the only required key; every family is optional and its
absence carries meaning (an unverified concept is distinguishable from a
verified one, and is never rejected — SPEC §11).

| OKF (SPEC) | RDF on the concept subject | Notes |
|---|---|---|
| `type` | `rdf:type schema:<PascalCase>` | `Attested Computation` ↔ `schema:AttestedComputation` (exact spelling restored on export) |
| `title`, `description`, `tags`, `resource` | `schema:name`, `schema:description`, `schema:keywords`, `schema:url` | unchanged from v0.1 |
| `generated.at` / legacy `timestamp` (§5.2, §13.1) | `schema:dateModified` (xsd:dateTime) | one predicate for both versions; `generated.at` wins, a leftover `timestamp` is kept as `schema:timestamp` |
| `generated.by` (§5.2, §7) | `okf:generatedBy` (actor literal) | extra keys inside `generated` → `okf:generated.<key>` (see *Family extensions*) |
| `verified[]` (§5.2) | `okf:verification → okf:Verification` node: `okf:verifiedBy`, `okf:verifiedAt` | a bare `{ by, at }` is a one-element list; entry order is in the node IRI |
| derived tier (§5.3) | `okf:trustTier` = `machine-confirmed` \| `human-reviewed` | emitted only when a verifier exists; absent ⇒ `unverified` |
| `status` (§5.4) | `okf:status` | absent ⇒ `stable`, never materialised |
| `stale_after` (§5.5) | `okf:staleAfter` (xsd:dateTime) | staleness is `now >= stale_after`, computed by consumers (`isStale`) |
| `sources[]` (§5.1) | `okf:source → okf:Source` node: `schema:identifier` (`id`), `schema:name` (`title`), `okf:resource`, `okf:author`, `okf:usageCount`, `schema:dateModified` (`last_modified`), `okf:usageWindowFrom/To` | plus `prov:wasDerivedFrom <resource>` on the concept whenever the resource has an IRI |
| `usage_window` (§5.1) | `okf:usageWindowFrom`, `okf:usageWindowTo` | concept-level sibling; per-entry overrides sit on the source node; extra keys (e.g. `population`) → `okf:usage_window.<key>` on the same subject |
| `runtime`, `computation` (§10.2) | `okf:runtime`, `okf:computation` | |
| `parameters[]` (§10.2) | `okf:parameter → okf:Parameter` node: `schema:name`, `okf:parameterType`, `okf:required` | ordered by node IRI |
| `executor`, `attester` (§10.2) | `okf:executorResource`, `okf:executorReceipt` (one per field), `okf:attesterResource` | extra keys → `okf:executor.<key>` / `okf:attester.<key>` |
| body links (§6.1) | `schema:mentions` (untyped; opt-in `--relate` typing) | unchanged |
| legacy `# Citations` (§13.1) | `schema:citation` | still parsed for v0.1 documents |
| producer-defined keys (§4.1) | `schema:<camelKey>` | scalars typed; nested mappings as `rdf:JSON` literals so they round-trip as objects |

**Path-valued fields** (`resource`, `sources[].resource`, `computation`,
`executor.resource`, `attester.resource` — §6.2) resolve against the bundle: a
concept becomes a typed edge to its IRI (file-relative first, then the
bundle-root-relative reading Google's reference bundles use), an absolute URL
stays an IRI, and anything else (a `references/` artifact, an attester `.py`, a
scope descriptor) is kept as a literal.

**Family extensions.** A producer-defined key *inside* a family (§4.1 asks
consumers to preserve unknown keys) — `executor.timeout_s`,
`usage_window.population`, `verified[].note`, `sources[].sample_rate` — is
carried under `okf:<familyKey>.<key>` on the family's subject (the concept for
`generated` / `executor` / `attester` / `usage_window`, the entry's node for
`verified` / `sources` / `parameters`). The key is percent-encoded, so the
predicate is always IRI-safe (`okf:generated.sample%20rate`,
`okf:generated.caf%C3%A9`) and export restores the key exactly — unlike the
camelCase convention for top-level producer keys, which folds `timeout_s` to
`timeoutS`. `okfExtensionPredicate` / `okfExtensionKey` are the two directions.

**Each triple once.** An RDF store holds a set, so the mapper emits every
triple once: two sources naming the same resource yield two `okf:Source` nodes
but one `prov:wasDerivedFrom` edge, and `tags: [a, a]` yields one
`schema:keywords`. The mapped quad count is therefore exactly what a complete
import leaves in the store, which is what `dkg okf verify` compares against.

Namespaces: `okf:` = `http://dkg.io/ontology/okf/` (a sub-namespace of the DKG
ontology, so it never collides with the node's own `dkg:status` /
`dkg:trustLevel`), `prov:` = `http://www.w3.org/ns/prov#`.

### Round trip

`dkg okf export` is graph-faithful, not byte-faithful. The v0.2 families are
rebuilt in their original order; derived triples (`okf:trustTier`,
`prov:wasDerivedFrom`) are not written back and are re-derived on the next
import. A concept that only carries a last-modified time (a v0.1 import) is
written with the legacy `timestamp` key — `generated` requires a `by` actor and
the exporter never invents provenance. Entry order is restored from the node
IRIs, so it survives a graph that returns quads in any order. Known deviations:
`executor.receipt` comes back sorted (set semantics), a repeated list value
(`tags: [a, a]`) comes back once, concept paths come back in the recommended
absolute `/path.md` form, and an unquoted timestamp with an offset is folded to
UTC (same instant).

### Diagnostics

Everything the spec makes a SHOULD is a warning, never an error: a malformed
family (`generated` without `by`, an unknown `status`, a timestamp without an
explicit offset, an `Attested Computation` without `runtime`, …), a footnote
`[^label]` that joins no `sources[].id`, a `.md` path in a path-valued field
that names no concept, and an `okf_version` this consumer does not know (the
bundle is still consumed best-effort, §12).

## Docs

- **`CONTEXT.md`** — Language / Relationships / Flagged ambiguities.
- **`../../docs/use-dkg/okf.md`** — CLI import/export/verify lifecycle guide.
- **`DEMO.md`** — the live mainnet runbook (WM → SWM → join invitation → Hermes
  agent → rendered graph; VM promotion held as a deferred capstone).

License: Apache-2.0. The vendored `test/fixtures/crypto_bitcoin/` (v0.1) and
`test/fixtures/acme_retail/` (v0.2) bundles are © Google LLC, Apache-2.0 (see
their `ATTRIBUTION` files).
