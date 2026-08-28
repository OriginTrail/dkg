# `@origintrail-official/dkg-local-llm`

Bounded local-model orchestration for the DKG MCP surface. The package talks to
an OpenAI-compatible `llama.cpp` endpoint and receives its tools dynamically
from MCP `tools/list`.

The runtime is read-only by default. It tokenizes each prompt and dynamically
ranks the discovered MCP tools by their names, descriptions, and input schemas
instead of maintaining a use-case allowlist. The default shortlist is bounded
to eight schemas and 18,000 serialized JSON bytes. Mutations require
`allowWrite: true` and an explicit action/target request.

It also provides:

- llama.cpp-safe JSON Schema normalization (`\\d` becomes `[0-9]` losslessly);
- local argument validation and one repair retry;
- repeated-call and tool-call-count guards;
- bounded chat history whose old evidence is never treated as fresh;
- plain-text interaction traces with secret redaction and `0600` permissions;
- system context v4.2, without benchmark fixtures or domain-specific IDs.

Partner integrations can supply a validated JSON domain profile containing
literal routing keywords, read/write adapter tool hints, and a domain context
addendum. Profiles boost dynamically discovered tools; they do not patch the
core router or weaken the runtime's read-only default.

The package is a library. The umbrella `dkg llm` CLI owns MCP stdio lifecycle,
configuration, and operator-facing write opt-in.

For agent and operator copy/paste setup, model recommendations, and the required
Query-Catalog-first workflow for small models, see
[`Run a Local LLM with DKG`](../../docs/use-dkg/local-llm.md).

## Interactive chat from a source checkout

Start the DKG daemon first. Then use two terminals for the model server and the
interactive DKG client.

### Terminal 1: start Qwen with llama.cpp

```bash
/Users/lupus/projects/llama.cpp/build/bin/llama-server \
  -hf Qwen/Qwen3-8B-GGUF:Q4_K_M \
  -ngl 999 \
  -c 8192 \
  --flash-attn on \
  --jinja \
  --temp 0.15 \
  --top-p 0.9 \
  --repeat-penalty 1.05 \
  --host 127.0.0.1 \
  --port 8080
```

Leave that terminal running. Wait for the model to load, then verify it from
another terminal:

```bash
curl -sS http://127.0.0.1:8080/health
```

Continue only when the response is `{"status":"ok"}`.

### Terminal 2: start interactive DKG chat

From the DKG repository root, start an interactive Qwen session against the
`testing` Context Graph with:

```bash
DKG_HOME=/Users/lupus/dkg-local \
pnpm dkg llm \
  --interactive \
  --project testing \
  --model qwen3-8b-q4-k-m \
  --allow-write
```

`pnpm dkg` runs the source checkout's built CLI from
`packages/cli/dist/cli.js`. Build the workspace first if that file is absent or
stale.

`--allow-write` exposes relevant mutation tools, but a mutation still requires
an explicit user request. Omit `--allow-write` for the recommended read-only
chat:

```bash
DKG_HOME=/Users/lupus/dkg-local \
pnpm dkg llm \
  --interactive \
  --project testing \
  --model qwen3-8b-q4-k-m
```

## Real DKG benchmark

The bundled benchmark uses this production runtime, a real `dkg mcp serve`
child, a real DKG daemon/store, and a real OpenAI-compatible local model. It
creates persistent local data, so `--allow-write` is mandatory and each run
should use unique graph/asset names.

```bash
# Terminal 1: start DKG from this checkout
DKG_HOME=/Users/lupus/dkg-local \
  node packages/cli/dist/cli.js daemon-foreground-worker

# Terminal 2: start llama.cpp with one model
/Users/lupus/projects/llama.cpp/build/bin/llama-server \
  -hf Qwen/Qwen3-8B-GGUF:Q4_K_M -ngl 999 -c 8192 \
  --flash-attn on --jinja --temp 0.15 --top-p 0.9 --repeat-penalty 1.05

# Terminal 3: run 8 core scenarios plus 5 holdouts
RUN_ID="$(date +%Y%m%d-%H%M%S)"
DKG_HOME=/Users/lupus/dkg-local \
DKG_CLI_PATH="$PWD/packages/cli/dist/cli.js" \
pnpm --filter @origintrail-official/dkg-local-llm benchmark:dkg -- \
  --allow-write \
  --graph-id "dkg-llm-qwen8-$RUN_ID" \
  --asset-name "model-families-qwen8-$RUN_ID" \
  --model qwen3-8b-q4-k-m \
  --label "qwen3-8b-q4-k-m-$RUN_ID"
```

The suite covers Context Graph creation, two subgraphs, model-authored RDF,
asset retrieval, raw SPARQL, parameterized query-catalog save/list/run, and five
generalization holdouts. Prerequisite fixture repairs are tagged `source:
"fixture"` and excluded from model scores, so an early write failure cannot
turn every later read into a cascade failure. The output directory contains:

- `interaction.log` — complete readable, redacted request/tool/result trace;
- `results.json` — phase scores plus every guarded MCP call;
- `report.md` — compact comparison table and independent DKG verification.

The guard permits only local benchmark mutations (graph/subgraph creation,
Working Memory asset write/finalize, and catalog save). Share, publish,
registration, messaging, and destructive operations are blocked even when the
runtime is in benchmark write mode.
