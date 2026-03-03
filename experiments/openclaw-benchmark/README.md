# OpenClaw DKG Collaboration Benchmark

Evaluates whether agent collaboration over a shared knowledge substrate
(workspace memory or DKG paranet) improves delivery speed, cost efficiency,
and consistency compared to isolated agent workflows.

## Structure

```
experiments/openclaw-benchmark/
├── README.md           ← This file
├── RESULTS.md          ← Main findings, deltas, conclusions
├── tasks/              ← Task sets + next experiment definitions
├── scripts/            ← Automation scripts for each experiment arm
├── results/            ← Raw session JSON outputs
└── analysis/           ← Generated summaries
```

## Experiment Design (Completed)

### Baseline and DKG Arms

| Arm | Agents | Collaboration Substrate | Description |
|-----|--------|-------------------------|-------------|
| Control | 1 | none | Baseline: standard file exploration |
| Exp-A | 1 | DKG (SPARQL) | Single agent using `dkg_query` |
| Exp-A2 | 1 | DKG (semantic wrappers) | High-level tools + SPARQL fallback |
| Exp-B2 | 4 parallel | DKG (semantic wrappers) | Multi-agent with worktrees |
| Exp-AB | 4 parallel | DKG (SPARQL) | Multi-agent with SPARQL-only MCP |
| Exp-C1 | 4 parallel | Workspace shared log + DKG query | Multi-agent shared JSONL memory |
| Exp-C2 | 4 parallel | Full DKG publish/query | Multi-agent run-scoped publishing in common paranet |

### Task Rounds

- **Round 1:** Features 1-4 (cold start)
- **Round 2:** Features 5-8 (warm start)

In collaboration arms, Round 2 tests how much prior shared memory is reused.

### Target Project

[OpenClaw](https://github.com/openclaw/openclaw) — large TypeScript monorepo,
~4,885 files, ~6.8M tokens.

## Running Experiments

### Prerequisites

1. Clone OpenClaw: `git clone https://github.com/openclaw/openclaw ../openclaw`
2. DKG daemon running: `dkg start`
3. Dev coordination paranet exists: `dkg paranet create dev-coordination --name "Dev Coordination" --save`
4. Claude Code installed and authenticated

### Core runs

```bash
# 1. Index OpenClaw into DKG
dkg index ../openclaw --paranet dev-coordination

# 2. Baseline
./scripts/run-control.sh

# 3. Sequential DKG variants
./scripts/run-exp-a.sh
./scripts/run-exp-a2.sh

# 4. Parallel DKG variants
./scripts/run-exp-b2.sh
./scripts/run-exp-ab.sh

# 5. Collaborative variants
./scripts/run-exp-c1.sh
./scripts/run-exp-c2.sh

# 6. Analyze
./scripts/analyze.sh
python ./scripts/analyze-exp-c.py --c1-run-id <run-id> --c2-run-id <run-id>
```

## Metrics

For each arm (and each feature where available):

- **Total cost (USD)** and **cost per successful feature**
- **Wall-clock time** and **throughput (features/min)**
- **Turns** and **cache-read tokens**
- **Completion reliability** (success/8)
- **Consistency** (cost/turn variance across features)
- **Collaboration signal** (workspace entries or DKG published entities)

## Key Output Files

- `RESULTS.md` — full experiment narrative and per-feature deltas
- `tasks/experiment-d-swarm-shared-task.md` — next experiment: shared-task swarm (MD vs DKG)
- `tasks/experiment-e-trust-first.md` — next experiment: trust-focused DKG validation
