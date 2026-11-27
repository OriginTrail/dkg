# Semantic runtime capability ACL

Status: design proposal only
Scope: HTTP callers, query-catalog method invocation, wallet identity, Context Graph access, semantic programs, host tools, WASI, and execution-output persistence

## Decision

Do not make a JWT containing `wallets: [...]` the authorization model.

Use the JWT only to authenticate a short-lived session and identify its
delegated capability grants. The primary grant should be narrow, for example:
"this subject may invoke query-catalog methods Q1 and Q2." It should not say
"this subject may read every triple in Context Graph C."

The executing node acts as a controlled service principal. It uses its own
authorized data access to run the approved stored query and returns only that
method's bounded result. The caller receives authority to invoke a method, not
the node's underlying SPARQL, graph, wallet, or storage authority.

The program never grants authority. A program's `(grant ...)`,
`sr:requiresTool`, or `sr:governedBy` declarations describe what it requests
and therefore impose an upper bound on what it may use. Publishing a Tool,
Policy, or CapabilityGrant entity in the DKG does not by itself grant host
access.

This keeps the simple operator rule:

> A node operator decides which adapters and host capabilities exist on that
> node. If the operator explicitly installs and enables shell access, that is
> the operator's decision. A remote program still cannot obtain that access
> merely by naming the tool.

## Primary use case: query catalog as a capability API

The query catalog should be exposed as a typed tool with two operations:

```text
query-catalog.list(program, context-graph)
query-catalog.invoke(query-id, version, parameters)
```

`list` returns only the queries the current program and caller may invoke. It
must not return every catalog entry and must not need to expose the saved
SPARQL text.

`invoke` accepts an immutable query IRI/version (or query hash) plus validated
parameters. It loads the operator/curator-approved query, runs it using the
node's service identity, applies result limits/redaction, and returns the
bounded result. It never accepts arbitrary SPARQL.

A program should list the exact catalog methods it may call. Illustrative
S-expression syntax:

```scheme
(strategy reports/customer-agent
  (version "1.0.0")
  (scope network:devnet)
  (requires
    (tool query-catalog/invoke@1
      (queries
        (urn:dkg:query:customer-summary "3")
        (urn:dkg:query:open-orders "2"))))
  (delegate reporter
    (call query-catalog/invoke@1
      urn:dkg:query:customer-summary
      (customer-id "customer-42"))))
```

The exact syntax can change. The security property is that Wasm admission
extracts a finite set of `(query IRI, version/hash)` pairs. A runtime request
for any other query is rejected before dispatch.

The two principals must remain distinct in the authorization receipt:

```text
requester principal = the wallet/agent allowed to invoke the method
service principal   = the node identity allowed to read the protected data
```

This is deliberate delegation, not impersonation. The requester never becomes
the service principal and never receives its token or raw data-plane access.

## Why a wallet array is too coarse

A token such as:

```json
{
  "sub": "agent-x",
  "wallets": ["0xA...", "0xB..."]
}
```

does not answer the important questions:

- What may the agent do with each wallet?
- Which Context Graph, Knowledge Asset, chain, PCA, or tool is in scope?
- May it query, sign, publish, transfer funds, or only inspect status?
- What are the expiry, use count, value limit, and approval requirements?
- Who issued the permission and can that issuer authorize the resource?
- Can one wallet be revoked without invalidating authority from another?
- May the authority be delegated to one program execution?
- Where may execution output be stored, and at which memory/privacy layer?

Treating possession of a wallet address as authority also creates an ambient
authority problem: any route that sees the address may accidentally use every
operation available to it.

## Authority layers

Authorization is separated into layers with different issuers:

| Layer | Authoritative issuer | What it controls |
| --- | --- | --- |
| Session identity | Node/auth service | Which caller is presenting the request |
| Method grant | Catalog owner, Context Graph authority, or node operator | Which exact query IDs/versions the caller may invoke |
| Wallet delegation | Wallet owner or wallet policy controller | Wallet-bound actions, only when a method actually needs them |
| Service data ACL | Context Graph owner/curator policy | Which protected data the node's service principal may read |
| Node policy | Executing node operator | Which programs, tools, adapters, budgets, and risk classes may run locally |
| Program request | Program author | Requested tools/capabilities only; never authority |
| Execution grant | Executing node, derived from the layers above | The exact authority available to one admitted execution |
| WASI binding | Executing node host | The imports, handles, preopens, clocks, network, and adapters actually linked |

No issuer can grant authority it does not control. A query-catalog owner can
grant invocation of an approved query without granting direct Context Graph
access. A node operator can offer `shell.exec` locally, but that does not give
a caller permission to use Wallet A. Conversely, Wallet A can delegate signing
authority, but it cannot force a node to install or expose a shell adapter.

## Authorization rule

For an individual requested action and resource, allow only when all relevant
conditions hold:

```text
valid authenticated requester session
AND a verified, non-revoked method grant covers this exact query ID/version
AND the admitted program allowlists this exact query ID/version
AND the executing node's current policy offers and allows the catalog method
AND the query definition is trusted, immutable/pinned, and approved
AND the node service principal may read the query's fixed data scope
AND the required catalog adapter is locally installed and enabled
AND parameters match the query's declared schema and constraints
AND the execution grant covers the request and its remaining budget
AND the result policy permits the returned fields, row count, and destination
```

For tool resolution this extends the existing rule to:

```text
effective tools =
    tools requested by the admitted program
  INTERSECT tools offered by the node operator
  INTERSECT tools allowed by the operator's selected policy
  INTERSECT tools permitted to the caller/delegator for this resource
  INTERSECT adapters installed and enabled on this node
  INTERSECT the execution's remaining capability and budget
```

Within the query-catalog tool, the second allowlist is:

```text
effective catalog queries =
    query IDs and versions listed by the admitted program
  INTERSECT query IDs and versions granted to the authenticated requester
  INTERSECT query IDs and versions approved/offered by this node or CG curator
  INTERSECT immutable query definitions available from a trusted catalog graph
  INTERSECT queries executable by the node's service data authority
  INTERSECT the execution's remaining call, row, byte, and time budgets
```

The requester's set need not include `dkg.query`, raw SPARQL, graph read, or a
data-holding wallet. It contains only `query-catalog.invoke` over named query
resources.

Multiple wallet grants are independent. They are not flattened into one global
bag of privileges. A request using Wallet A must be covered by Wallet A's
grant. A request using Wallet B must be covered by Wallet B's grant. An atomic
operation requiring both must name and validate both parent grants explicitly;
the runtime must not construct new privilege by combining unrelated fragments
from different grants.

## Token shape

The current node uses opaque agent tokens that map to one local agent address.
Introducing JWT is optional and should be treated as a transport/session
change, not as the authorization database.

If JWT is introduced, use a short-lived, audience-bound, explicitly typed
token containing references to grants rather than private keys or an ambient
wallet list.

Illustrative protected header:

```json
{
  "alg": "ES256K",
  "typ": "dkg-agent-access+jwt",
  "kid": "node-session-key-7"
}
```

Illustrative claims:

```json
{
  "iss": "did:dkg:node:12D3KooW...",
  "sub": "did:dkg:agent:0xAgent...",
  "aud": "urn:dkg:node-api:12D3KooW...",
  "jti": "018f...",
  "iat": 1788166800,
  "nbf": 1788166800,
  "exp": 1788167100,
  "cnf": { "jkt": "base64url-thumbprint" },
  "cap_refs": [
    "urn:sr:grant:invoke-customer-summary:42",
    "urn:sr:grant:invoke-open-orders:9"
  ],
  "policy_epoch": "operator-policy:17"
}
```

Rules:

- `iss`, `sub`, `aud`, `typ`, signature algorithm, time bounds, and key binding
  must be validated, not merely decoded.
- Prefer sender-constrained proof-of-possession over reusable bearer authority.
- Keep session lifetime short. Long-lived authority belongs in independently
  revocable grants, not in a long-lived JWT.
- Never place wallet private keys, adapter credentials, opaque execution
  capabilities, raw approvals, or secrets in the token or DKG.
- `cap_refs` are hints to locate candidate grants. The policy decision point
  must verify each grant and its current status.
- A token with no covering grant authenticates the caller but authorizes no
  protected action.

OAuth Rich Authorization Requests provide a useful model for structured
actions and resource locations instead of flat scopes. OAuth Token Exchange's
`act` claim is also a useful representation of the current actor when an agent
acts for another principal. These standards are design inputs; the DKG does not
need to implement a full OAuth authorization server in the first version.

## Capability grant

Each grant is a signed statement with a stable identifier. A minimal logical
schema is:

```ts
interface CapabilityGrant {
  grantId: string;
  issuer: string;              // wallet, CG authority, or node operator
  subject: string;             // agent, node, session key, or execution
  audience: string;            // exact node API, runtime, or adapter class
  actions: string[];           // e.g. query-catalog.invoke, dkg.publish, tool.invoke
  resources: string[];         // exact query revision/hash, wallet, CG, KA, or tool
  notBefore: number;
  expiresAt: number;
  maxUses?: number;
  budget?: {
    calls?: number;
    tokenMicros?: string;
    nativeValueWei?: string;
  };
  constraints?: {
    programHash?: string;
    outputContextGraphId?: string;
    outputLayer?: "private" | "shared" | "verifiable";
    allowedChains?: number[];
    allowedHosts?: string[];
    approvalAboveWei?: string;
    parameterSchemaHash?: string;
    resultSchemaHash?: string;
    maxRows?: number;
    maxResultBytes?: number;
    timeoutMs?: number;
  };
  parentGrantIds?: string[];
  delegationDepth: number;
  policyEpoch: string;
  nonce: string;
  signature: string;
}
```

A child grant must be an attenuation of every named parent:

- no new action;
- no broader resource;
- no longer validity window;
- no larger budget or use count;
- no removal of an approval condition;
- no greater delegation depth;
- no audience substitution.

The existing wallet-signed agent-delegation primitive can provide the signing
and verification foundation, but its opaque `scope` string is not sufficient
for this policy. Add a versioned structured payload and keep the existing
signature, time-window, and delegatee validation principles. Grant consumers
must still verify that the issuer is authoritative for the named resource.

## Example: method access without data access

```text
Catalog/CG authority -> Wallet Holder X
  action: query-catalog.invoke
  resources:
    urn:dkg:query:customer-summary@3
    urn:dkg:query:open-orders@2
  expires: 24 hours
  max calls: 100
  no dkg.query
  no raw SPARQL
  no graph read
  no service wallet access

Context Graph authority -> Node Service Agent
  action: dkg.query
  resource: CG-private-customer-data
  constraint: only approved catalog-query hashes

Node operator -> Semantic Runtime
  action: tool.invoke
  resource: query-catalog/invoke@1
  max rows: 100
  max result: 256 KiB
  timeout: 5 seconds
```

Wallet Holder X invokes a program that lists only
`customer-summary@3`. The runtime derives a child grant bound to:

```text
execution = urn:sr:execution:<invocation-id>
program = sha256:<admitted-program-hash>
tool = query-catalog/invoke@1
query = urn:dkg:query:customer-summary@3
query hash = sha256:<approved-sparql-and-schema-hash>
validated parameters = sha256:<canonical-parameter-hash>
tool calls = 1
max rows = 100
max result = 256 KiB
expiry = 60 seconds
one-shot = true
parents = requester method grant + node tool policy + service data ACL
```

The holder can receive the approved summary result but cannot submit a
different SPARQL query, invoke `open-orders@2` from this program, browse the
private graph, or obtain the service agent's credentials.

## Trusted executable catalog versus saved-query UI catalog

The existing profile query catalog is useful source material, but its current
`list`/`run` behavior is not yet a security boundary: it reads saved SPARQL and
then sends that text through the normal query route. Any party allowed to edit
that catalog could change what a named query reads.

Capability-safe execution therefore needs an approved executable revision:

- stable query IRI plus immutable version or content hash;
- trusted catalog graph and expected curator/operator author;
- read-only SPARQL validation;
- fixed Context Graph and subgraph/data-scope constraints;
- typed parameter schema and structural parameter binding, never string
  concatenation;
- result schema or allowed columns;
- mandatory row, byte, and deadline limits;
- optional redaction, aggregation, minimum-group-size, or other disclosure
  policy;
- explicit review/approval status and revocation;
- hash binding across the SPARQL, schemas, scope, and limits.

A mutable slug such as `customer-summary` is a discovery alias, not the
authorization resource. The grant and admitted program must ultimately bind to
`query IRI + revision/hash`. Updating the query creates a new revision that
needs a new approval and, unless explicitly allowed by policy, a new grant.

The catalog adapter must resolve and execute the approved revision internally.
The guest and HTTP caller submit only the query identity and parameters; they
never submit or override SPARQL, graph scope, result columns, or limits.

## Semantic runtime flow

1. **Authenticate the requester.** Resolve the opaque token or JWT into an
   `AuthorizationContext`; do not resolve directly to a wallet array.
2. **Authorize program invocation.** Check `semantic-runtime.invoke` for the
   requested program. This does not yet grant any catalog method.
3. **Load trusted policy and catalog facts.** Load the program from the
   requested Context Graph, but load operator policy, Tool offers, executable
   query revisions, and approvals only from expected trusted VM graphs and
   authors.
4. **Admit in Wasm.** Compile and admit the S-expression. Its `grant` forms and
   tool/query declarations become a finite requested capability ceiling.
5. **Authorize the exact catalog method.** Intersect the requester's method
   grant, the program's exact query allowlist, the trusted catalog revision,
   and the node's policy. The requester does not need raw graph-read authority.
6. **Derive an execution capability.** Bind the approved query ID/hash,
   parameter-schema hash, canonical parameter digest, result constraints,
   service principal, adapter, budgets, approvals, and policy epoch.
7. **Give Wasm only handles.** The guest sees typed WIT imports and opaque
   execution-local handles. It never sees the caller JWT, wallet keys, node
   credentials, or reusable parent grants.
8. **Recheck each effect.** When Wasm requests an effect, the host broker checks
   the execution capability, exact verb/resource/input digest, approval,
   adapter identity, budget, revocation, and policy epoch.
9. **Execute as the service principal.** The catalog adapter loads the pinned
   query internally, binds validated parameters, applies fixed data scope and
   limits, and queries using the node's data authority. There is no arbitrary
   SPARQL fallback.
10. **Recheck at dispatch.** Repeat the security-critical checks immediately
   before calling the adapter so a policy change or revocation between prepare
   and dispatch fails closed.
11. **Return or persist according to result policy.** Method permission covers
   only the approved bounded response to the requester. Tool permission does not
   imply permission to publish output. Validate destination CG, memory layer,
   author wallet, and redaction policy before writing.
12. **Record a receipt.** Persist the requester, service principal, query
    revision/hash, result hash, decision, and effect provenance without
    persisting credentials or opaque capability secrets.

Graph-triggered and HTTP-triggered execution must use the same steps. A graph
event is an invocation source, not an authorization bypass.

## DKG representation

The DKG is useful for discovering public policies, signed delegations,
revocations, tool descriptions, and execution receipts. Those triples become
authoritative only after the local node verifies the expected issuer,
signature, graph provenance, validity window, revocation state, audience,
resource, and current policy.

Proposed V2 vocabulary additions, shown illustratively:

```turtle
@prefix sr: <https://origintrail.io/semantic-runtime/v1#> .

<urn:dkg:query:customer-summary:3>
  a sr:CatalogQuery ;
  sr:version "3" ;
  sr:queryHash "sha256:<query-schema-scope-and-limits-hash>" ;
  sr:parameterSchemaHash "sha256:<parameter-schema-hash>" ;
  sr:resultSchemaHash "sha256:<result-schema-hash>" ;
  sr:dataScope <urn:dkg:context-graph:private-customer-data> ;
  sr:maxRows 100 ;
  sr:maxResultBytes 262144 ;
  sr:approvedBy <did:dkg:agent:0xCurator> .

<urn:sr:program:customer-agent>
  a sr:Program ;
  sr:programHash "sha256:<admitted-program-hash>" ;
  sr:mayInvokeQuery <urn:dkg:query:customer-summary:3> .

<urn:sr:grant:invoke-customer-summary:42>
  a sr:CapabilityGrant ;
  sr:issuer <did:dkg:agent:0xCurator> ;
  sr:subject <did:pkh:eip155:8453:0xWalletHolder> ;
  sr:audience <urn:dkg:node-api:12D3KooW...> ;
  sr:permitsAction sr:InvokeCatalogQuery ;
  sr:resource <urn:dkg:query:customer-summary:3> ;
  sr:notBefore "2026-08-31T10:00:00Z" ;
  sr:expiresAt "2026-09-01T10:00:00Z" ;
  sr:maxUses 100 ;
  sr:policyEpoch "catalog-policy:42" ;
  sr:proof "<detached-signature>" .
```

`sr:mayInvokeQuery` is a discovery projection. The runtime must recompute and
verify the same query set from the Wasm-admitted program source; the projection
alone is not authority.

The ontology must continue to state that descriptive entities do not grant
authority by mere publication. In particular:

```turtle
<urn:tool:shell-exec> a sr:Tool .
```

does nothing unless the executing node has installed and enabled the matching
adapter, the operator's current policy permits it, and the caller's derived
execution capability covers the exact operation and resource.

Keep locally:

- wallet private keys;
- node/session signing keys;
- API credentials;
- raw bearer tokens;
- opaque capability handles;
- adapter secrets;
- approval secrets and non-public inputs.

The DKG receipt may contain hashes or public references to grants and policy
versions, but not reusable secrets.

## WASI alignment

This model maps directly to a future WASI Component Model boundary:

- a DKG Tool descriptor identifies a versioned WIT interface;
- the admitted program declares the interface it expects;
- the node operator decides whether a local implementation exists and is
  enabled;
- the authorization engine derives the execution capability;
- the component linker supplies only the approved imports and resources;
- each imported function receives an execution-local resource handle;
- filesystem preopens, environment variables, clocks, randomness, and network
  access default to absent and are added only by operator policy.

The important boundary is that WIT describes a callable interface, while the
host decides whether and with what authority that interface is linked. DKG
triples can describe the interface and policies; they cannot create a host
binding.

The narrow interface can look conceptually like:

```wit
interface query-catalog {
  resource execution-capability;

  record query-ref {
    iri: string,
    version: string,
    hash: string,
  }

  list: func(cap: borrow<execution-capability>) -> list<query-ref>;
  invoke: func(
    cap: borrow<execution-capability>,
    query: query-ref,
    parameters: list<u8>,
  ) -> result<list<u8>, query-error>;
}
```

The host constructs `execution-capability`; Wasm cannot forge it. `list`
returns the already-computed intersection for this execution, and `invoke`
accepts only an item from that set.

## Execution and output recording

Authorization must cover output recording explicitly. A successful tool call
does not automatically authorize publishing its response.

An `sr:Execution` receipt should record:

- invocation ID, program IRI and admitted program hash;
- authenticated principal and current actor;
- executing node;
- applied policy ID, hash, and epoch;
- non-secret parent grant IDs or hashes;
- derived execution-capability ID or hash;
- tool, adapter version/hash, action, and resource;
- authorization decision ID and reason code;
- output destination, memory layer, content hash, and publication UAL;
- effect status and reconciliation evidence;
- timestamps and remaining/consumed budget.

Raw query results, LLM prompts, and LLM outputs may be stored only when the
result/output grant and data policy allow it. Otherwise return only the bounded
method response and store a hash, encrypted/private-layer payload, aggregate,
or redacted projection. Authorization receipts must not leak tokens, keys,
provider credentials, hidden prompts, raw protected rows, or opaque host
capability handles.

## Fit with the current implementation

The existing implementation already has several useful pieces:

- `resolveAgentByToken` maps an opaque token to one local agent.
- semantic program resolution intersects program-required tools with
  operator-authored Tool offers, operator policy, and locally registered and
  enabled adapters.
- a profile query catalog and `list`/`run` clients already exist, providing a
  useful catalog data shape and UX starting point.
- the effect broker stores execution-scoped capability metadata, supports
  one-shot use and budgets, and rechecks policy/capability bindings before
  dispatch.
- execution results are persisted as an `sr:Execution` Knowledge Asset.
- the wallet-signed agent-delegation primitive verifies issuer signature,
  scope, delegatee, issuance time, and expiry.

The current gaps this design must close are:

- route authentication resolves only to an agent address, not an authorization
  context;
- invocation is not checked against structured caller/method grants;
- profile query-catalog `run` currently resolves saved SPARQL client-side and
  forwards it to the general query route; it is not an approved, hash-pinned
  method boundary;
- semantic programs cannot yet declare an exact finite catalog-query set;
- there is no semantic-runtime `query-catalog/invoke@1` adapter that resolves
  the pinned query internally and rejects raw SPARQL;
- the execution principal and persisted author are currently the node operator;
- the runtime currently creates its execution capability locally instead of
  deriving it from verified parent grants;
- the current semantic-runtime policy adapter returns `allow` after tool
  resolution rather than evaluating the complete request context;
- the current execution capability lifetime is much broader than a one-call
  LLM smoke execution needs;
- output publication is not governed by a separate destination/data grant.

## Minimal implementation sequence

This can be introduced without replacing all authentication at once.

### Phase 1: approved query-catalog adapter and program allowlist

- Add `query-catalog/invoke@1` as a closed semantic-runtime adapter.
- Define approved executable query revisions with stable IRI, hash, fixed data
  scope, parameter/result schemas, limits, and curator/operator approval.
- Extend S-expression admission to return the exact query revisions listed by
  the program.
- Make runtime resolution expose `effectiveQueries` and an unavailable reason
  for each requested query.
- Let Wasm call only the admitted query identities and typed parameters.
- Do not add a free-form SPARQL input or fallback.

### Phase 2: central authorization context and method grants

- Keep existing opaque tokens.
- Replace route-level `token -> agentAddress` use with
  `token -> AuthorizationContext`.
- Add one central `authorize(action, resource, context)` decision point.
- Require `semantic-runtime.invoke` plus `query-catalog.invoke` for the exact
  query revision. Do not require general `dkg.query` for the requester.
- Authorize the node service principal separately for the query's fixed data
  scope.
- Filter catalog `list` to the program/caller/node-policy intersection.
- Require separate authorization for persistence outside the method response.
- Deny when no grant covers the exact action/resource.

Suggested context:

```ts
interface AuthorizationContext {
  principal: string;
  currentActor: string;
  sessionId: string;
  grantRefs: string[];
  proofKey?: string;
  policyEpoch: string;
}
```

### Phase 3: structured grants and execution attenuation

- Add a versioned structured payload beside the existing opaque-scope
  delegation.
- Store public signed grants and revocations; index their current state locally.
- Make catalog-method grants independent from raw graph and wallet grants.
- Derive a short-lived child grant bound to program hash, query hash,
  parameter digest, service principal, schemas, result limits, and policy epoch.
- Add attenuation checks for every child execution grant.
- Record authorization decision receipts.
- Pass only opaque handles into Wasm.
- Revalidate revocation and policy at prepare and dispatch.
- Make the graph-trigger and HTTP-trigger paths share this derivation.

### Phase 4: JWT and proof of possession

- Add a JWT session-token profile with strict `typ`, issuer, audience,
  algorithm, and time validation.
- Carry grant references rather than an ambient wallet array.
- Sender-constrain the token with DPoP or an equivalent node-supported proof.
- Preserve opaque-token compatibility during migration, but send both token
  types through the same authorization context and policy engine.

JWT is therefore not a prerequisite for the capability ACL. The central policy
decision and structured grants can land first.

## Required security invariants

- Authentication without a covering grant authorizes nothing.
- Permission to invoke an approved catalog method does not imply raw SPARQL,
  Context Graph read, or service-wallet access.
- Requester and service principal are distinct and both appear in the receipt.
- `query-catalog.list` returns only the program/caller/node-policy intersection.
- Query authority is bound to an immutable revision/hash, not a mutable slug.
- The caller and Wasm cannot supply or override SPARQL, graph scope, result
  columns, or limits.
- Query parameters are structurally bound after schema validation; they are not
  interpolated into SPARQL text.
- A program declaration can reduce authority but never add it.
- A DKG triple cannot install, enable, or grant a host adapter.
- A request body cannot select a wallet outside its covering grant.
- Revoking one wallet grant does not revoke or broaden another.
- Child grants are monotonically narrower than every parent.
- Policy selection is operator-controlled; a remote program cannot select a
  weaker operator policy.
- Policy and capability are rechecked immediately before effect dispatch.
- Tool invocation and output publication are independently authorized.
- WASM receives no JWT, wallet key, provider credential, or reusable parent
  capability.
- Failed, stale, ambiguous, unverifiable, or unavailable authorization data
  fails closed.
- Direct HTTP and graph-triggered executions use the same authorization path.

## Acceptance tests

1. A program listing Query A and Query B receives exactly those catalog
   entries further allowed by the caller grant and node policy.
2. A program listing only Query A cannot invoke Query B even when the caller is
   independently allowed to invoke Query B.
3. A caller granted Query A can invoke it without `dkg.query`, raw SPARQL,
   graph-read, or service-wallet authority.
4. Changing a query slug, version, hash, Context Graph, subgraph, SPARQL,
   result column, or limit in the request is rejected.
5. Editing a saved query under the same slug creates a different hash and is
   not executable until approved and granted.
6. Invalid parameters fail schema validation and cannot alter the query
   structure.
7. Row, byte, and deadline limits are enforced by the host even if the stored
   query omits a limit.
8. Revoking a method grant or query approval blocks new calls without changing
   the requester's unrelated grants.
9. A valid session token with no matching method grant receives `403`, not
   execution.
10. A forged, expired, wrong-audience, wrong-subject, or wrong-proof token is
   rejected before policy evaluation.
11. A published `shell.exec` Tool with no installed/enabled operator adapter is
   unavailable.
12. An installed shell adapter is still unavailable unless operator policy and
   the execution capability both cover the exact operation/resource.
13. A program's `(grant shell.exec)` cannot elevate an execution.
14. Revocation or policy-epoch change between prepare and dispatch blocks the
   effect.
15. A query may succeed while unauthorized result publication fails closed and
    records a non-secret failure receipt.
16. A graph event cannot bypass the invocation and output ACL.
17. The persisted execution receipt identifies requester, service principal,
    query/program/policy hashes, decision provenance, and result hash but
    no token, key, credential, or opaque host handle.

## Standards references

- [RFC 8725: JSON Web Token Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725)
- [RFC 9396: OAuth 2.0 Rich Authorization Requests](https://www.rfc-editor.org/rfc/rfc9396)
- [RFC 8693: OAuth 2.0 Token Exchange](https://www.rfc-editor.org/rfc/rfc8693)
- [RFC 9449: OAuth 2.0 Demonstrating Proof of Possession](https://www.rfc-editor.org/rfc/rfc9449)
