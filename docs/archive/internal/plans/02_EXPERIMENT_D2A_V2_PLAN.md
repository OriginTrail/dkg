# D2A-v2 Plan (Design Only, No Implementation Yet)

## Objective

Define a tighter rerun of D2A that preserves the DKG collaboration hypothesis while reducing avoidable token/cost overhead and improving reliability under quota constraints.

This document is a planning artifact only. No script or benchmark behavior changes are applied by this plan.

## What D2A-v2 should test

Primary question:
- Can DKG-backed swarm collaboration beat shared-Markdown collaboration on cost-per-success when collaboration payloads and turn budgets are constrained?

Secondary questions:
- Does scoped retrieval reduce duplicate context loading?
- Does strict ownership reduce cross-agent thrash?
- Does lightweight coordination preserve completion quality?

## Scope

In scope:
- New experiment arm definition: `D2A-v2`
- Prompt/protocol simplification for collaboration
- Budget/turn constraints
- Reliability handling and rerun policy
- Metrics and analysis updates

Out of scope:
- Any implementation in scripts or analyzers right now
- Changes to feature prompts themselves
- Changes to D1A historical data

## Proposed D2A-v2 Protocol

### 1) Compact collaboration entities

Each agent publishes only 3 required entities per feature:
- `plan` (one short summary + intended files)
- `decision` (single most important design choice)
- `handoff` (status + changed files + remaining risk)

Constraints:
- Hard cap summary length (e.g., <= 280 chars per summary field)
- No long excerpts from code
- Prefer identifiers over prose (file path list, symbol names)

### 2) Delta query strategy

Instead of broad run-wide scans each turn:
- Query once at start for feature-scoped entities
- Query once mid-run for updates since last checkpoint
- Query once before final handoff

This should bound retrieval turns and reduce repeated graph reads.

### 3) Deterministic ownership

Assign strict ownership by feature:
- one agent = one feature
- no other agent edits that feature branch/worktree
- cross-feature coordination only through DKG artifacts

Goal: reduce duplicated exploration and conflicting edits.

### 4) Turn and budget limits

Per-feature limits (initial proposal):
- `--max-turns`: 40 (down from 50)
- optional per-feature budget cap (small fixed USD amount)
- stop early when all mandatory artifacts are complete

### 5) Reliability guardrails

Classify failures explicitly:
- `reasoning_failure`: invalid implementation decisions
- `infra_failure`: API timeouts/500
- `quota_failure`: account/model limit reached

Rerun policy:
- retry only infra/quota failures once
- keep reasoning failures as-is for fair scoring

## Experimental Procedure

1. Run D1A baseline protocol unchanged (reference only, no rerun unless needed).
2. Run D2A-v2 with compact protocol and constraints.
3. Record run IDs and per-feature outcomes.
4. Compute aggregate + per-feature deltas vs D1A and Control.
5. Publish interpretation focused on cost-per-success and reliability.

## Metrics (must report)

Core:
- completion (success/8)
- total cost
- cost per successful feature
- wall-clock time
- total turns
- cache-read tokens

Collaboration quality:
- required artifact completion rate (plan/decision/handoff)
- query efficiency (queries per successful feature)
- duplicate-discovery proxy (repeated similar decisions)

Reliability:
- failure counts by class (reasoning/infra/quota)

## Success Criteria for D2A-v2

D2A-v2 is considered a win if all are true:
- completion >= D1A - 1 feature
- cost per successful feature <= D1A by at least 10%
- turns <= D1A by at least 20%
- no more than 1 quota/infra failure in the full run

## Risks and Mitigations

- Over-compression may reduce solution quality.
  - Mitigation: keep one mandatory `decision` artifact with rationale.

- Tight turn caps may increase FAIL rate on hard features.
  - Mitigation: allow one conditional +5 turn extension only if plan and mid-run checkpoints are complete.

- External quota limits can still confound results.
  - Mitigation: mark run as quota-confounded and rerun affected features only.

## Deliverables for later implementation

- `scripts/run-exp-d2a-v2.sh`
- optional `scripts/analyze-exp-d2a-v2.py` or extension of existing analyzer
- `RESULTS.md` section for D2A-v2 with per-feature deltas and failure-class table

## Execution Readiness Checklist

- [ ] DKG daemon running and healthy
- [ ] MCP server available in Claude session
- [ ] ContextGraph selected and writable
- [ ] Feature ownership map fixed before start
- [ ] Failure classification fields defined in analyzer output

