# Development Studio MCP adapter

Runtime implementation proposed for tl-nos #1247 Q1/Q5 and #1227 decision 46.
This extends the companion in dkg#3692, paired with tl-nos#1222. Existing Studio
save/manual run and its Graph Computer path remain available. MCP runs execute
saved native n8n workflows directly. They do not upload or invoke a Program and
do not invent a Graph Computer receipt or `sourceHash`.

The adapter is implemented; the gateway/authority integration is **proposed for
agreement**, not approved by this document. Jurij owns the gateway, audit and
node-call guard; Ziga owns trace presentation. Brana confirmed standing authority
and the signed customer grant in decision 46 on 5 November 2026 (12:25 team update).
A2's launcher and runner are unchanged.

## Development switches and trust boundary

`NOS_STUDIO_MCP=1` mounts the route only with `NODE_ENV=development` and the existing
account-bound `NOS_STUDIO_SESSION_FILE`. Unset, empty or `0` keeps it off (404).
Other values fail startup. `NOS_STUDIO_MCP_AGENT_PREVIEW=1` additionally permits
agent-attributed calls, on fictional development accounts only. It defaults off
and requires the first switch. These switches are not a Commerce grant and
are not themselves a signed grant or evidence that customer enforcement is implemented.

The route is service-to-service, not a browser or public model endpoint:

```
POST /spike/ka/accounts/{accountId}/capabilities/studio/mcp
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2025-06-18
```

It is a stateless JSON response subset of MCP Streamable HTTP (2025-06-18):
`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
GET returns 405 (no SSE stream). Each request reauthenticates. Browser Origin,
customer Authorization bearer, another account and a non-owner role are refused.
See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

The gateway derives these headers from the **authorized running version**, never
from the model's arguments:

| Header | Value |
| --- | --- |
| `x-nos-workflows-secret` | Existing operator-managed Studio service credential |
| `x-nos-workflows-account` | Account bound to this companion/state |
| `x-nos-workflows-role` | `owner` |
| `x-nos-workflows-principal` | Approving owner of record |
| `x-nos-workflows-started-by` | `agent:<id>`; absent for the owner's Test |
| `x-nos-workflows-agent-version` | Exact running agent version |
| `x-nos-workflows-tool-digest` | SHA-256 of the approved tool |
| `x-nos-workflows-approval-decision` | Stable approving decision reference |

The last three are required together with `startedBy`. They are not an agent
identity proof by themselves: the gateway authenticates the agent, checks its
live version, current owner membership, binding/read graphs and approval, and
records admission **before** invoking Studio. The trusted service credential is
not given to Hermes or the model.

## Tools and responses

These are gateway-facing operations. They are not the tools advertised directly
to the agent; Jurij's gateway exposes each approved saved workflow separately.

| Tool | Arguments | Result |
| --- | --- | --- |
| `studio_list` | `{}` | `{workflows:[...]}`; eligible saved native definitions with both pins |
| `studio_get` | `{kaRef,workflowSha256}` | One exact definition, `approved`, `approvalKind`, effect and profile/read graphs |
| `studio_run` | `{kaRef,workflowSha256,runKey,arguments}` | Run state and, if already terminal, bounded output |
| `studio_run_read` | `{runKey}` | Same account run, reconciliation and available terminal output/step trace |
| `studio_withdraw` | `{kaRef,workflowSha256}` | `approved:false`; only an owner's request, never an agent |

For example, the gateway's `tools/call` parameters are:

```json
{
  "name": "studio_run",
  "arguments": {
    "kaRef": "<exact saved Studio reference>",
    "workflowSha256": "<exact saved native SHA-256>",
    "runKey": "<gateway-generated UUID>",
    "arguments": { "sample": "a" }
  }
}
```

Named scalar arguments become one input record. The gateway validates its exact
parameter declarations; Studio independently bounds input, applies the compiled
entry schema and, for DKG Read, the profile's typed-argument validator. Raw JSON
batches, query text, identities and workflow parameters cannot be supplied as
additional invocation fields.

Run summaries contain `accountId`, `runKey`, `kaRef`, `workflowSha256`, `status`,
`approvedBy`, agent correlation fields when present, native execution ID once
acknowledged, timestamps and `actions:[]`. On verified success they also contain
`output:{items,ports}` and the native step trace (statuses, counts, output hashes).
There is no synthesized Program/source hash. Errors contain fixed codes, not
provider errors, workflow contents, arguments or credentials.

`admitted`, `running` and `unconfirmed` are **not successful tool outputs**.
The gateway retains the same key and calls `studio_run_read` until `succeeded`
or `failed`, within its own deadline. On timeout it reports an unconfirmed run;
it must not mint a replacement key or treat `running` as success. This explicit
poll/read handshake is the concrete integration proposal for Jurij to accept.
The stable account/runKey lookup supplies Ziga's trace link without joining by
account+tool+time.

## Saved approval, read-only policy and DKG callbacks

`approved` here means a completed owner save, not standing authority. The existing
save records the normalized definition and native snapshot only after it has
succeeded. Old saves require a deliberate re-save; provisioning leftovers never
become approved through an automatic backfill. Withdrawal blocks future starts
and suppresses output on subsequent reads. Existing execution reconciliation
continues to release capacity only when terminal evidence is verified. Re-saving
the same withdrawn revision does not silently restore it.

DKG run lookup also requires the current profile revision, enabled Read operation
and account scope, plus fresh profile authorization of the requesting principal
with its run key and agent context. Eligibility and withdrawal are checked after
native inspection and again after asynchronous authorization. A removed/changed
profile or denied authorization suppresses both output and steps; verified
terminal evidence still releases the account slot.

The adapter permits the explicit Data list and IF, Switch, Merge, Merge by fields,
Compare Datasets and Stop And Error from #1247. It rejects HTTP, file/export,
loops, waits/events, subworkflows, Program calls and DKG Write. Data-only workflows
are useful development fixtures. A DKG workflow must start with its single DKG
Read and use an explicitly selected account-bound profile with:

- `requiresNosActor:true`, the matching account and pinned profile revision;
- `workflowTools:{effect:'read',readGraphs:[...],validateArguments(args)}`;
- read graphs and typed placeholder/binding behavior covered by that revision;
- the existing profile owner reauthorization and nOS service/node transport.

No existing demo profile opts in. A production/customer profile is not supplied
by the fictional fixture. The gateway must compare these declared graphs with
its approved binding on every call. The profile must never concatenate unescaped
argument text into SPARQL; #1247's query padding and placeholder rules still apply.

Native DKG callbacks must match the admitted run key, workflow, execution,
version and saved pins. They reuse the existing DKG component journal, including
its current input/result retention. Its legacy `source_hash` column holds the
native workflow digest for this path; it is not presented as a Program hash.
Agent callbacks now forward `startedBy`, `runKey`, `agentVersion`, `toolDigest`
and `approvalDecisionId` beside `approvedBy`. The existing #1222 control plane
rejects these extra fields until Jurij adds the #1227 decision-46 guard. There is
no fallback that drops agent identity or retries under the owner's manual path.

## Durability and capacity

`studio_tool_runs` is a native admission/checkpoint journal in the existing
account-bound SQLite database. It stores pins, digests of the request and normalized input, actor correlation,
state and native acknowledgement; **no plaintext arguments or output**. It is
not an additional authority, receipt engine or scheduler. The DKG journal and
n8n continue retaining execution values under their existing policy.

A SQLite partial unique index enforces one nonterminal **agent** execution per
account, including across workers/restarts. The owner's Test/manual run does not
consume this slot. A new agent request reconciles an acknowledged prior run first;
only verified native terminal evidence releases capacity. Caller timeout, process
restart and the n8n 50-second setting do not release it by themselves.

The Studio repository owns both the saved native snapshots and the admission
journal, including migrations, withdrawal, reservation conflicts and checkpoint
updates. The provider handles native transport; the MCP service uses the injected
repository and DKG component journal.

Before dispatch, the admission stores `input_sha256` for the complete normalized
wire input. Terminal inspection uses the same recorded-input decoder as DKG
callbacks, requires a unique completed `Receive input` record, and compares its
input digest and invocation identity with admission. Missing, changed, duplicate
or conflicting input evidence cannot return output or release the slot, including
for failed native executions. Existing rows migrate with a null digest: it is
never reconstructed from a retry or untrusted execution evidence. Such active
legacy runs remain held for operator reconciliation.

Reservation and an uncertain state are durable before POST. A duplicate matching
run key reads the same run; changed arguments, pins or authority conflict. No
restart or lost acknowledgement retries the POST. An unacknowledged run remains
held for operator reconciliation; this implementation does not guess which
execution ran, delete its reservation, or offer a force-release button. Crash
between reservation and dispatch is conservative for the same reason.

## Remaining integration/release gates

- Jurij: agree the wire names and read/poll handshake; implement gateway dispatch,
  decision-46 node guard and the existing audit record's runKey/agentVersion/
  toolDigest/approvalDecisionId linkage. No parallel audit receipt engine.
- Ziga: agree the stable run lookup and display acceptance; this PR adds no UI.
- Brana confirmed approval of an agent version as standing authority for its
  workflow tools, and the signed customer grant (decision 46). Implementation of
  that grant and node-call enforcement is still required.
- Each agent version will carry the owner's choice of reads only (default) or
  reads and writes, shown on the approval card. Changing it requires a new
  version. Jurij owns the contract update; resourceCeiling is the proposed home.
  Enforce the choice on every node call, including inside Programs after the
  Graph Computer switch; blocking programs/execute alone will not suffice.
- This adapter remains read-only on fictional accounts/development nodes. Write
  recovery after lost answers (decision 19) and writes outliving a tool call are
  unresolved. Publishing is separate from writes and requires an agent spending
  cap from Commerce. No per-run approval-click mechanism is introduced.
- An engine-only Graph Computer switch does not require another owner approval,
  but the switch comes back to Brana before any change to grant authority. An
  unchanged workflow digest does not authorize a changed grant.
- Agree a real read-only profile, body/graph enforcement and value-retention/purge
  policy before customer graph or conversation data. This PR does not complete
  all #1227 stage-A run APIs or any stage-B authority contract.
- Run real n8n plus nOS gateway/runner/DKG evidence on the final agreed integration.
  Local fixtures, native HTTP protocol checks and green CI are not that evidence.

Agent-task workflow steps and cross-account graph grants remain separate work.
Nothing in this PR enables production, deploys a service or changes A2 ownership.

## Local verification

Build the pinned companion stack, then run:

```sh
pnpm --filter '@origintrail-official/dkg...' build
node --test examples/n8n-capability/studio-mcp*.test.mjs
```

Tests use private temporary SQLite databases, a loopback HTTP native-provider
fixture and an explicit fictional read profile. They cover pins, authority
headers, read-only rejection, changed arguments, concurrent reservation, restart,
unknown acknowledgement, exact input verification before terminal release,
legacy digest migration, owner/agent slot separation, withdrawal, bounded outputs
and agent attribution on DKG callbacks.

### Native n8n callback regression

The callback binds its execution ID to the durable webhook acknowledgement and
checks the saved workflow digest/version and execution structure. It also requires
the exact granted input from `Receive input` run data or the running execution's
pending node stack. Missing or conflicting input evidence denies the callback.
A callback racing acknowledgement persistence waits up
to two seconds; a lost acknowledgement stays unconfirmed and cannot authorize a
DKG read. Terminal inspection still requires matching saved input evidence.
Withdrawal validates the stored KA/digest even after the current profile changes.

For a repeatable local smoke, start a **fresh, owned** n8n 2.43.8 instance with
Node 24.22.0, a private state directory and unused loopback ports. Keep
`EXECUTIONS_DATA_SAVE_ON_PROGRESS=false` (the default). For example:

```sh
N8N_USER_FOLDER=/tmp/mcp-smoke/engine N8N_PORT=51790 \
  N8N_HOST=127.0.0.1 N8N_LISTEN_ADDRESS=127.0.0.1 N8N_PROTOCOL=http \
  N8N_SECURE_COOKIE=false N8N_RUNNERS_BROKER_PORT=51792 \
  N8N_DIAGNOSTICS_ENABLED=false EXECUTIONS_DATA_SAVE_ON_PROGRESS=false n8n start
# In a second terminal, once n8n is ready:
node examples/n8n-capability/setup-n8n.mjs /tmp/mcp-smoke http://127.0.0.1:51790
node examples/n8n-capability/test-support/mcp-native-smoke.mjs /tmp/mcp-smoke
```

The smoke saves a fictional DKG Read workflow and pins its isolated callback
address before publication. It allows native webhook registration to settle,
then uses authenticated MCP HTTP admission, the real native runner and callback,
and terminal readback. It exercises absent in-progress run data with input evidence
available on the pending node stack, exactly one
webhook POST/callback/DKG read, the expected two measurement rows and no redispatch
on repeated admission. Results are written to `mcp-smoke-result.json` in the state
directory; credentials are not included.

The earlier callback was verified locally on 2026-11-09 with default progress
saving disabled. The subsequent exact-input binding has regression coverage;
rerun this smoke to qualify that integration with a native n8n instance. DKG
transport is a fictional profile. This does not prove the nOS gateway, a customer
DKG node or deployment.
