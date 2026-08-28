---
status: current
version: v10
audience: human+agent
doc_type: how-to
---

# Run a Local LLM with DKG

Use this guide to connect a local GGUF model to the DKG MCP tools through the
OpenAI-compatible `llama.cpp` server. The model does not connect to the DKG
daemon directly: `dkg llm` starts an MCP client, discovers the available tools
with `tools/list`, validates every tool call, and writes a readable interaction
trace.

The runtime is read-only by default. Write tools are exposed only with
`--allow-write`, and the user must still explicitly request the mutation.

If you are delegating setup to a coding agent, give it the dedicated
[`Local LLM Agent Runbook`](local-llm-agent-runbook.md). It contains a
copy-paste instruction, model decision table, Query Catalog gate, exact launch
commands, and completion checks.

## Recommended model

Use **Qwen3-8B Q4_K_M** as the default local model. It provided the strongest
tool-calling result in the real-DKG benchmark on the reference 16 GB Apple
Silicon machine.

| Model and quantization | Real-DKG score | Relative resource use | Recommendation |
| --- | ---: | --- | --- |
| Qwen3-8B Q4_K_M | 13/13 | Medium | Recommended default for chat, catalog use, reads, and bounded writes |
| Bonsai-8B Q1_0 | 8/13 | Low | Use only with a pre-built Query Catalog and a narrowly routed tool set |
| Qwen3.8-27B UD-IQ1_M | 9/13 | High memory pressure and very slow on 16 GB | Not recommended on 16 GB; the 1-bit quantization did not outperform Qwen3-8B Q4 |

These scores compare the same 13 scenarios against a real DKG daemon and MCP
server. They are reference results, not a universal hardware benchmark. A new
model should pass the bundled real-DKG benchmark before it becomes a recommended
default.

## Small-model rule: build the Query Catalog first

For Q1, aggressively quantized, or otherwise tool-weak models, prepare the
domain Query Catalog **before** starting the end-user chat.

Do not rely on a small model to design arbitrary SPARQL at runtime. Use this
onboarding workflow instead:

1. A domain engineer, deterministic generator, or stronger model drafts the
   reusable SPARQL queries.
2. Make each query parameterized with typed `{{parameter}}` placeholders.
3. Pin its Context Graph, sub-graph, and memory view.
4. Execute the query against fixture or live data and verify its expected
   result columns.
5. Save it with `dkg_query_catalog_save` only after it passes.
6. Expose `dkg_query_catalog_list` and `dkg_query_catalog_run` to the small
   model. Avoid the generic `dkg_query` fallback unless the model has passed a
   raw-SPARQL evaluation.
7. If no catalog entry matches a request, return that limitation instead of
   inventing a selector or SPARQL query.

Example MCP payload for a reviewed catalog entry:

```json
{
  "name": "dkg_query_catalog_save",
  "arguments": {
    "projectId": "manufacturing",
    "name": "Products by category",
    "description": "Return products for one reviewed category.",
    "subGraph": "products",
    "catalogSlug": "product-search",
    "view": "verifiable-memory",
    "sparql": "SELECT ?product ?name WHERE { ?product <schema:category> {{category}} ; <schema:name> ?name } ORDER BY ?name",
    "parameters": [
      {
        "name": "category",
        "type": "string",
        "label": "Category",
        "required": true
      }
    ],
    "resultColumn": "product",
    "mode": "upsert"
  }
}
```

Always run the saved selector with a representative parameter before making it
available to the small model.

## Prerequisites

- A configured DKG node and Context Graph.
- A built or installed `dkg` CLI containing the `dkg llm` command.
- A recent `llama.cpp` build with `llama-server`.
- Enough memory for the selected GGUF model and an 8192-token context.

Verify an installed node:

```bash
dkg status
```

For a source checkout, build the required packages once:

```bash
pnpm install
pnpm --filter @origintrail-official/dkg-local-llm build
pnpm --filter @origintrail-official/dkg-mcp build
pnpm --filter @origintrail-official/dkg build
```

The remaining steps use three terminals.

## Terminal 1: start DKG

For a globally installed node:

```bash
dkg start
dkg status
```

For a source checkout:

```bash
export DKG_HOME=/absolute/path/to/dkg-local

DKG_HOME="$DKG_HOME" \
  node packages/cli/dist/cli.js daemon-foreground-worker
```

Leave the daemon running. Its default API is `http://127.0.0.1:9200`.

## Terminal 2: start one local model

Run only one `llama-server` on port 8080 at a time.

### Recommended: Qwen3-8B Q4_K_M

```bash
/absolute/path/to/llama.cpp/build/bin/llama-server \
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

### Low-memory experiment: Bonsai-8B Q1_0

Use this model only after completing the Query-Catalog-first workflow above.

```bash
/absolute/path/to/llama.cpp/build/bin/llama-server \
  -hf prism-ml/Bonsai-8B-gguf:Q1_0 \
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

### 27B 1-bit experiment

This configuration is not recommended on a 16 GB machine. If testing it, use
one slot and disable the unused vision projector:

```bash
MODEL_PATH="$(hf download unsloth/Qwen3.8-27B-GGUF Qwen3.8-27B-UD-IQ1_M.gguf --format quiet)"

/absolute/path/to/llama.cpp/build/bin/llama-server \
  -m "$MODEL_PATH" \
  -ngl 999 \
  -c 8192 \
  -np 1 \
  --flash-attn on \
  --jinja \
  --no-mmproj \
  --temp 0.15 \
  --top-p 0.9 \
  --repeat-penalty 1.05 \
  --host 127.0.0.1 \
  --port 8080
```

Wait for `model loaded`, then check the endpoint:

```bash
curl -sS http://127.0.0.1:8080/health
```

Expected result:

```json
{"status":"ok"}
```

## Terminal 3: start DKG chat

With a globally installed CLI:

```bash
export DKG_PROJECT=my-context-graph

dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --model qwen3-8b-q4-k-m
```

From a source checkout:

```bash
export DKG_HOME=/absolute/path/to/dkg-local
export DKG_PROJECT=my-context-graph

DKG_HOME="$DKG_HOME" \
  node packages/cli/dist/cli.js llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --model qwen3-8b-q4-k-m
```

Omit `--interactive` and append a prompt for a one-shot request:

```bash
dkg llm --project "$DKG_PROJECT" \
  "Which saved DKG Query Catalog queries are available?"
```

The default endpoint is
`http://127.0.0.1:8080/v1/chat/completions`. Override it with `--llama-url` or
`DKG_LLM_URL`.

## Agent smoke test

Run these prompts in order:

1. `hello` — should answer without a DKG tool call.
2. `What is the status of this DKG node?` — should call `dkg_status`.
3. `Which saved queries are available in this DKG Query Catalog?` — should
   call `dkg_query_catalog_list`.
4. Ask it to run one exact selector returned by step 3 with declared parameter
   values — should call `dkg_query_catalog_run`.
5. Ask a question that the catalog does not cover — a catalog-first small
   model should report the gap, not invent a selector.

Useful interactive commands:

| Command | Purpose |
| --- | --- |
| `/tools` | Show the complete MCP-compatible tool surface |
| `/history` | Show retained bounded chat turns and evidence tool names |
| `/log` | Print the current plain-text interaction log path |
| `/clear` | Clear bounded session history |
| `/help` | Show commands and session budget |
| `/exit` | End the session |

Logs are owner-only text files under `<DKG_HOME>/logs/local-llm` by default.
They include system context, model requests, tool calls, DKG results, retries,
and final answers with secrets redacted.

## Domain adapters

Use a domain profile to add literal routing keywords, adapter tool names, and a
domain-specific context addendum without patching the generic router:

```bash
dkg llm \
  --interactive \
  --project manufacturing \
  --adapter /absolute/path/to/domain-adapter.js \
  --domain-profile /absolute/path/to/domain-profile.json \
  --model qwen3-8b-q4-k-m
```

Keep business IDs, expected answers, and benchmark fixtures out of the generic
system context. Domain facts must come from the DKG tool results.

## Writes

Read-only is the safe default. Enable writes only for an operator-approved
session:

```bash
dkg llm --interactive --project my-context-graph --allow-write
```

`--allow-write` does not automatically mutate DKG. The prompt must explicitly
request a routed mutation. Do not expose share, publish, registration, or
destructive tools to a small model unless the workflow has an additional
operator approval gate.

## Troubleshooting

### `connection refused` on port 8080

The model is not loaded or `llama-server` stopped. Check:

```bash
curl -sS http://127.0.0.1:8080/health
```

### The model invents selectors or SPARQL

Use the Query-Catalog-first workflow. Verify that the selected Context Graph
contains reviewed catalog entries, and route the small model only to
`dkg_query_catalog_list` and `dkg_query_catalog_run`.

### The catalog is empty

Catalog definitions are Context-Graph-specific. Generate, validate, and save
the domain queries before the chat demo. Selecting another Context Graph does
not copy its catalog.

### Answers are slow or time out

Use Qwen3-8B Q4_K_M, keep one model server running, reduce competing memory
pressure, and preserve the 8192-token server context. Increase
`--request-timeout-ms` only after confirming the model is still generating.

### Inspect the exact interaction

Use `/log`, then open the printed file with `less`. The trace distinguishes
model generation failures from MCP, DKG, and query-result failures.

## Validate another model

Before recommending another model, run the production real-DKG benchmark. It
uses the same runtime, a real MCP child process, a real DKG daemon/store, and
independent state verification. See
[`packages/local-llm/README.md`](../../packages/local-llm/README.md#real-dkg-benchmark).
