---
name: ccl
description: Use the Corroboration & Consensus Language to evaluate deterministic agreement policies over DKG facts and snapshots.
---

# CCL Skill

Use **CCL (Corroboration & Consensus Language)** when agents need a deterministic, replayable way to decide whether published facts satisfy an agreement policy.

CCL is not for ordinary chat. It is for questions like:

1. does a claim have enough independent support?
2. is a claim blocked by an accepted contradiction?
3. has a quorum been reached for promotion?
4. is an owner-scoped assertion signed by the correct authority?

## When To Use CCL

- Use CCL after facts are available in the DKG or in a prepared case file.
- Use it when multiple agents or nodes must reach the same result from the same inputs.
- Use it for narrow policy checks, not open-ended reasoning.

## When Not To Use CCL

- Do not use CCL for free-form conversation or negotiation.
- Do not use CCL as a replacement for SPARQL queries.
- Do not use CCL for fuzzy judgments, semantic similarity, or LLM-driven reasoning.

## Mental Model

- `dkg_send_message` / `dkg_invoke_skill` = agent communication
- `dkg_publish` = shared facts enter the DKG
- `dkg_query` = inspect the published facts
- CCL = evaluate whether those facts satisfy a deterministic policy
- later `PUBLISH` = make the resulting proposal authoritative

## Recommended Workflow

1. Gather or publish the relevant facts.
2. Make sure the evaluation scope is clear: paranet, view, snapshot, and policy version.
3. Query the DKG to verify the input facts.
4. Run the CCL evaluator on the policy and fact set.
5. Treat the result as advisory until it is introduced through the normal DKG publish flow.

## Evaluator Commands

Run a single case:

```bash
node ccl_v0_1/evaluator/reference_evaluator.js \
  ccl_v0_1/policies/context_corroboration.yaml \
  ccl_v0_1/tests/cases/08_context_quorum_accept.yaml \
  --check
```

Run all bundled cases:

```bash
cd ccl_v0_1 && npm test
```

## Usage Examples

### Example 1: Propose And Approve A Policy For A Paranet

Publish a policy proposal:

```bash
dkg ccl policy publish ops-paranet \
  --name incident-review \
  --version 0.1.0 \
  --file ccl_v0_1/policies/context_corroboration.yaml
```

Approve it as the paranet owner:

```bash
dkg ccl policy approve ops-paranet did:dkg:policy:...
```

Resolve the active approved policy:

```bash
dkg ccl policy resolve ops-paranet --name incident-review --include-body
```

### Example 2: Evaluate A Case Against The Approved Policy

Run evaluation without publishing the result:

```bash
dkg ccl eval ops-paranet \
  --name incident-review \
  --case ccl_v0_1/tests/cases/08_context_quorum_accept.yaml
```

Use a stricter per-context override if one exists:

```bash
dkg ccl eval ops-paranet \
  --name incident-review \
  --context-type incident_review \
  --case ccl_v0_1/tests/cases/08_context_quorum_accept.yaml
```

### Example 3: Publish The Evaluation Result Back Into The Paranet

When the evaluation should become a published adjudication record:

```bash
dkg ccl eval ops-paranet \
  --name incident-review \
  --context-type incident_review \
  --case ccl_v0_1/tests/cases/08_context_quorum_accept.yaml \
  --publish-result
```

This publishes:

- a `CCLEvaluation` node with the policy, fact-set hash, snapshot metadata, and scope
- linked `CCLResultEntry` nodes for derived predicates and decisions
- linked `CCLResultArg` nodes so each tuple element is queryable in RDF

### Example 4: Query Published Results

List all published CCL evaluation records for a paranet:

```bash
dkg ccl results ops-paranet
```

Filter to only acceptance decisions for a given snapshot:

```bash
dkg ccl results ops-paranet \
  --snapshot-id snap-42 \
  --result-kind decision \
  --result-name propose_accept
```

### Example 5: Agent Workflow Pattern

Use this sequence when multiple agents need to agree on a claim:

1. agents exchange messages or skill calls to request evidence
2. agents publish claim, support, contradiction, ownership, or quorum facts into the DKG
3. the paranet resolves the active approved CCL policy
4. the evaluator runs on a fixed snapshot and returns deterministic outputs
5. the result is optionally published and then used by the normal DKG workflow

In short:

- messages coordinate
- DKG stores facts
- CCL evaluates policy
- publish/finalization makes the outcome authoritative

## Output Model

CCL returns:

- `derived` predicates such as `corroborated(c1)` or `promotable(c1)`
- `decisions` such as `propose_accept(c1)` or `propose_reject(c1)`

These outputs do not change authoritative DKG state by themselves.

## Guidance

- Keep policies small and deterministic.
- Version policies explicitly.
- Evaluate only against a declared snapshot or case input.
- Prefer publishing the supporting facts first, then evaluating.
- Prefer descriptive surface-CCL variable names such as `Claim`, `Evidence`, `Agent`, and `Epoch` when authoring policies.
- If agents disagree, check the facts, the snapshot boundary, and the policy version before anything else.
