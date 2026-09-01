# `@origintrail-official/dkg-local-llm`

Bounded local-model orchestration for the DKG MCP surface. The package talks to
an OpenAI-compatible llama.cpp or Ollama endpoint and receives its tools
dynamically from MCP `tools/list`.

The runtime is read-only by default. It tokenizes each prompt and dynamically
ranks the discovered MCP tools by their names, descriptions, and input schemas
instead of maintaining a use-case allowlist. The default shortlist is bounded
to eight schemas and 18,000 serialized JSON bytes. Mutations require
`allowWrite: true` and an explicit action/target request.

It also provides:

- local-server-safe JSON Schema normalization (`\\d` becomes `[0-9]` losslessly);
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

### Terminal 1: start Qwen with llama.cpp or Ollama

llama.cpp remains the reference backend:

```bash
/absolute/path/to/llama-server \
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
curl -sS http://127.0.0.1:8080/v1/models
```

Continue only when `/v1/models` returns HTTP 200. The llama.cpp `/health`
response should also be `{"status":"ok"}`.

Alternatively, use Ollama in the model-server terminal:

```bash
ollama pull qwen3:8b
ollama serve
```

If Ollama is already running as a desktop application or service, omit
`ollama serve`. From another terminal, require HTTP 200 from:

```bash
curl -sS http://127.0.0.1:11434/v1/models
```

### Terminal 2: start interactive DKG chat

From the DKG repository root, start an interactive Qwen session against the
`testing` Context Graph with an explicit session pin:

```bash
DKG_HOME=/absolute/path/to/dkg-home \
pnpm dkg llm \
  --interactive \
  --project testing \
  --llama-url http://127.0.0.1:8080/v1/chat/completions \
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
DKG_HOME=/absolute/path/to/dkg-home \
pnpm dkg llm \
  --interactive \
  --project testing \
  --llama-url http://127.0.0.1:8080/v1/chat/completions \
  --model qwen3-8b-q4-k-m
```

For Ollama, replace the last two options with:

```bash
--llama-url http://127.0.0.1:11434/v1/chat/completions \
--model qwen3:8b
```

The legacy option name `--llama-url` accepts either supported backend.

`--project` is an explicit LLM-session pin. The local-LLM command does not
inherit `DKG_PROJECT` as an invisible default. A scoped tool call always carries
`projectId` in the logged MCP arguments: the runtime copies it from exact
catalog evidence first, then from the explicit session pin. Without either, the
call is rejected instead of falling through to the first graph in DKG config.

## Real DKG benchmark

The bundled benchmark uses this production runtime, a real `dkg mcp serve`
child, a real DKG daemon/store, and a real OpenAI-compatible local model. It
creates persistent local data, so `--allow-write` is mandatory and each run
should use unique graph/asset names.

```bash
# Terminal 1: start DKG from this checkout
DKG_HOME=/absolute/path/to/dkg-home \
  node packages/cli/dist/cli.js daemon-foreground-worker

# Terminal 2: start llama.cpp with one model
/absolute/path/to/llama-server \
  -hf Qwen/Qwen3-8B-GGUF:Q4_K_M -ngl 999 -c 8192 \
  --flash-attn on --jinja --temp 0.15 --top-p 0.9 --repeat-penalty 1.05

# Terminal 3: run 8 core scenarios plus 5 holdouts
RUN_ID="$(date +%Y%m%d-%H%M%S)"
DKG_HOME=/absolute/path/to/dkg-home \
DKG_CLI_PATH="$PWD/packages/cli/dist/cli.js" \
pnpm --filter @origintrail-official/dkg-local-llm benchmark:dkg -- \
  --allow-write \
  --graph-id "dkg-llm-qwen8-$RUN_ID" \
  --asset-name "model-families-qwen8-$RUN_ID" \
  --model qwen3-8b-q4-k-m \
  --label "qwen3-8b-q4-k-m-$RUN_ID"
```

To validate Ollama rather than assume parity, start it with the intended model
tag and add
`--llama-url http://127.0.0.1:11434/v1/chat/completions --model qwen3:8b`
to the benchmark command. Keep each model/server pair's output and score
separate from the llama.cpp reference result.

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
