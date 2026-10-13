---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Turn a document into agent knowledge

**Outcome:** import a document into Working Memory, inspect what was extracted, and let an agent answer from that evidence. Start with a healthy node and the exact Context Graph ID from the [quickstart](../getting-started/quickstart.md). Use documents you intend this node and its configured extraction providers to process.

## Supply a small document

Save this as `atlas-note.md`:

```markdown
# Atlas architecture note

Atlas uses Oxigraph to store its RDF graph. This is fictional tutorial data.
The project owner is the Atlas team.
```

```bash
dkg ka import-file atlas-note -c "$CG" --input-file ./atlas-note.md
dkg ka extraction-status atlas-note -c "$CG"
```

Import and semantic extraction are different stages. Inspect the node-served skill's available extraction pipelines and the returned status:

| Status | Meaning and next action |
| --- | --- |
| `in_progress` | Poll extraction status with a bounded wait |
| `completed` | Inspect the written triples and source artifact |
| `skipped` | The artifact was stored but extraction did not write triples; check converters/pipeline configuration |
| `failed` | Read the error and correct the cause; a reported count is not proof of a partial successful write |

A status lookup can return `404` if no import record exists or the tracker expired. Inspect the KA and import artifact before deciding to import again.

## Inspect and improve the knowledge

```bash
dkg ka query atlas-note -c "$CG"
```

Confirm what the pipeline actually extracted. Structural Markdown extraction may preserve document structure without creating the `usesDatabase` relationship. Semantic extraction can require a configured model and incur provider costs; its output needs review. Do not promise the same facts from every pipeline.

Ask the agent to read the completed import artifact through its discovered artifact-reading tool, inspect the KA, and propose missing relationships with source provenance. Review the proposed facts before it writes them. To learn a deterministic graph representation first, use the [five-triple fixture](../getting-started/quickstart.md#3-write-a-small-inspectable-fact).

Use stable IRIs for entities, predicates with documented meanings, and source identifiers for assertions. Two similar labels are not proof that two entities are identical. Keep source statements separate from model-inferred relationships.

## Retrieve, update, and share

In a fresh conversation under the same authorized identity, ask the agent to read `atlas-note` from `$CG`, answer only from the retrieved evidence, and identify the source and WM layer. If the relevant relationship is absent, the right result is a missing-evidence report.

WM writes are additive. For an existing shared/published KA, use the [pull-from/edit lifecycle](../use-dkg/knowledge-asset-lifecycle.md#editing-a-published-knowledge-asset); appending a contradictory fact does not replace an earlier value. Discard/recreate a draft only when that replacement is intended.

Seal and share only after reviewing the extracted content and destination policy:

```bash
dkg ka finalize atlas-note -c "$CG"
dkg ka share atlas-note -c "$CG"
```

Publication is a separate, funded decision. File deletion, removal from WM, removal from peers, and changing an on-chain commitment are different operations; do not promise global erasure from deleting a local file.
