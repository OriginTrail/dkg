---
status: current
version: v10
audience: human+agent
doc_type: architecture
---

# Memory Lifecycle

The assertion lifecycle is the write path agents should prefer.

1. Create an assertion in Working Memory.
2. Write RDF quads into that assertion.
3. Query the assertion to verify what was written.
4. Promote the assertion to Shared Working Memory when peers should see it.
5. Publish SWM to Verified Memory when on-chain finality is required.
6. Read lifecycle history for audit and recovery.

Operational implications:

- Assertion names should be stable, lowercase slugs.
- Writes are additive; discard and recreate if a stable assertion needs replacement.
- Promotion may target all roots or an explicit set of root entities.
- Publishing costs funds and clears/finalizes selected shared memory.
- Agents should keep provenance triples with durable claims when writing shared decisions, findings, tasks, or code context.
