# CCL Implementation Tasks

This document turns the current CCL review gaps into concrete implementation tasks. It is intended as a practical follow-up queue for moving CCL from a good v0.1 foundation toward production-safe behavior.

## Priority Order

1. Snapshot-backed fact resolution
2. Explicit policy lifecycle controls
3. Peer-verifiable approvals
4. Evaluator resource limits
5. Deterministic binding identifiers

The remaining items are already partly addressed on this branch:

- policy content validation before publish/approve
- duplicate republish protection for the same `paranetId + name + version`
- reference-evaluator vs agent-evaluator parity tests
- surface syntax compiler support

## Task 1: Snapshot-Backed Fact Resolution

### Problem

CCL evaluation is currently deterministic only for the policy body plus the caller-supplied fact tuples. The API records `snapshotId`, `view`, and `scopeUal`, but does not yet resolve or verify facts against DKG state.

### Goal

Make `same policy + same snapshot + same resolver version` produce the same fact set on every node.

### Proposed solution

- Add `resolveFactsFromSnapshot({ paranetId, snapshotId, view, scopeUal?, policyName?, contextType? })`
- Implement a canonical extraction layer that:
  - queries the relevant paranet graph
  - applies a resolver profile for the policy family or context type
  - emits canonical `CclFactTuple[]`
  - sorts tuples deterministically before hashing
- Extend evaluation so callers can either:
  - pass `facts` directly for manual/dev mode, or
  - omit `facts` and let the agent resolve them from the DKG
- Record extra provenance on evaluations:
  - `factResolverVersion`
  - `factQueryHash`
  - `factResolutionMode` (`manual` or `snapshot-resolved`)

### Deliverables

- agent API for snapshot-backed fact resolution
- one concrete resolver for existing bundled policy families
- tests proving two nodes resolve the same facts for the same snapshot
- docs clarifying manual vs snapshot-resolved evaluation modes

### Notes

Avoid pretending arbitrary RDF can be evaluated directly. Resolver profiles should define how RDF is projected into canonical CCL facts.

## Task 2: Policy Revocation and Deactivation

### Problem

Policies can be published and approved, but not explicitly revoked, deactivated, or superseded.

### Goal

Allow paranet owners to retire policies cleanly and make resolution semantics explicit.

### Proposed solution

- Add a revoke flow:
  - `revokeCclPolicy({ paranetId, policyUri, contextType? })`
  - CLI/API endpoint: `dkg ccl policy revoke`
- Extend lifecycle state with explicit binding or policy statuses:
  - `proposed`
  - `approved`
  - `revoked`
  - optionally `superseded`
- Update resolution rules to choose:
  - latest non-revoked binding for exact context
  - otherwise latest non-revoked default binding
- Preserve old bindings for auditability, but mark them inactive in a machine-readable way

### Deliverables

- revoke API and CLI command
- updated resolver semantics
- tests covering default bindings, context bindings, and revoked bindings
- docs describing how supersession works

## Task 3: Peer-Verifiable Approval Ingestion

### Problem

Approval is validated by the approving node before publish, but peers currently trust the approval quads they receive.

### Goal

Prevent a modified node from gossiping fake approvals that other nodes accept without verification.

### Proposed solution

- Short term:
  - validate approval bindings on ingest against locally known paranet owner state
  - reject bindings where `approvedBy` is not the current owner for the paranet
- Long term:
  - introduce signed approval envelopes
  - sign the approval payload with the paranet owner key
  - verify signatures before accepting approval triples into the ontology store

### Deliverables

- gossip-ingest validation for approval bindings
- failure logs and rejection reasons for invalid approvals
- design doc or envelope schema for signed approvals
- tests showing forged approvals are rejected by peer nodes

### Notes

Signed approvals are the better long-term model because they avoid relying on local trust in the sender.

## Task 4: Evaluator Resource Limits

### Problem

The evaluator caps fixpoint rounds, but not fact volume, join explosion, runtime, or memory growth.

### Goal

Bound evaluation cost so policies cannot accidentally or intentionally exhaust node resources.

### Proposed solution

- Extend evaluator config with hard limits such as:
  - `maxFacts`
  - `maxBindings`
  - `maxDerivedTuples`
  - `maxConditionMatches`
  - `maxRounds`
  - `deadlineMs`
- Make limit failures explicit and deterministic, for example:
  - `CCL evaluation exceeded maxBindings`
- Thread these limits through the agent API and, later, optionally the policy envelope

### Deliverables

- configurable evaluator limits in `packages/agent/src/ccl-evaluator.ts`
- unit tests for limit-triggered failures
- docs describing safe defaults and operator tuning

### Notes

For network determinism, nodes that are expected to agree should run with compatible limit settings.

## Task 5: Deterministic Binding Identifiers

### Problem

Policy binding URIs currently use `Date.now()`, so the same logical approval can produce different identifiers on different nodes.

### Goal

Make identifiers reproducible and reduce time-based ambiguity.

### Proposed solution

- Replace time-derived binding URIs with a hash-derived scheme based on stable fields such as:
  - `paranetId`
  - `policyUri`
  - `contextType`
  - `approvedBy`
  - `approvedAt`
- Alternatively, make bindings deterministic per scope and express changes through status updates instead of minting a fresh URI per approval

### Deliverables

- updated `policyBindingUriFor(...)`
- migration strategy for existing bindings
- tests proving stable URI generation

## Task 6: Stronger Policy Validation and Linting

### Problem

Basic validation now exists, but there is room for stronger structural and semantic checks.

### Goal

Catch bad policies earlier and make authoring errors cheaper to diagnose.

### Proposed solution

- Add a dedicated validator/linter entry point:
  - `validateCclPolicy(content)` for strict validation
  - optional linter warnings for quality issues
- Add checks for:
  - duplicate rule names
  - duplicate decision names
  - malformed params
  - unknown top-level keys
  - empty or unreachable clauses where detectable
- Add CLI support:
  - `dkg ccl validate policy.yaml`

### Deliverables

- validator module expansion
- CLI/API validation endpoint
- author-facing error messages with precise failure reasons

## Task 7: Keep Cross-Evaluator Parity in CI

### Problem

The reference evaluator and the agent evaluator implement the same semantics independently and can drift over time.

### Goal

Ensure both evaluators produce identical outputs for the shared corpus.

### Proposed solution

- Keep the bundled parity test in `packages/agent/test/agent.test.ts`
- Optionally extract it into a dedicated `ccl-parity.test.ts`
- Run parity coverage in CI on every CCL change
- Later add randomized small-case fuzz coverage once the policy grammar stabilizes more

### Deliverables

- stable CI parity test
- future fuzz-testing backlog item

## Task 8: Clarify Supported Inputs in CLI and Docs

### Problem

The repository now includes a surface compiler, but user-facing flows still need to be explicit about which input formats are accepted and when compilation occurs.

### Goal

Prevent confusion about whether users should submit `.ccl` or canonical YAML.

### Proposed solution

- document current accepted input formats in CLI help and README
- if CLI support is added, either:
  - compile `.ccl` to canonical YAML on input, or
  - reject `.ccl` with a helpful error until compilation is wired into the CLI path

### Deliverables

- updated CLI help text
- updated README examples
- optional `.ccl` input support in publish commands

## Task 9: Production Mode Switch for Evaluation

### Problem

Manual fact mode is useful for tests and demos, but risky if used accidentally in production contexts.

### Goal

Make the safe path explicit.

### Proposed solution

- add evaluation modes:
  - `manual`
  - `snapshot-resolved`
- add a config flag or API option that can disable manual facts for production nodes
- mark published evaluations with the chosen mode

### Deliverables

- evaluation mode field in results
- node/operator option to disallow manual fact evaluation
- tests for both allowed and denied modes

## Suggested Execution Sequence

If these tasks are implemented incrementally, the recommended order is:

1. snapshot-backed fact resolution
2. policy revocation/deactivation
3. peer-verifiable approvals
4. evaluator resource limits
5. deterministic binding identifiers
6. stronger validator/linter UX
7. CI parity hardening
8. CLI/docs input clarity
9. production-mode safety switch
