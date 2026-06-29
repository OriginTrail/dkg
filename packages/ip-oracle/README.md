# @origintrail-official/dkg-ip-oracle

Engineering harness for an **IP / Patent Context Oracle** on the DKG, built on
the OKF→DKG integration. Generates a deterministic, **synthetic**
Google-Patents-shaped OKF corpus (no BigQuery dependency) for ingestion into a
**private** Context Graph.

> The data is SIMULATED. Every concept stamps `source: … [SIMULATED]` and a
> CC BY 4.0 licence. See [`CONTEXT.md`](./CONTEXT.md) for the design invariants.

## Generate a corpus

```bash
# 1k smoke sample
dkg ip-oracle generate ./out/h04l-1k --count 1000 --cpc-class H04L --seed 42

# import it into a PRIVATE Context Graph's Shared Working Memory (free, off-chain)
dkg okf import ./out/h04l-1k \
  --context-graph-id ip-oracle-patents-h04l \
  --private --create-context-graph
```

`--private` bulk-streams the reconstructed triples (citation + family + mention
edges) into the private CG's SWM as loose quads — no per-concept finalize, no
TRAC, nothing on-chain. Substance stays private.

## Library

```ts
import { generatePatentBundle, writePatentBundle } from '@origintrail-official/dkg-ip-oracle';

const files = generatePatentBundle({ cpcClass: 'H04L', count: 100, seed: 42 });
// or stream large corpora straight to disk:
writePatentBundle({ cpcClass: 'H04L', count: 100_000, seed: 42 }, './out');
```

Deterministic: same seed ⇒ byte-identical corpus.
