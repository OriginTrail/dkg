---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Ingest knowledge

**Inputs:** approved source, exact target graph, KA name, intended extraction pipeline, and allowed memory transition. Follow [the document guide](../../build/import-documents.md).

1. Discover the installed import tools and available extraction pipelines. Establish whether the pipeline calls an external model before sending confidential content to it.
2. Import to the selected WM KA. Preserve the returned assertion URI, file hash, and extraction record. Do not guess a filesystem path from an attachment name.
3. If `in_progress`, poll with a bounded wait. `completed` permits inspection; `skipped` means there may be no extracted triples; `failed` requires inspecting the error. A non-zero count on a failed extraction does not prove a successful partial write.
4. Read the resulting triples and completed source artifact. Structural extraction and semantic relationships are different outputs. Check the claims needed for the user's task, their identifiers, and their source provenance.
5. If authorized, propose/write missing semantic relationships through the node's supported enrichment/write path. Do not merge entities solely because their labels match. Keep inferred statements distinguishable from source statements.
6. Share only the intended, inspected knowledge when authorized. Publication requires the separate [publish procedure](publish-query.md).

**Done:** report the source/artifact identity, graph, KA, extraction outcome, inspected evidence, and current layer. A stored attachment alone is not a populated semantic graph.

**Recover:** inspect the existing named KA before retrying. For updates use the supported pull-from/edit lifecycle. A deletion of a local file does not establish removal of all replicated or published data.
