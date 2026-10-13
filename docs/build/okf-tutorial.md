---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Bring Google OKF knowledge into DKG

**Outcome:** map a small Open Knowledge Format bundle to RDF, inspect it in WM, then optionally share, query, verify, and export it. OKF is the portable content format; the DKG supplies graph operations and the optional publication/provenance lifecycle.

Use a healthy node and create a separate graph:

```bash
dkg context-graph create okf-atlas
CG='<exact ID printed by create>'
```

Download the supplied [`okf-atlas` folder](https://github.com/OriginTrail/dkg/tree/testnet-canary/examples/docs/okf-atlas) from the reviewed repository revision. It contains an index and two linked concepts, Atlas and Oxigraph. These are fictional tutorial records, with their own explicit frontmatter. The upstream format reference is [Google's OKF specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md).

## Preview, then import privately into WM

```bash
dkg okf import ./okf-atlas --dry-run --print-nquads
dkg okf import ./okf-atlas --context-graph-id "$CG"
```

The preview needs no node mutation. Expect two concepts and a mapped link from Atlas to Oxigraph. The import reports per-concept asset names/IRIs and a lifecycle manifest. Preserve that manifest for resumption. Inspect each reported KA with `dkg ka query <reported-name> -c "$CG"`.

The mapper is deterministic and does not need an LLM. A Markdown link maps to a general relationship unless you configure a typed mapping; it does not automatically become the `usesDatabase` predicate from the RDF quickstart. Query the vocabulary that was actually imported.

## Optionally share and query

Rerun the same import to advance the same concept assets to SWM:

```bash
dkg okf import ./okf-atlas --context-graph-id "$CG" --share
dkg query "$CG" --include-shared-memory -q 'SELECT ?concept ?related WHERE { GRAPH ?g { ?concept <http://schema.org/mentions> ?related } }'
dkg okf verify ./okf-atlas --context-graph-id "$CG"
```

Expect the Atlas-to-Oxigraph link. Verify is a mapped-data completeness check against the selected node view; it does not establish factual truth or an on-chain proof. Match the import's mapping options when verifying. At the 10.0.23 baseline verification is oriented toward SWM; use the current [command guide](../use-dkg/okf.md) for version-specific scope options.

Ask your agent to inspect the shared graph and explain the link with the source concept and SWM layer. A general `mentions` relationship supports “Atlas mentions Oxigraph”; deriving a more specific claim requires the concept text or an explicit typed relationship.

## Export

```bash
dkg okf export "$CG" ./okf-atlas-export --view shared-working-memory
```

Inspect the exported concept text, metadata, and links. Use `--view working-memory` to export the private WM view or `--view verifiable-memory` after publication. Do not describe a semantic export as a byte-for-byte copy of every original filesystem artifact.

## Optional publication

After a successful full share, select a reported KA name and follow the [publish guide](../use-dkg/publish-and-query.md). There is no implicit import-and-publish step. Check the network, author, funding, access policy, and user intent before publication. Inspect the completed result and UAL; an accepted async job alone is not completion.
