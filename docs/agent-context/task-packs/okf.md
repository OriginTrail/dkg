---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Work with an OKF bundle

**Inputs:** bundle directory, exact target graph, mapping options, and intended layer. Start with the [supplied two-concept tutorial](../../build/okf-tutorial.md).

1. Run the offline dry-run mapping. Inspect concept count, resolved/broken links, conformance errors, and warnings. Do not run a mutating import if the expected mapping is unresolved.
2. Import into WM and retain the lifecycle manifest and reported per-concept KA names. Import does not publish on-chain.
3. Inspect the RDF actually produced. A general Markdown cross-link maps to a general relation; do not silently reinterpret it as a stronger domain claim.
4. If sharing is authorized, advance the same import with `--share` and confirm completion. Resume through its manifest after an interruption; do not use `--replace` unless replacement was intended.
5. Verify using the same mapping and scope options supported by the installed CLI. The 10.0.23 baseline verification is SWM-oriented; a completeness check is neither factual validation nor an on-chain proof.
6. Export the requested memory view to a new directory and inspect concept content and links. Never overwrite the user's original bundle as an incidental verification step.

**Done:** report mapping counts, warnings, exact graph, current layer, verification outcome/scope, and export location. For the sample, expect two concepts and one Atlas-to-Oxigraph `http://schema.org/mentions` link.

For optional VM publication, select the intended named KAs and follow [Publish and query](publish-query.md). Neither import nor export is implicit authorization to spend funds.
