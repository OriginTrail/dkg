# Experiment E: Trust-First Collaboration (Why DKG Matters)

## Objective

Evaluate collaboration substrate not by speed/cost first, but by **trust properties**:

- provenance
- verifiability
- non-repudiation of decisions
- auditability of who knew what, when

Compare:
- **E1 (MD Trust Baseline):** shared markdown artifacts
- **E2 (DKG Trust):** signed, timestamped run-scoped entities in shared paranet

## Core hypothesis

When multiple agents collaborate under uncertainty, DKG provides superior trust guarantees:
- immutable/auditable decision trail
- explicit provenance links
- machine-queryable evidence graph
- easier post-hoc blame/impact analysis

## Scenario

Run a task with intentionally ambiguous requirements and hidden edge cases.
Inject mid-run requirement changes and one conflicting instruction to create trust stress.

Example:
- introduce a policy change halfway through
- have two agents receive contradictory assumptions
- require final reconciliation and audit report

## Arms

### E1 — MD trust baseline

- Agents log decisions in `trust-md/<run-id>/` files.
- Free-form text, timestamps from file system.
- Manual linking between evidence and decisions.

### E2 — DKG trust mode

- Agents publish signed decision/evidence entities to paranet.
- Required relationships:
  - decision -> author agent
  - decision -> timestamp
  - decision -> evidence artifact
  - decision -> supersedes/contradicts
  - decision -> affected files/modules
- Agents query trust graph before accepting assumptions.

## Trust metrics

1. **Provenance completeness**
   - % of final decisions with attributable author + timestamp + evidence link
2. **Conflict traceability**
   - time to identify root cause of contradiction
3. **Audit reconstruction quality**
   - can an external reviewer reconstruct decision timeline correctly?
4. **Tamper resistance proxy**
   - ability to detect missing/edited records
5. **Policy compliance proofability**
   - % of policy-relevant decisions with machine-verifiable chain

## Speed/cost metrics (secondary)
- wall time
- total cost
- completion

## Success criteria

E2 should significantly outperform E1 in trust metrics:
- +25% provenance completeness
- -30% conflict root-cause time
- +30% audit reconstruction score

## Expected impact

Even if E2 is neutral/slightly worse on raw cost, it can be preferable for:
- regulated development workflows
- multi-team accountability
- safety-critical or financial systems

## Optional extension

Add cryptographic signing per agent identity for published entities,
then test whether trust metrics improve further vs unsigned DKG publishing.
