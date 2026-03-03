# Experiment D: Swarm on One Shared Task (MD vs DKG)

## Objective

Compare two collaboration substrates when **multiple agents work on the same single task**, not separate features:

- **D1 (MD Shared Memory):** agents coordinate via shared Markdown file/folder.
- **D2 (DKG Node Collaboration):** agents coordinate via common paranet, publishing/querying structured knowledge.

Primary question: which substrate yields better **speed, cost, and consistency** under high overlap.

## Why this experiment matters

Prior arms split agents across different features. This experiment stresses true swarm behavior: overlapping work, shared dependencies, conflict risk, and interface alignment.

## Task shape

Use one large cross-cutting task (example):

"Add a new multi-channel notification orchestration subsystem that spans:
- gateway API methods
- persistence schema
- UI status panel
- extension-level adapter hooks
- integration tests"

Then split into 4 interdependent substreams (not independent features):
1. API contract + validation
2. Gateway internals + state model
3. UI rendering + interaction
4. Tests + migration/tooling

## Arms

### D1 — Shared MD

- 4 agents in parallel worktrees
- shared directory `collab-md/<run-id>/`
- required files:
  - `plan.md`
  - `decisions.md`
  - `interfaces.md`
  - `handoffs.md`
- each agent must:
  - read all MD files before coding
  - append plan and updates at checkpoints
  - record assumptions and unresolved conflicts

### D2 — Shared DKG

- same 4 agents and task split
- shared paranet `dev-coordination`
- required entity types (suggested):
  - `Decision`
  - `InterfaceContract`
  - `Assumption`
  - `Handoff`
  - `TestEvidence`
- each agent must:
  - query existing run-scoped entities before coding
  - publish plan + key decisions + final handoff
  - link decisions to files/modules changed

## Protocol checkpoints (both arms)

1. **Checkpoint A (Plan):** publish/append scope + intended files.
2. **Checkpoint B (Mid-run):** publish/append interface decisions and blockers.
3. **Checkpoint C (Final):** publish/append final implementation summary + evidence.

Any missing checkpoint = collaboration violation.

## Metrics

### Speed & cost
- wall-clock completion time
- total cost, cost per successful run
- turns and cache-read tokens

### Consistency
- conflict count (incompatible assumptions/interfaces)
- rework count (edits reverting prior agent decisions)
- merge friction (manual conflict resolutions)
- variance in per-substream delivery time (CV)

### Collaboration quality
- reuse rate (how often agents consume peer artifacts)
- duplication rate (same discovery repeated by multiple agents)
- stale decision rate (consumed but superseded info)

## Success criteria

D2 beats D1 on at least 2 of:
- lower conflict/rework
- higher completion reliability
- lower cost per successful run
- lower wall-clock time at equal quality

## Expected outcome

- D1 likely wins on simplicity and low overhead early.
- D2 likely wins as task complexity and interdependency increase because structure/searchability scales better than free-text notes.
