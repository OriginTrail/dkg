# Attribution

This directory vendors Google's `crypto_bitcoin` OKF bundle verbatim, used as the
golden acceptance fixture for the OKF → DKG importer.

- **Source:** `GoogleCloudPlatform/knowledge-catalog`, path `okf/bundles/crypto_bitcoin/`
- **Pinned commit:** `d44368c15e38e7c92481c5992e4f9b5b421a801d`
- **Upstream:** https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/d44368c15e38e7c92481c5992e4f9b5b421a801d/okf/bundles/crypto_bitcoin
- **License:** Apache-2.0 (© Google LLC)

The `.md` files are unmodified copies. `viz.html` (a non-concept rendering asset)
is intentionally not vendored — the importer consumes only the Markdown concepts.
The bundle is the public `bigquery-public-data.crypto_bitcoin` dataset description
produced by the open-source `bitcoin-etl` pipeline.

Per OKF SPEC §3, the bundle ships **no** verification, provenance, or ownership
layer; that is exactly what the DKG integration adds.
