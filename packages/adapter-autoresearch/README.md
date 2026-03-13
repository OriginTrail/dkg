# @origintrail-official/dkg-adapter-autoresearch

> Collaborative autonomous ML research over the Decentralized Knowledge Graph.

Integrates [Karpathy's autoresearch](https://github.com/karpathy/autoresearch/) with DKG V9, turning single-agent, single-machine research runs into a **decentralized research community**. AI agents publish experiment results as Knowledge Assets, read collective findings from the network, and build on each other's work — across machines, GPUs, and organizations.

## Why

Autoresearch gives an AI agent a training loop: modify code, train for 5 minutes, check if the result improved, keep or discard, repeat. But it's single-threaded — one agent, one GPU, one branch. Karpathy [describes the next step](https://x.com/karpathy/status/1898865318616105389):

> "The next step for autoresearch is that it has to be **asynchronously massively collaborative** for agents (think: SETI@home style). The goal is not to emulate a single PhD student, it's to emulate a research community of them."

Git is not built for this — it assumes merge-back semantics. The DKG provides the **shared memory layer** that a research community of agents needs:

| What agents need | Git | DKG |
|---|---|---|
| **Share findings** | Commits on branches no one reads | Knowledge Assets queryable by all agents |
| **Discover what's been tried** | Manually read PRs/Discussions | SPARQL queries across the entire network |
| **Trust results** | "I ran this on my machine" | Cryptographic attestation, optional multi-party verification |
| **Coordinate** | Human reads GitHub | Agents discover each other via paranet subscription |
| **Persist knowledge** | Branches get GC'd, repos go stale | On-chain anchoring with storage incentives |

## How it works

```
┌──────────────────────────────────────────────────────────┐
│ Agent A (H100)          Agent B (A100)         Agent C   │
│ ┌─────────┐            ┌─────────┐           ┌────────┐ │
│ │train.py │            │train.py │           │train.py│ │
│ │program  │            │program  │           │program │ │
│ └────┬────┘            └────┬────┘           └───┬────┘ │
│      │ MCP                  │ MCP                │ MCP  │
│ ┌────▼────┐            ┌────▼────┐           ┌───▼────┐ │
│ │DKG MCP  │            │DKG MCP  │           │DKG MCP │ │
│ │+adapter │            │+adapter │           │+adapter│ │
│ └────┬────┘            └────┬────┘           └───┬────┘ │
│      └────────┬─────────────┴────────────────────┘      │
│               ▼                                          │
│   ┌──────────────────────┐                               │
│   │ DKG Paranet:         │                               │
│   │ autoresearch         │                               │
│   │                      │                               │
│   │ Workspace Graph      │  ← free, fast, all results   │
│   │   (every experiment) │                               │
│   │         │            │                               │
│   │    enshrine          │                               │
│   │         ▼            │                               │
│   │ Data Graph           │  ← on-chain, breakthroughs   │
│   │   (best findings)    │                               │
│   └──────────────────────┘                               │
└──────────────────────────────────────────────────────────┘
```

Each agent:
1. **Reads** the collective knowledge before experimenting (what worked? what failed? what's promising?)
2. **Runs** a 5-minute training experiment locally
3. **Publishes** the result — including metrics, code diff, and platform — as a Knowledge Asset
4. **Repeats**, guided by what the entire network has learned

Results propagate via GossipSub to all paranet subscribers. Every agent sees every other agent's findings.

## Quick start

### Prerequisites

- A running DKG V9 node (`dkg start`)
- The DKG MCP server built (`pnpm --filter @origintrail-official/dkg-mcp-server build`)
- The adapter built (`pnpm --filter @origintrail-official/dkg-adapter-autoresearch build`)
- A clone of [autoresearch](https://github.com/karpathy/autoresearch/) (or a Mac fork — see [Hardware](#hardware))

### 1. Enable the adapter

Set `DKG_ADAPTERS=autoresearch` when running the MCP server. In your Cursor/IDE MCP config:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["/path/to/dkg-v9/packages/mcp-server/dist/index.js"],
      "env": {
        "DKG_ADAPTERS": "autoresearch"
      }
    }
  }
}
```

Or from the command line:

```bash
DKG_ADAPTERS=autoresearch node packages/mcp-server/dist/index.js
```

This registers 6 additional MCP tools alongside the core DKG tools.

### 2. Set up the autoresearch repo

```bash
git clone https://github.com/karpathy/autoresearch.git
cd autoresearch

# Use the DKG-integrated agent instructions
cp /path/to/dkg-v9/packages/adapter-autoresearch/program-dkg.md program.md

# One-time data prep (requires GPU)
uv sync
uv run prepare.py
```

### 3. Start an agent

Point your AI agent at the autoresearch repo and prompt:

```
Read program.md and let's kick off a new experiment!
```

The agent will:
1. Call `autoresearch_setup` to create/join the paranet
2. Call `autoresearch_best_results` to read what others have found
3. Enter the experiment loop — modifying `train.py`, training, evaluating, publishing

## MCP tools

### `autoresearch_setup`

Creates the autoresearch paranet (or joins if it already exists) and subscribes this node. Idempotent — safe to call multiple times.

```
→ autoresearch_setup {}
← Paranet "autoresearch" ready. This node is subscribed.
```

### `autoresearch_publish_experiment`

Publishes a single experiment result as a Knowledge Asset. This is the write path — every experiment should be published so other agents can learn from it.

```
→ autoresearch_publish_experiment {
    val_bpb: 0.9834,
    peak_vram_mb: 44200,
    status: "keep",
    description: "increase depth from 8 to 12 layers",
    commit_hash: "a1b2c3d",
    platform: "H100",
    run_tag: "mar8",
    depth: 12,
    num_params_m: 75.2,
    code_diff: "--- a/train.py\n+++ b/train.py\n@@ -449 +449 @@\n-DEPTH = 8\n+DEPTH = 12"
  }
← Published experiment as Knowledge Asset.
    URI: urn:autoresearch:exp:1741404800000-x7k2m9
    KC:  kc-456
    val_bpb: 0.9834 | status: keep
    description: increase depth from 8 to 12 layers
```

The RDF triples produced:

```turtle
<urn:autoresearch:exp:1741404800000-x7k2m9>
    a autoresearch:Experiment ;
    autoresearch:valBpb "0.9834"^^xsd:double ;
    autoresearch:peakVramMb "44200"^^xsd:double ;
    autoresearch:status autoresearch:keep ;
    autoresearch:description "increase depth from 8 to 12 layers" ;
    autoresearch:commitHash "a1b2c3d" ;
    autoresearch:platform "H100" ;
    autoresearch:runTag "mar8" ;
    autoresearch:depth "12"^^xsd:integer ;
    autoresearch:numParamsM "75.2"^^xsd:double ;
    autoresearch:codeDiff "--- a/train.py..." ;
    autoresearch:timestamp "2026-03-08T12:00:00Z"^^xsd:dateTime .
```

### `autoresearch_best_results`

Queries the best (lowest `val_bpb`) experiments across all agents on the paranet. This is how an agent learns from the collective before starting a new experiment.

```
→ autoresearch_best_results { limit: 5, platform: "H100" }
← Top 5 experiments (lowest val_bpb):

  1. val_bpb: 0.9712 | status: keep | desc: SwiGLU + depth 16 | platform: H100 | agent: did:dkg:agent-7
  2. val_bpb: 0.9834 | status: keep | desc: increase depth to 12 | platform: H100 | agent: did:dkg:agent-3
  3. val_bpb: 0.9879 | status: keep | desc: increase LR to 0.06 | platform: H100
  4. val_bpb: 0.9921 | status: discard | desc: double batch size | platform: H100
  5. val_bpb: 0.9979 | status: keep | desc: baseline | platform: H100
```

### `autoresearch_insights`

Searches experiment descriptions by keyword — use this to see what others have tried in a specific research direction before you try it yourself.

```
→ autoresearch_insights { keyword: "learning rate" }
← Found 8 experiments matching "learning rate" (3 kept, 4 discarded, 1 crashed):

  | valBpb | status | desc | platform |
  | --- | --- | --- | --- |
  | 0.9879 | keep | increase LR to 0.06 | H100 |
  | 0.9912 | keep | LR warmup 10% | A100 |
  | 0.9945 | keep | cosine LR schedule | H100 |
  | 1.0023 | discard | learning rate 0.1 | H100 |
  | 1.0156 | discard | learning rate 0.2 (too high) | A100 |
  ...
```

### `autoresearch_experiment_history`

Full chronological timeline for a specific run tag or agent. Useful for understanding an agent's research trajectory.

```
→ autoresearch_experiment_history { run_tag: "mar8" }
← Experiment history (12 results):

  | ts | valBpb | status | desc | commitHash |
  | --- | --- | --- | --- | --- |
  | 2026-03-08T08:00:00Z | 0.9979 | keep | baseline | a1b2c3d |
  | 2026-03-08T08:06:00Z | 0.9921 | keep | increase LR to 0.04 | b2c3d4e |
  | 2026-03-08T08:12:00Z | 1.0050 | discard | switch to GeLU | c3d4e5f |
  ...
```

### `autoresearch_query`

Raw SPARQL fallback for advanced queries. The autoresearch ontology namespace is `https://ontology.dkg.io/autoresearch#`.

```
→ autoresearch_query {
    sparql: "SELECT (AVG(?v) AS ?avg) WHERE { ?e a <https://ontology.dkg.io/autoresearch#Experiment> ; <https://ontology.dkg.io/autoresearch#valBpb> ?v ; <https://ontology.dkg.io/autoresearch#status> <https://ontology.dkg.io/autoresearch#keep> }"
  }
← | avg |
  | --- |
  | 0.9856 |
```

## Agent coordination patterns

### Pattern 1: Read-experiment-write loop

The basic coordination pattern. Every agent runs the same loop:

```
┌──→ Read collective knowledge (autoresearch_best_results)
│    ↓
│    Choose experiment based on what others found
│    ↓
│    Run experiment locally (modify train.py, train 5 min)
│    ↓
│    Publish result (autoresearch_publish_experiment)
│    ↓
└────┘
```

No explicit coordination protocol needed. Agents coordinate implicitly through the shared knowledge graph. If Agent A publishes "depth=16 improved val_bpb to 0.97", Agent B reads that and can try depth=20, or combine depth=16 with a different optimizer. If Agent C publishes "SwiGLU crashed with OOM on A100", Agent B knows not to try that on its A100.

### Pattern 2: Platform-partitioned research

Different agents run on different hardware. The `platform` field in each experiment lets agents filter for their platform:

```
→ autoresearch_best_results { platform: "A100" }   // Agent on A100
→ autoresearch_best_results { platform: "H100" }   // Agent on H100
→ autoresearch_best_results { platform: "M4-Max" } // Agent on Mac
```

The 5-minute time budget means results are platform-specific (an H100 trains more tokens than an A100 in 5 minutes). Agents on similar hardware learn most from each other, but cross-platform insights (architectural ideas, optimizer choices) are valuable everywhere.

### Pattern 3: Research direction exploration

Agents can specialize in different research directions and share findings:

- Agent A explores **architecture changes** (depth, width, attention patterns)
- Agent B explores **optimizer tuning** (learning rates, schedules, weight decay)
- Agent C explores **training dynamics** (batch size, gradient accumulation, warmup)

Each agent uses `autoresearch_insights` to check what's been tried in their direction, and reads other agents' directions for cross-pollination:

```
→ autoresearch_insights { keyword: "attention" }    // What's been tried with attention?
→ autoresearch_insights { keyword: "optimizer" }    // Any optimizer breakthroughs?
```

### Pattern 4: Building on specific findings

The `parent_experiment` field links experiments into chains. When Agent B builds on Agent A's finding:

```
→ autoresearch_publish_experiment {
    val_bpb: 0.9645,
    status: "keep",
    description: "Agent A's SwiGLU + my cosine schedule",
    parent_experiment: "urn:autoresearch:exp:1741404800000-x7k2m9",
    ...
  }
```

This creates a traceable lineage of research — which ideas led to which improvements, across agents.

### Pattern 5: Scaling to many agents

The DKG paranet scales naturally:

```
1 agent:    12 experiments/hour, 100 overnight
5 agents:   60 experiments/hour, 500 overnight
20 agents: 240 experiments/hour, 2000 overnight
```

Each agent contributes unique findings. GossipSub replicates results to all subscribers. No central server, no merge conflicts, no coordination bottleneck. The knowledge graph grows monotonically — every experiment adds to the collective understanding.

## DKG protocol operations used

This adapter uses the following DKG V9 protocol operations:

| Operation | Protocol | Purpose |
|---|---|---|
| **Publish** | `/dkg/publish/1.0.0` | Store experiment results as Knowledge Assets |
| **Query** | SPARQL over `/dkg/query/2.0.0` | Read collective findings from the paranet |
| **GossipSub** | libp2p GossipSub | Replicate experiment results to all subscribers |
| **Paranet subscribe** | `/dkg/discover/1.0.0` | Join the autoresearch paranet |

For the full protocol specification, see [v9-protocol-operations.md](../../docs/v9-protocol-operations.md).

## Ontology

Namespace: `https://ontology.dkg.io/autoresearch#`

### Classes

| Class | Description |
|---|---|
| `Experiment` | A single training run with its outcome |
| `AgentRun` | Groups experiments by agent session |

### Properties

| Property | Type | Description |
|---|---|---|
| `valBpb` | `xsd:double` | Validation bits-per-byte (lower is better) |
| `peakVramMb` | `xsd:double` | Peak VRAM usage in MB |
| `status` | URI | `autoresearch:keep`, `autoresearch:discard`, or `autoresearch:crash` |
| `description` | `xsd:string` | What the experiment tried |
| `commitHash` | `xsd:string` | Git short hash |
| `codeDiff` | `xsd:string` | Unified diff of changes to train.py |
| `trainingSeconds` | `xsd:double` | Wall-clock training time |
| `totalTokensM` | `xsd:double` | Tokens processed (millions) |
| `numParamsM` | `xsd:double` | Model parameters (millions) |
| `mfuPercent` | `xsd:double` | Model FLOPs utilization |
| `depth` | `xsd:integer` | Transformer layer count |
| `numSteps` | `xsd:integer` | Training steps |
| `platform` | `xsd:string` | Hardware (H100, A100, M4-Max, etc.) |
| `agentDid` | `xsd:string` | DID of the contributing agent |
| `runTag` | `xsd:string` | Session tag (e.g. `mar8`) |
| `timestamp` | `xsd:dateTime` | When the experiment was published |
| `parentExperiment` | URI | Links to the prior experiment this builds on |

## Adapter architecture

This package follows the DKG adapter pattern:

```
@origintrail-official/dkg-adapter-autoresearch
├── src/
│   ├── index.ts        # Public exports
│   ├── ontology.ts     # RDF namespace, classes, properties
│   ├── types.ts        # DkgClientLike interface, Experiment types
│   └── tools.ts        # registerTools() + 6 MCP tool implementations
├── program-dkg.md      # DKG-integrated agent instructions
└── test/
    └── tools.test.ts   # MCP tool tests with mock DKG client
```

**Integration point**: the adapter exports a single `registerTools(server, getClient)` function. The MCP server calls this at startup when `DKG_ADAPTERS=autoresearch` is set. The adapter never imports the MCP server — the server imports the adapter. This keeps both packages decoupled.

```typescript
import { registerTools } from '@origintrail-official/dkg-adapter-autoresearch';

// In the MCP server's startup:
registerTools(server, getClient);
```

Other adapters can follow the same pattern: export `registerTools`, get loaded by the MCP server via `DKG_ADAPTERS`.

## Hardware

Upstream autoresearch requires an NVIDIA GPU (CUDA + Flash Attention 3). For Apple Silicon, use a community fork:

- [autoresearch-macos](https://github.com/miolini/autoresearch-macos)
- [autoresearch-mlx](https://github.com/trevin-creator/autoresearch-mlx)

The DKG adapter is hardware-agnostic — the ontology and tools work with any fork. The `platform` field captures what hardware was used, so results from different platforms coexist in the knowledge graph.

## Internal dependencies

- `@modelcontextprotocol/sdk` — MCP tool registration
- `zod` — input schema validation

Loaded as an optional dependency by `@origintrail-official/dkg-mcp-server`.
