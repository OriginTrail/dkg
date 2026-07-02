# @origintrail-official/dkg-okf

Deterministic **Google Open Knowledge Format (OKF) → DKG** mapper.

OKF standardises *how* knowledge is written and exchanged — portable Markdown +
YAML frontmatter + untyped cross-links — but ships **no** verification,
provenance or ownership layer (OKF SPEC §1, §10). This package is the bridge: it
turns an OKF bundle into owned, verifiable RDF **Knowledge Assets**,
reconstructing the bundle's cross-concept link graph. The same portable Markdown,
now cryptographically provenanced, owned and shareable across agents.

Pure, no LLM, no network — the same bundle always yields **identical triples and
IRIs**.

## Use it from the CLI

```bash
# Deterministic, offline — prints the mapping summary, never touches a node
dkg okf import ./bundle --dry-run --print-nquads

# Import into a Context Graph (defaults to private Working Memory)
dkg okf import ./bundle --context-graph-id my-graph --create-context-graph

# Finalize + share to Shared Working Memory (free, team-visible)
dkg okf import ./bundle --context-graph-id my-graph --share

# Import into a private invite-only Context Graph; still one KA per concept
dkg okf import ./bundle --context-graph-id private-graph --private --create-context-graph

# Serialise a Context Graph back into a conformant OKF bundle (clean inverse)
dkg okf export my-graph ./out
```

Import defaults to **Working Memory** and never publishes to Verifiable Memory.
`--share` advances to **Shared Working Memory**. On-chain VM promotion (real
TRAC) is a separate, explicitly-gated operator step — see `DEMO.md`.
`--private` creates or uses an invite-only Context Graph and keeps the same
per-concept Knowledge Asset lifecycle, sharing each concept asset to SWM without
VM promotion.

## Use it as a library

```ts
import { loadBundleDir, importBundle, quadsToNQuads } from '@origintrail-official/dkg-okf';

const result = importBundle(loadBundleDir('./bundle'));
console.log(result.concepts.length, 'Knowledge Assets');
console.log(quadsToNQuads(result.quads)); // canonical, byte-stable N-Quads
```

## Docs

- **`CONTEXT.md`** — Language / Relationships / Flagged ambiguities.
- **`docs/adr/0005-okf-rdf-mapping.md`** — the locked OKF→RDF mapping and the
  reuse-vs-fork decision.
- **`docs/integrations/okf.md`** — the full-lifecycle article.
- **`DEMO.md`** — the live mainnet runbook (WM → SWM → join invitation → Hermes
  agent → rendered graph; VM promotion held as a deferred capstone).

License: Apache-2.0. The vendored `test/fixtures/crypto_bitcoin/` bundle is © Google
LLC, Apache-2.0 (see its `ATTRIBUTION`).
