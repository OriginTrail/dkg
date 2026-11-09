---
status: current
version: v10
audience: agent+human
doc_type: playbook
---

# Retrieve, write, share, and publish

**Inputs:** exact graph, authorized caller, task, intended memory layer, and any existing KA/job identifiers. Discover tool schemas first: MCP/HTTP commonly use `contextGraphId`; Hermes/OpenClaw expose fields such as `context_graph_id`. Do not infer compatibility from a similar tool name.

## Retrieve evidence

1. Check caller identity and the exact graph. Use memory search for recall, or inspect vocabulary and use SPARQL for a structured question.
2. Select the intended view: `working-memory`, `shared-working-memory`, or `verifiable-memory`. Use named graph patterns when data is routed into named graphs.
3. Inspect returned rows and source identifiers. If empty, check scope, permission, layer, and sync before concluding that no evidence exists.
4. Report the answer with its source, layer, and available version/commitment. Re-read when freshness matters.

## Write and share

1. Create/select a named WM KA in the authorized graph.
2. Write source-backed RDF. Inspect the returned quads before progressing.
3. Seal the draft. This is an author attestation, not an on-chain transaction.
4. Share when the task authorizes peer visibility. A full share can seal automatically; use the installed contract and keep a single explicit lifecycle in the task.
5. Inspect completion and any nested errors. A `207` or retryable failure does not permit silently moving on to publication. Resume the existing named operation under its recovery contract.

The [quickstart](../../getting-started/quickstart.md) gives exact CLI commands and a five-triple fixture. The [HTTP example](../../build/http-application.md) shows request bodies and result handling.

## Publish intentionally

1. Establish authorization for funded publication, the intended network, author, and payer. Reuse authorization already given for this task; ask only if the transition is not authorized.
2. Confirm the selected KA is fully shared and sealed, and that funds/required publishing permissions exist. Check PCA ownership/agent registration before assuming its funding path applies.
3. Use the named KA's supported VM publish route/tool. For async publication, confirm publisher setup and save the job ID.
4. Inspect the returned transaction, chain finality, local reconciliation, and lifecycle. Acceptance, a transaction hash, and completed publication are distinct states.
5. Read back the intended VM content/version. Report the UAL, source, and actual verification evidence. Publication proves neither factual truth nor independent corroboration.

**Recover:** preserve KA/job identity. Follow [publisher recovery](../../use-dkg/async-publisher-wallets.md) for ambiguous chain outcomes; never publish a replacement name merely to bypass a held job. Follow the [edit lifecycle](../../use-dkg/knowledge-asset-lifecycle.md) for an intended update.

**Done:** the requested operation has observable completion, and the answer identifies the actual layer. If only WM was requested, stop there.
