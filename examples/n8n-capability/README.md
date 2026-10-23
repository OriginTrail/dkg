# Invoke an n8n capability as a Program KA

An agent invokes `urn:demo:n8n:normalize-text:1` through the ordinary signed Graph
Computer API. The approved TypeScript Program calls `urn:dkg:tool:n8n`; the host
executes a pinned n8n workflow and returns its actual output and execution ID.
The usual KA lifecycle persists the execution record in private Working Memory.

The example uses n8n's built-in Edit Fields node to trim and uppercase a text
input, between an authenticated Webhook and Respond to Webhook. Its definition,
input/output schemas and exact workflow digest are stored with the Program.
The caller supplies the KA reference and input; it never supplies an n8n URL,
workflow ID, credential or executor.

## Local prerequisites

- This Graph Computer branch, with locked workspace dependencies and runtime
  packages built (`pnpm install --frozen-lockfile`, `pnpm build:runtime:packages`).
- Node 26.8.2 for the DKG/Wasm host. Use the repository's Node baseline for other
  packages when appropriate.
- A separate n8n 2.43.8 installation using Node 24.22.0. Install it outside the
  DKG/nOS workspaces, for example `npm install --prefix /tmp/n8n-ka-runtime n8n@2.43.8`.
- A new private state directory and unused loopback ports 45679 and 4631.

Run n8n in its own terminal, with its Node 24.22 executable selected:

```sh
N8N_USER_FOLDER=/tmp/n8n-ka-state/n8n N8N_LISTEN_ADDRESS=127.0.0.1 \
N8N_HOST=127.0.0.1 N8N_PORT=45679 N8N_PROTOCOL=http N8N_SECURE_COOKIE=false \
N8N_DIAGNOSTICS_ENABLED=false N8N_VERSION_NOTIFICATIONS_ENABLED=false \
/tmp/n8n-ka-runtime/node_modules/.bin/n8n start
```

From this checkout, using Node 26.8.2:

```sh
node examples/n8n-capability/setup-n8n.mjs /tmp/n8n-ka-state http://127.0.0.1:45679
node examples/n8n-capability/serve.mjs /tmp/n8n-ka-state
```

Setup applies only to a fresh, owned instance. It creates a disposable owner,
private credential files, the workflow and a private 24-hour API key for this isolated instance.
The optional fixture-mutation check uses the same existing local key.
Do not commit the state directory.

The server starts a real DKGAgent, persistent Oxigraph store, standard KA-number
allocator, signed HTTP authentication/nonce store and Graph Computer runtime.
It uses `MockChainAdapter` for local chain identity; it makes no public-chain
transactions. Its startup proof calls the actual n8n workflow, reads the DKG
receipt back and retries the same invocation. The proof is `evidence.json`.

In another terminal:

```sh
node examples/n8n-capability/invoke.mjs /tmp/n8n-ka-state/client.json '  hello dkg  '
node examples/n8n-capability/verify.mjs /tmp/n8n-ka-state --check-workflow-change
node examples/n8n-capability/compose.mjs /tmp/n8n-ka-state
```

The invocation prints `HELLO DKG`, the n8n execution identity and a persisted DKG
execution reference. An optional fourth argument to `invoke.mjs` supplies a UUID
for a completed retry. Keep the UUID and input together.

`compose.mjs` stores an approved parent Program KA, invokes the child KA through
`invoke_program`, and records parent/child execution references plus the actual
n8n result `COMPOSED DKG`. Its completed retry returns the same receipt.

Verification checks replay without an additional n8n execution, invalid input,
unauthorized signed callers, viewer/foreign-account refusal and stale KA pins.
`--check-workflow-change` temporarily edits the owned fixture, proves dispatch is
blocked, and restores its exact definition in `finally`.

Stop the DKG server and n8n with Ctrl+C in their own terminals. Retain state for
inspection; only the processes started for this example should be stopped.

## nOS canvas

Use the companion nOS branch based on Ziga's PR #934. Start its normal L1 local
kit, then enable `VITE_NOS_N8N_SPIKE=1 VITE_NOS_KA_POC=1 NOS_KA_POC_PROXY=1` for
the console development server. Network → Workflows → Invoke a KA queries this
DKG node, places the capability on the existing canvas and invokes the same
Program path. The bridge is a loopback-only account-A fixture, using public kit
selectors; production identity integration is separate work.

## Execution boundaries

The tenant approval and the operator installation must agree on graph, executor,
workflow ID and digest. The adapter checks the published definition before
dispatch and the execution's actual published-version ID, graph and reviewed
parameters afterward. n8n expands omitted parameter defaults in its execution
snapshot; those additions are accepted while reviewed values remain exact.

Credentials stay outside KAs, browser payloads and receipts. Requests and results
have bounded sizes, schemas and deadlines. The common effect broker records an
exact per-call approval derived from the tenant grant. Consequential outcomes
that become ambiguous are blocked for inspection; they are never automatically
redispatched. A successful completed retry returns the persisted result after
current authorization checks. Private KA receipts establish provenance and
matching content, not independently verified execution of an external service.
