# Reusable workflows and invocation inputs

Studio owns these implementations directly. No source-rewriting overlay or nOS
checkout is needed to load them. Build the runtime workspace first; the
`@origintrail-official/dkg-studio-contracts` private package is included in
`pnpm build:runtime:packages` and the CLI development dependency closure used by
the Graph Runtime and Native LLM CI lanes.

## One versioned interface

A native graph can declare `inputs`, using the same `StudioComponentInput`
contract as a reusable recipe. For example, given a Limit node named `limit`:

```json
{
  "name": "count",
  "label": "Maximum items",
  "required": false,
  "spec": { "type": "integer", "label": "Maximum items", "default": 2, "min": 1, "max": 20 },
  "targets": [{ "nodeId": "limit", "parameter": "count" }]
}
```

A target without `kind` supplies a native parameter. A target with
`"kind": "input"` supplies a field in each incoming data row. This lets an Input
feed Switch's comparison data while its comparison rule stays pinned. One named
input may target multiple fields, including fields inside reusable workflows.
Connection and execution identity fields cannot be changed through arguments.

The schema and target mappings are saved with the KA. A manual `/studio/run`
request adds `arguments: { count: 3 }` alongside the existing KA/source pin,
invocation ID and `itemsJson`. The agent `studio_workflow_run` request uses the
same named values in its `arguments` object and its existing workflow hash/run
key. `studioInputSchema(inputs)` produces the public JSON schema from that same
interface. Required values must be supplied; absent optional values use defaults.

The admitted values travel as canonical `argumentsJson`. They change neither
the saved definition nor its Program source or native workflow digest. Invalid
values are rejected before native dispatch. Reusing an agent run key with the
same normalized arguments reuses its execution; different arguments are refused.
The existing manual Graph Computer invocation journal retains its idempotency.

Native guards and the generated Program validate values through the shared
contract. DKG callbacks resolve parameters only after matching the native
execution's recorded input to the authenticated invocation journal. The selected
operation profile still controls graph access, credentials and current authority.
MCP retains its existing read-only operation policy.

New graphs with named inputs use compiler 9. A native admission node validates the
complete pinned input interface before any component runs, including calls from
other approved Programs that bypass the supplied wrapper. Parameter and data-field
expressions consume its admitted/defaulted values. Before releasing execution, it
also validates every block's resolved native parameters, including HTTP URL rules;
an invalid downstream parameter cannot run earlier side effects. Fixed entry-row
bindings without named inputs also use compiler 9. Host admission and the generated
Program validate the effective rows after fixed and named bindings, so an Extract
File entry can receive `file` through a JSON argument with `itemsJson: "[{}]"`.
The admitted/journalled envelope retains those original rows and separate arguments;
the native guard applies the bindings. Invalid files and combined row-size violations
are rejected before native dispatch. Raw envelope structure is validated explicitly,
before binding rows and applying the real entry descriptor. Compiler 8 and older source bytes remain readable
without changing existing KA or native pins; saving with the new compiler creates a
new version, and varying its invocation arguments does not.

The complete native admission applies to newly saved compiler-9 workflows. Existing
immutable native workflows are not rewritten; save a new revision to install it.
Input guest helpers are frozen source artifacts selected explicitly by compiler
revision, independent of host formatting and TypeScript transforms.

With the supported n8n 2.43.8 engine installed, verify actual native expression
compatibility without services or credentials:
`node examples/n8n-capability/verify-studio-arguments-native.mjs /path/to/node_modules/n8n`.

## Publish and compose

`POST /spike/ka/accounts/<account>/capabilities/studio/components` accepts an
approved workflow's `kaRef`, `sourceHash`, a public `name`, extra exposed `inputs`
(`name`, `label`, `required`, `nodeId`, `parameter`), and `outputs` (`name`,
`nodeId`, `output`). Existing workflow inputs are included automatically. Every
terminal output must be exported. Publication uses the bridge's existing owner
authorization and the execution graph's private Working Memory lane.

The resulting capability has `descriptor.id = "workflow-component"`, immutable
recipe/source pins, a typed public interface, and inherited export authorization.
The shared capability parser accepts both the existing `urn:demo:n8n:component:`
native identities and `urn:nos:component:` identities without rewriting their pins.
Save a compact graph through `/studio/save`. The service resolves selected
recipes, verifies approval and dependencies, expands them and persists both the
execution graph and its pinned authoring snapshot. Reopening/executing that KA
uses the saved expansion rather than querying today's recipe catalog.

Named inputs and reusable compositions currently support native manual workflows.
Schedule, Webhook and Run Program remain on their existing execution paths. This
port does not add a DKG node, change network/chain configuration, replace an
operator's DKG profile, or install the nOS UI/control-plane service. The nOS
Create-context-graph/created-graph-write profile extensions are separate from
this input/composition port.

## Validation

`pnpm test:studio` builds/tests the contracts and executes all native Studio
example tests serially (including the semantic-runtime suites). Coverage includes
save/reopen/run with stable pins, reusable data/parameter expansion, evaluation
of emitted n8n expressions, shared-field/default validation, MCP argument
idempotency, DKG callback input and actor checks, HTTP publication and inventory
failures, and serialized-source rejection before persistence.

These are local runtime integration tests with isolated transport fixtures. They
do not claim a live n8n deployment or a public-chain write.
