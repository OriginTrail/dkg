# Attribution

This directory vendors Google's `acme_retail` OKF **v0.2** bundle verbatim, used as
the golden acceptance fixture for the v0.2 provenance / trust / lifecycle /
attestation families (SPEC §5, §10) of the OKF → DKG importer.

- **Source:** `GoogleCloudPlatform/open-knowledge-format`, path `bundles/acme_retail/`
- **Pinned commit:** `ad30107c31c06aec8a7d5636e0d1058118604e6f` (2026-08-21)
- **Upstream:** https://github.com/GoogleCloudPlatform/open-knowledge-format/tree/ad30107c31c06aec8a7d5636e0d1058118604e6f/bundles/acme_retail
- **License:** Apache-2.0 (© Google LLC)

The `.md` files are unmodified copies. `viz.html` (a non-concept rendering asset)
and `attesters/sql_equality.py` (the reference attester, referenced by
`attester.resource` and deliberately kept as a literal path by the importer) are
intentionally not vendored — the importer consumes only the Markdown concepts.
The bundle is a fictional US retailer's finance definitions: two `Attested
Computation` concepts, three metrics (one `status: deprecated`), two policies,
one executor skill and one BigQuery table, every one carrying `generated`,
`verified`, `status`, `stale_after` and/or `sources`.

Per OKF SPEC §1, the bundle records trust *signals* but ships no verification,
provenance or ownership layer of its own; that is exactly what the DKG
integration adds.
