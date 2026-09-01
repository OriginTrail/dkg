---
status: current
version: v10
audience: agent
doc_type: runbook
---

# Local LLM Agent Runbook

Use this runbook when an operator asks an AI coding agent to start a local
llama.cpp or Ollama model, connect it to DKG, and prove that DKG tool use works.
The agent must not report the setup as ready until the DKG daemon, model
endpoint, Query Catalog policy, and smoke tests have all been checked.

For architecture, troubleshooting, and benchmark details, see
[`Run a Local LLM with DKG`](local-llm.md).

## Select the backend

Keep the operator's explicit choice. If no backend is named, use llama.cpp as
the reference server. Ollama is a supported alternative, not a replacement for
llama.cpp.

| Backend | Chat endpoint | Readiness | Recommended model value |
| --- | --- | --- | --- |
| llama.cpp | `http://127.0.0.1:8080/v1/chat/completions` | `/v1/models`, with `/health` fallback | `qwen3-8b-q4-k-m` |
| Ollama | `http://127.0.0.1:11434/v1/chat/completions` | `/v1/models` | `qwen3:8b` |

## Install the default llama.cpp server

`llama-server` from [`llama.cpp`](https://github.com/ggml-org/llama.cpp) is the
default local inference server for this runbook. This selects the runtime, not
the model family: the same server runs the recommended Qwen GGUF model.

An agent must detect the operating system, execute the corresponding install,
resolve the absolute executable path, and verify it before continuing.

### macOS

Use the upstream Homebrew package:

```bash
brew install llama.cpp
export LLAMA_SERVER="$(command -v llama-server)"
"$LLAMA_SERVER" --version
```

If Homebrew is unavailable, install it first or use the source-build procedure
in the full [`local LLM guide`](local-llm.md#macos). Metal acceleration is
enabled by default in upstream macOS builds.

### Linux

If Conda is already available, use the official conda-forge package:

```bash
conda install -c conda-forge llama.cpp
export LLAMA_SERVER="$(command -v llama-server)"
"$LLAMA_SERVER" --version
```

On Ubuntu or Debian without Conda, build the server from source:

```bash
sudo apt-get update
sudo apt-get install -y build-essential cmake git
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --target llama-server --parallel
export LLAMA_SERVER="$(pwd)/build/bin/llama-server"
"$LLAMA_SERVER" --version
```

For an NVIDIA build, install the CUDA toolkit and configure with
`-DGGML_CUDA=ON`; see the full [`Linux instructions`](local-llm.md#linux).

### Windows

Open PowerShell and install the upstream Winget package:

```powershell
winget install llama.cpp
```

Open a new PowerShell so `PATH` is refreshed, then resolve and verify the
executable:

```powershell
$env:LLAMA_SERVER = (Get-Command llama-server.exe).Source
& $env:LLAMA_SERVER --version
```

If Winget is unavailable or a custom CUDA build is required, use the Visual
Studio or release-binary procedure in the full
[`Windows instructions`](local-llm.md#windows).

Do not silently change the selected backend. llama.cpp and Ollama are supported;
any other runtime requires an explicit operator choice and must pass the same
OpenAI-compatible contract and DKG smoke tests.

## Install Ollama when selected

Complete the full guide's canonical
[Install and run Ollama](local-llm.md#install-and-run-ollama) procedure. That
single section owns installation, desktop/terminal/systemd server ownership,
the minimum context, model loading, and readiness checks. Record the resolved
executable, version, selected model tag, `ollama ps` context, and exact
`/v1/models` match as agent evidence; do not restate or vary the policy here.

## Model decision table

| Model | `llama-server` model selector | `dkg llm --model` value | Real-DKG score | Use |
| --- | --- | --- | ---: | --- |
| Qwen3-8B Q4_K_M | `-hf Qwen/Qwen3-8B-GGUF:Q4_K_M` | `qwen3-8b-q4-k-m` | 13/13 | Default. Best tested balance for chat, catalog queries, reads, and bounded writes |
| Bonsai-8B Q1_0 | `-hf prism-ml/Bonsai-8B-gguf:Q1_0` | `bonsai-8b-q1` | 8/13 | Low-memory experiment. A generated and validated Query Catalog is mandatory; expose only catalog tools for domain reads |
| Qwen3.8-27B UD-IQ1_M | Download `Qwen3.8-27B-UD-IQ1_M.gguf` from `unsloth/Qwen3.8-27B-GGUF`, then use `-m` | `qwen3.8-27b-iq1` | 9/13 | Not recommended on 16 GB. Slow and memory-heavy; catalog-first is mandatory |

The score is from the repository's 13-scenario real-DKG benchmark on the
reference 16 GB Apple Silicon machine using llama.cpp. It is comparative
evidence, not an Ollama parity claim or universal hardware guarantee. An Ollama
model/server combination must pass the smoke test and benchmark independently.

## Instruction to give an AI coding agent

Copy the following block into the coding agent's task. Replace values in angle
brackets, but keep the order and completion checks.

```text
Start a local LLM connected to this DKG node and leave the interactive chat
ready for the operator.

Constraints:
- Work from the active DKG installation or repository; do not clone another DKG.
- Discover absolute executable paths. Do not assume a user-specific home path.
- Keep the backend named by the operator: llama.cpp or Ollama. If none is
  named, use llama.cpp as the reference. Follow the matching install section;
  do not change backends silently.
- Default to Qwen3-8B Q4_K_M unless the operator names another model.
- Treat Bonsai Q1_0, 1-bit models, and other tool-weak models as catalog-first.
- For a catalog-first model, do not start the final demo chat until a reviewed,
  parameterized Query Catalog exists and every saved query has returned a
  representative result.
- Never invent Context Graph IDs, query selectors, parameters, or DKG evidence.
- Keep DKG writes disabled except during an explicitly approved catalog-build
  step. Never share, publish, register, or delete data without explicit approval.
- Run one selected local model server on its configured port at a time.

Procedure:
1. Detect macOS, Linux, or Windows. For llama.cpp, install `llama-server`, set
   `LLAMA_SERVER` to its absolute path, and run `llama-server --version`. For
   Ollama, complete the canonical Ollama procedure linked above. Do not continue
   if the selected executable or its readiness gates fail.
2. Detect whether this is an installed DKG or a source checkout. For an
   installed DKG, run `dkg doctor --json`, `dkg --version`, and `dkg status`.
   In a source checkout, build the CLI, MCP, and local-LLM packages and use
   `node packages/cli/dist/cli.js` anywhere this runbook says `dkg`. Resolve
   install skew, build failures, or daemon errors before continuing.
3. If the daemon is stopped, run `dkg start`, then repeat `dkg status`.
4. Run `dkg context-graph list`. Select the exact operator-provided Context
   Graph ID and export it as `DKG_PROJECT`; never infer it from a display name.
5. Select the model from the model decision table in this runbook.
6. Run `dkg query-catalog list "$DKG_PROJECT"`.
7. If the chosen model is catalog-first and the catalog is empty or untested,
   stop the final-chat startup. Use Qwen3-8B Q4_K_M, a deterministic generator,
   or a domain engineer to define the catalog. Queries must be read-only,
   parameterized, pinned to the correct Context Graph/sub-graph/view, and based
   on the domain schema rather than benchmark answer fixtures.
8. During an operator-approved catalog-build session, start `dkg llm` with
   `--profile write --allow-write`. Ask it explicitly to validate each proposed
   SPARQL query against DKG evidence and save it with
   `dkg_query_catalog_save`. `--allow-write` is temporary and only authorizes
   the requested catalog saves.
9. Verify the result independently with
   `dkg query-catalog list "$DKG_PROJECT"`, then run every saved selector with
   representative values:
   `dkg query-catalog run "$DKG_PROJECT" <selector> --param name=value`.
   Fix or remove any selector that errors or returns the wrong result shape.
10. Start the selected backend. For llama.cpp, use an 8192-token context, Jinja
    templates, temperature 0.15, top-p 0.9, repeat penalty 1.05, host
    127.0.0.1, and port 8080. For Ollama, complete every gate in the canonical
    Ollama procedure linked above without copying or changing that policy.
11. Run `curl -sS <server-origin>/v1/models` and require HTTP 200. For
    llama.cpp, also check `/health` and require `{"status":"ok"}`.
12. Start the final chat with
    `dkg llm --interactive --project "$DKG_PROJECT" --llama-url <chat-endpoint> --model <model>`.
    For catalog-first models also pass `--profile catalog`; do not pass
    `--allow-write`. For the recommended Qwen model use `--profile auto`.
13. Smoke test: ordinary `hello` must not call DKG; a node-status question must
    call `dkg_status`; a saved-query question must call
    `dkg_query_catalog_list`; running a selector must call
    `dkg_query_catalog_run`; an unsupported request must report the catalog gap
    instead of inventing SPARQL.
14. Run `/log` in the chat. Report the exact log path, selected Context Graph,
    model, catalog selectors tested, and smoke-test results to the operator.

Do not call the setup complete if any required command, catalog validation, or
smoke test failed. Report the failing layer: DKG, MCP, model server, tool router,
Query Catalog, or query data.
```

## Exact launch commands

For a source checkout, build the required runtime once:

```bash
pnpm install
pnpm --filter @origintrail-official/dkg-local-llm build
pnpm --filter @origintrail-official/dkg-mcp build
pnpm --filter @origintrail-official/dkg build
```

Then use `node packages/cli/dist/cli.js` in place of `dkg` in the commands
below. Set `DKG_HOME` explicitly when the source checkout must use a non-default
node home.

### llama.cpp reference launch

Set values once in the shell running the client:

```bash
export DKG_PROJECT=<exact-context-graph-id>
export LLAMA_SERVER=/absolute/path/to/llama-server
```

Start the recommended model in a dedicated terminal:

```bash
"$LLAMA_SERVER" \
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

After the health check, start the normal read-only chat:

```bash
dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --profile auto \
  --llama-url http://127.0.0.1:8080/v1/chat/completions \
  --model qwen3-8b-q4-k-m
```

### Ollama launch

Complete the canonical
[Install and run Ollama](local-llm.md#install-and-run-ollama) procedure first.
It is the sole source for installation, context ownership, and readiness. Once
that procedure passes, start the read-only DKG chat against the verified server:

```bash
export DKG_PROJECT=<exact-context-graph-id>
dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --profile auto \
  --llama-url http://127.0.0.1:11434/v1/chat/completions \
  --model qwen3:8b
```

For Node UI, export those endpoint and model values as `DKG_LLM_URL` and
`DKG_LLM_MODEL`, and set `DKG_LLM_BACKEND=ollama`, in the daemon environment
before starting or restarting DKG.

For an explicitly approved Query Catalog build, use the recommended Qwen
llama.cpp server and temporarily start this client:

```bash
dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --profile write \
  --allow-write \
  --model qwen3-8b-q4-k-m
```

Give it the domain schema and query requirements, then ask it to validate one
parameterized, read-only query at a time and save it with
`dkg_query_catalog_save`. Exit this session after the reviewed catalog entries
have been saved and independently run through `dkg query-catalog run`.

For Bonsai Q1_0, first complete the Query Catalog gate above, then replace the
model server command with:

```bash
"$LLAMA_SERVER" \
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

Restrict the final Q1 chat to catalog reads:

```bash
dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --profile catalog \
  --model bonsai-8b-q1
```

The 27B 1-bit experiment is not recommended on a 16 GB machine. If the
operator explicitly requests it, download and launch it with one slot and no
vision projector:

```bash
MODEL_PATH="$(hf download unsloth/Qwen3.8-27B-GGUF \
  Qwen3.8-27B-UD-IQ1_M.gguf --format quiet)"

"$LLAMA_SERVER" \
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

After its catalog gate and health check, start it with:

```bash
dkg llm \
  --interactive \
  --project "$DKG_PROJECT" \
  --profile catalog \
  --model qwen3.8-27b-iq1
```

Use `--allow-write` only for an approved catalog-build turn. The end-user demo
must return to the read-only command above.
