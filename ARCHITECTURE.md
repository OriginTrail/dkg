# Architecture

This repository contains the DKG V10 node monorepo: the CLI daemon, agent runtime,
publisher, storage, chain adapters, dashboard UI, and local tooling used to write,
share, publish, and query knowledge assets.

The local publish/async/get benchmark lives inside the CLI package. It is a
developer/operator workflow, not a daemon subsystem: the benchmark runner connects
to an already running DKG daemon, writes unique benchmark payloads to shared
memory, exercises synchronous and asynchronous publish paths, queries the
published marker, and reports timings plus failures. The repository ESBench
workflow for the same feature stays local to benchmark tooling: it uses a
deterministic layered DKG client to measure focused WM, SWM, VM, publish, and
read flows across generated `10kb`, `100kb`, `2mb`, and `200mb` payloads, then
renders both the combined report and per-flow HTML pages.

## Top-Level Components

```mermaid
classDiagram
  direction TB

  class CliPackage {
    <<package>>
    +daemon()
    +benchmark_publish_async_get()
    +ApiClient()
  }

  class PublishGetBenchmark {
    <<tooling>>
    +parseBenchmarkArgs()
    +createBenchmarkClient()
    +runPublishAsyncGetBenchmark()
    +formatResult()
  }

  class EsbenchBenchmarkSuite {
    <<tooling>>
    +publish_async_get_suite()
    +benchAsyncWithHooks()
    +publishAsyncGetHtmlReporter()
    +publishAsyncGetPages
    +filterResultByCase()
  }

  class LayeredBenchmarkClient {
    <<test double>>
    +writeWorkingMemory()
    +liftWorkingMemoryToSharedMemory()
    +sharedMemoryWrite()
    +publishFromSharedMemory()
    +publisherEnqueue()
    +publisherJob()
    +query()
  }

  class BenchmarkReports {
    <<artifact>>
    +latest_json()
    +latest_html()
    +per_flow_html_pages()
  }

  class DkgDaemonApi {
    <<http api>>
    +status()
    +shared_memory_write()
    +shared_memory_publish()
    +publisher_enqueue()
    +publisher_job()
    +query()
  }

  class DkgAgentRuntime {
    <<runtime>>
    +working_memory()
    +shared_working_memory()
    +query()
  }

  class PublisherRuntime {
    <<runtime>>
    +publishFromSharedMemory()
    +enqueue()
    +processNext()
    +finalize()
  }

  class CoreProtocolCrypto {
    <<package>>
    +workspace_encryption()
    +encrypted_workspace_proto()
    +gossip_envelope_proto()
    +workspace_publish_proto()
  }

  class StorageAdapters {
    <<persistence>>
    +local_triple_store()
    +context_graph_store()
    +operation_journal()
  }

  class ChainAdapters {
    <<integration>>
    +evm_commitments()
    +knowledge_collection_roots()
    +publisher_authorization()
  }

  class NodeUi {
    <<frontend>>
    +dashboard()
    +context_graph_views()
  }

  CliPackage --> DkgDaemonApi : starts and exposes
  CliPackage --> PublishGetBenchmark : provides script
  CliPackage --> EsbenchBenchmarkSuite : owns benchmark suite
  PublishGetBenchmark --> DkgDaemonApi : measures via ApiClient
  EsbenchBenchmarkSuite --> LayeredBenchmarkClient : measures deterministic flows
  EsbenchBenchmarkSuite --> BenchmarkReports : renders combined and focused HTML
  DkgDaemonApi --> DkgAgentRuntime : delegates memory and query work
  DkgDaemonApi --> PublisherRuntime : delegates publish work
  LayeredBenchmarkClient ..> DkgAgentRuntime : mirrors WM and SWM behavior
  LayeredBenchmarkClient ..> PublisherRuntime : mirrors enqueue and finalization
  DkgAgentRuntime --> CoreProtocolCrypto : uses SWM wire helpers
  DkgAgentRuntime --> StorageAdapters : reads and writes triples
  PublisherRuntime --> StorageAdapters : reads SWM staging data
  PublisherRuntime --> ChainAdapters : anchors VM commitments
  NodeUi --> DkgDaemonApi : consumes local API
```

## Publish/Async/Get Benchmark Flow

The benchmark command is exposed from `packages/cli` as
`benchmark:publish-async-get`. Configuration is read from CLI flags and matching
environment variables. `DKG_API_PORT` and loopback `DKG_API_URL` targets load the
normal local auth token; non-loopback API URLs require an explicit auth token.

Each warmup and measured iteration gets distinct root entity and marker values so
warmup writes cannot collide with measured payloads. Warmups are recorded but
excluded from summary statistics.

```mermaid
sequenceDiagram
  autonumber
  participant Operator
  participant Script as Benchmark Script
  participant Config as Config Parser
  participant Client as ApiClient
  participant Daemon as DKG Daemon API
  participant Agent as Agent Runtime
  participant Publisher as Publisher Runtime
  participant Store as WM SWM VM Stores
  participant Chain as Chain Adapter

  Operator->>Script: pnpm benchmark:publish-async-get
  Script->>Config: parse flags and environment
  Config-->>Script: benchmark config without secrets in output
  Script->>Client: create client and resolve auth
  Client->>Daemon: GET status
  Daemon-->>Client: daemon available

  loop warmups and measured iterations
    Script->>Script: create unique sync payload
    Script->>Client: sharedMemoryWrite(sync quads)
    Client->>Daemon: POST shared memory write
    Daemon->>Agent: write benchmark triples
    Agent->>Store: persist SWM payload
    Store-->>Agent: share operation recorded
    Agent-->>Daemon: write accepted
    Daemon-->>Client: share operation id

    Script->>Client: publishFromSharedMemory(sync root)
    Client->>Daemon: POST shared memory publish
    Daemon->>Publisher: publish synchronously
    Publisher->>Store: read staged triples
    Publisher->>Chain: anchor knowledge asset
    Chain-->>Publisher: commitment finalized
    Publisher-->>Daemon: kc id
    Daemon-->>Client: publish result

    Script->>Client: query marker for sync payload
    Client->>Daemon: POST query
    Daemon->>Agent: execute SPARQL in selected view
    Agent->>Store: read matching triples
    Store-->>Agent: query result
    Agent-->>Daemon: result bindings
    Daemon-->>Client: query result
    Script->>Script: validate returned marker

    Script->>Script: create unique async payload
    Script->>Client: sharedMemoryWrite(async quads)
    Client->>Daemon: POST shared memory write
    Daemon->>Agent: write benchmark triples
    Agent->>Store: persist SWM payload
    Store-->>Agent: share operation recorded
    Agent-->>Daemon: write accepted
    Daemon-->>Client: share operation id

    Script->>Client: publisherEnqueue(share operation id)
    Client->>Daemon: POST publisher enqueue
    Daemon->>Publisher: enqueue job
    Publisher-->>Daemon: job id
    Daemon-->>Client: enqueue result

    loop until success status or timeout
      Script->>Client: publisherJob(job id)
      Client->>Daemon: GET publisher job
      Daemon->>Publisher: read job state
      Publisher->>Store: resolve queued SWM payload
      Publisher->>Chain: finalize when ready
      Publisher-->>Daemon: current status
      Daemon-->>Client: job status
    end

    Script->>Script: record operation timing or failure context
  end

  Script->>Script: aggregate min max mean median p50 p95
  Script-->>Operator: JSON or NDJSON benchmark result
```

## ESBench Focused Report Flow

The repository-level ESBench suite in `bench/publish-async-get.bench.ts` keeps the
benchmark feature split into named cases. The normal `pnpm bench` workflow writes
the raw ESBench result. `pnpm bench:html` enables the standard combined HTML
report and a publish/async/get reporter that filters the same result into one
HTML page per DKG memory, publish, or read flow.

The focused reporter boundary is the benchmark config: it exports the suite id,
the five case-to-file page mapping, and `filterResultByCase()`. That filter keeps
the payload-size parameter records stable while removing measurements for other
cases from each focused page.

The ESBench path does not call a live daemon. Instead,
`LayeredDkgBenchmarkClient` models the memory layers explicitly: payloads are
written to working memory, lifted to shared working memory, promoted to verified
memory by sync or async publish, and queried from a selected view. This keeps
benchmark report generation deterministic and avoids secrets or
machine-specific daemon paths in the generated pages.

```mermaid
sequenceDiagram
  autonumber
  participant Operator
  participant Esbench as ESBench Runner
  participant Suite as Publish Async Get Suite
  participant Hooks as Case Hooks
  participant Client as Layered DKG Client
  participant WM as Working Memory
  participant SWM as Shared Working Memory
  participant VM as Verifiable Memory
  participant Jobs as Publisher Jobs
  participant Reports as HTML Reporters

  Operator->>Esbench: pnpm bench or pnpm bench:html
  Esbench->>Suite: load publish-async-get cases
  Suite->>Hooks: register before-iteration setup per case

  loop payload sizes and measured iterations
    Hooks->>Client: prepare unique benchmark payload

    alt get/read retrieval
      Client->>WM: write payload
      Client->>SWM: lift payload
      Client->>VM: finalize sync publish
      Suite->>Client: query verifiable-memory marker
      Client-->>Suite: binding with marker
    else synchronous publish with finalization
      Client->>WM: write payload
      Client->>SWM: lift payload
      Suite->>Client: publishFromSharedMemory(root)
      Client->>VM: promote root with kc id
      Client-->>Suite: finalized publish result
    else asynchronous publish enqueue and finalization
      Client->>WM: write payload
      Client->>SWM: lift payload
      Suite->>Client: publisherEnqueue(share operation)
      Client->>Jobs: create queued job
      Suite->>Client: publisherJob(job id)
      Client->>VM: promote queued roots
      Client-->>Suite: finalized job status
    else upload payload to local working memory
      Suite->>Client: writeWorkingMemory(quads)
      Client->>WM: store workspace operation
      Client-->>Suite: workspace operation id
    else lift local working memory to shared working memory
      Client->>WM: write payload
      Suite->>Client: liftWorkingMemoryToSharedMemory(root)
      Client->>SWM: store share operation
      Client-->>Suite: share operation id
    end
  end

  Esbench->>Reports: rawReporter latest.json
  opt ESBENCH_HTML
    Esbench->>Reports: combined latest.html
  end
  opt ESBENCH_PUBLISH_ASYNC_GET_HTML
    Reports->>Reports: filter result by case name and keep payload-size params
    Reports-->>Operator: five focused publish-async-get HTML pages
  end
```

## Codex Architecture Documentation Workflow

The repository architecture documentation is maintained as a docs-only step after
implementation, tests, and code review have passed. That keeps architecture
updates tied to actual code changes while preserving the code and test diff from
documentation-only mutations.

```mermaid
sequenceDiagram
  autonumber
  participant Planner as Codex Workflow
  participant Engineer as Implementation Agent
  participant Tests as Validation and Review
  participant Docs as Mermaid Docs Agent
  participant Arch as ARCHITECTURE.md

  Planner->>Engineer: assign focused implementation subtask
  Engineer->>Engineer: update scoped source files and tests
  Engineer->>Tests: run focused validation and code review
  Tests-->>Planner: implementation accepted
  Planner->>Docs: provide changed files and architecture context
  Docs->>Docs: decide whether architecture changed
  alt architecture update needed
    Docs->>Arch: create or update Mermaid diagrams and prose
    Arch-->>Docs: docs-only architecture diff
  else no architecture update needed
    Docs-->>Planner: leave working tree unchanged
  end
  Docs-->>Planner: report documentation outcome
```

# DKG V10 Architecture

This document captures the top-level runtime boundaries for the node, CLI, and
source-worker integration surfaces. Source workers are part of the CLI-operated
ingestion path used to turn configured source content into Shared Working Memory
writes and async publisher jobs.

## Protocol Surface — V10 only

The DKG protocol is V10-only as of PR #500 (`archive-non-V10-contracts`).
Legacy V8/V9 contracts, deploy scripts, tests, and chain-adapter methods
live under `archive/` subdirectories — preserved for forensics, not in
the live deploy or build path. Fresh V10 deploys never register the V8
`Staking` / `KnowledgeAssets` / `KnowledgeCollection`, V9
`PublishingConvictionAccount` / `Paymaster` / `PaymasterManager` /
`DelegatorsInfo` / `ContextGraphNameRegistry` / `KnowledgeAssetsStorage`
contracts. The chain-adapter SDK targets the V10 contract family
(`KnowledgeAssetsLifecycle` (formerly `KnowledgeAssetsV10`), `StakingV10`, `DKGStakingConvictionNFT`,
`DKGPublishingConvictionNFT`, `RandomSampling`, `StakingKPI`,
`ContextGraphs`, V10 storages, plus shared `Hub` / `Token` / `Profile` /
`Identity` / `Ask`). Trust model: `Hub.owner` = TracLabs multisig.

## CLI Chain Configuration Resolution

Daemon startup resolves chain configuration through a small CLI boundary before
constructing the agent. `packages/cli/src/config.ts#resolveChainConfig()` merges
the persisted operator config layer (`~/.dkg/config.json#chain` or
`~/.dkg/config.yaml#chain`) over `network/<env>.json#chain` per field, so an
operator can override one field such as `rpcUrl` while inheriting the network
`hubAddress`, backup RPCs, token address, and `chainId`. The returned
`chainBase` may still be partial, so daemon consumers guard for both `rpcUrl`
and `hubAddress` before constructing EVM-backed runtime config.

Mock mode is the exception: an operator `chain.type = "mock"` short-circuits the
merge and strips inherited EVM endpoint fields so no daemon consumer can
accidentally open a real JSON-RPC provider while a `MockChainAdapter` is wired.

`chain.approvalPolicy` is the exception to network inheritance. It belongs only
to operator-owned chain config because it changes TRAC allowance sizing and
therefore wallet authorization blast radius. The resolved local policy flows to
`packages/cli/src/daemon/lifecycle.ts`, which converts it with
`resolveApprovalPolicy()` and passes the runtime `ApprovalPolicy` into
`DKGAgent.chainConfig`; the agent then forwards it to `EVMChainAdapter`, where
allowance sizing is applied. `resolveApprovalPolicy()` is the only conversion
point from YAML/JSON string numerics to runtime `bigint` fields.

```mermaid
sequenceDiagram
  autonumber
  participant Local as Operator config chain
  participant Network as network env chain
  participant Resolver as resolveChainConfig
  participant Lifecycle as daemon lifecycle
  participant Policy as resolveApprovalPolicy
  participant Agent as DKGAgent
  participant Chain as EVMChainAdapter

  Local->>Resolver: operator overrides, including approvalPolicy
  Network->>Resolver: default rpcUrl, rpcUrls, hubAddress, tokenAddress, chainId
  Resolver-->>Lifecycle: chainBase field-merged view
  alt chainBase has rpcUrl and hubAddress
    Lifecycle->>Policy: convert chainBase.approvalPolicy
    Policy-->>Lifecycle: runtime ApprovalPolicy or undefined
    Lifecycle->>Agent: chainConfig with endpoints, wallets, chainId, approvalPolicy
    Agent->>Chain: construct adapter with approvalPolicy
  else chainBase partial or absent
    Lifecycle->>Agent: omit chainConfig
  end
```

## Component Model

```mermaid
classDiagram
direction LR
class CLI {
  +sourceWorkerRun(configPath)
}
class SourceWorkerConfig {
  +daemonUrl
  +daemonToken
  +handlerModule
  +handlerExport
  +stateFile
  +sources
}
class SourceWorkerRunner {
  +runConfiguredSourceWorker(configPath)
  +loadHandlerModule(config)
}
class SourceWorkerHandlerModule {
  +createSourceWorkerDeps(context)
}
class SourceWorkerDeps {
  +getFingerprint(source)
  +processSource(source, fingerprint, state)
  +getJobStatus(jobId)
}
class SourceWorkerStateStore {
  +loadSourceWorkerState(path)
  +saveSourceWorkerState(path, state)
}
class SharedMemoryWriteClient {
  +share(contextGraphId, quads, options)
}
class AsyncLiftJobClient {
  +lift(request)
  +getJobStatus(jobId)
}
class DaemonHTTPAPI {
  +postSharedMemoryWrite()
  +postPublisherEnqueue()
  +getPublisherJob()
}
class DKGAgent {
  +writeWorkingMemory()
  +promoteSharedMemory()
  +encodeWorkspaceGossipMessage()
  +publishWorkspaceGossip()
}
class AgentKeyStore {
  +selectDefaultOrFallbackSigner()
  +selectAllowedSigner(contextGraphId)
}
class ContextGraphAccessMetadata {
  +DKG_ACCESS_POLICY
  +DKG_ALLOWED_PEER
  +DKG_ALLOWED_AGENT
  +DKG_PARTICIPANT_AGENT
}
class GossipEnvelope {
  +version
  +type
  +contextGraphId
  +agentAddress
  +timestamp
  +signature
  +payload
}
class WorkspacePublishRequest {
  +paranetId
  +nquads
  +manifest
  +publisherPeerId
  +workspaceOperationId
  +operationId
  +subGraphName
}
class EncryptedWorkspacePayload {
  +version
  +type
  +contextGraphId
  +senderIdentity
  +operationId
  +workspaceOperationId
  +timestampMs
  +subGraphName
  +ciphertext
  +recipients
}
class WorkspaceEncryption {
  +generateWorkspaceRecipientEncryptionKey()
  +encryptWorkspacePayload()
  +decryptWorkspacePayload()
  +computeEncryptedWorkspaceAAD()
}
class WorkspaceRecipientEncryptionKey {
  +purpose
  +recipientId
  +recipientKeyId
  +keyBytes
}
class SharedMemoryHandler {
  +handle(data, from)
  +verifyAgentEnvelope()
  +contextGraphHasPrivateAccessPolicy()
  +getContextGraphAllowedPeers()
}
class PrivateContentStore {
  +storePrivateTriples()
  +getPrivateTriples()
  +storePrivateTriplesForOperation()
}
class AsyncPublisher {
  +enqueue()
  +processNext()
}
class WorkingMemory
class SharedWorkingMemory
class VerifiableMemory

CLI --> SourceWorkerRunner : invokes
SourceWorkerRunner --> SourceWorkerConfig : loads
SourceWorkerRunner ..> SourceWorkerHandlerModule : dynamically imports
SourceWorkerHandlerModule --> SourceWorkerDeps : provides hooks
SourceWorkerRunner --> SourceWorkerDeps : executes
SourceWorkerRunner --> SourceWorkerStateStore : reads and writes state
SourceWorkerRunner --> SharedMemoryWriteClient : wires into handler context
SourceWorkerRunner --> AsyncLiftJobClient : wires into handler context
SharedMemoryWriteClient --> DaemonHTTPAPI : bearer token request
AsyncLiftJobClient --> DaemonHTTPAPI : bearer token request
DaemonHTTPAPI --> DKGAgent : delegates memory writes
DaemonHTTPAPI --> AsyncPublisher : delegates lift jobs
DKGAgent --> WorkingMemory : owns
DKGAgent --> SharedWorkingMemory : gossips
DKGAgent --> AgentKeyStore : selects local signing agent
DKGAgent --> ContextGraphAccessMetadata : reads agent gates
DKGAgent --> GossipEnvelope : wraps signed SWM gossip
DKGAgent ..> WorkspaceEncryption : private SWM payload primitive
WorkspacePublishRequest --> WorkspaceEncryption : plaintext input and output
WorkspaceEncryption --> EncryptedWorkspacePayload : creates and opens
WorkspaceEncryption --> WorkspaceRecipientEncryptionKey : requires dedicated keys
EncryptedWorkspacePayload --> GossipEnvelope : nests as payload bytes
GossipEnvelope --> SharedMemoryHandler : delivered on SWM topic
SharedMemoryHandler --> ContextGraphAccessMetadata : reads access policy and gates
SharedMemoryHandler --> SharedWorkingMemory : stores accepted writes
PrivateContentStore --> WorkingMemory : stages async private lift payloads
PrivateContentStore --> StorageAdapters : writes plaintext private RDF terms
AsyncPublisher --> SharedWorkingMemory : reads source data
AsyncPublisher --> VerifiableMemory : publishes
```

## Shared Memory Gossip Authentication

Shared Working Memory gossip is authenticated at the agent layer when a local
agent private key is available. For non-agent-gated context graphs, the sender
prefers the configured default agent key and falls back to another local signing
agent; if no local signing key exists, the legacy raw SWM payload remains valid.

For agent-gated context graphs, `DKG_ALLOWED_AGENT` and
`DKG_PARTICIPANT_AGENT` metadata define the accepted writer set. Outgoing SWM
gossip must be signed by one of those local agents, otherwise the write is not
broadcast. Receivers accept legacy raw SWM only when the graph is not
agent-gated. For gated graphs, `SharedMemoryHandler` requires a current signed
`GossipEnvelope`, verifies the claimed agent address against the recovered
signature, checks that the envelope context graph matches the payload, and
rejects writers outside the allowed or participant agent set.

Receiver-side access checks also treat explicit `DKG_ACCESS_POLICY = "private"`
metadata in either the context graph `_meta` graph or the ontology graph as
private context graph metadata. If such a graph has no `DKG_ALLOWED_PEER`,
`DKG_ALLOWED_AGENT`, or `DKG_PARTICIPANT_AGENT` gate, `SharedMemoryHandler`
fails closed and rejects received SWM gossip rather than accepting it as open.
`DKG_ALLOWED_PEER` remains a libp2p peer-id allowlist, while the agent gates
remain signed-envelope checks.

`GossipEnvelope` signing authenticates the SWM writer and binds the signed
payload bytes to the claimed context graph, but signatures do not provide
GossipSub payload confidentiality. Open public context graphs therefore retain
the legacy plaintext-compatible `WorkspacePublishRequest` path. Private context
graphs use the separate encrypted workspace payload primitive described below so
raw GossipSub bytes do not expose the plaintext N-Quads or workspace request
fields to non-recipients.

```mermaid
sequenceDiagram
actor Writer as Local agent process
participant Agent as DKGAgent
participant Keys as AgentKeyStore
participant Meta as ContextGraphMeta
participant Gossip as GossipSub
participant Handler as SharedMemoryHandler
participant SWM as SharedWorkingMemory

Writer->>Agent: share or promote SWM write
Agent->>Meta: read DKG_ALLOWED_AGENT and DKG_PARTICIPANT_AGENT
alt context graph is agent-gated
  Agent->>Keys: select local allowed signing key
  alt no allowed private key
    Agent-->>Writer: abort SWM gossip
  else allowed private key exists
    Agent->>Agent: encode signed GossipEnvelope
    Agent->>Gossip: publish signed envelope
  end
else context graph is not agent-gated
  Agent->>Keys: select default or fallback local signing key
  alt signing key exists
    Agent->>Agent: encode signed GossipEnvelope
    Agent->>Gossip: publish signed envelope
  else no signing key
    Agent->>Gossip: publish legacy raw SWM payload
  end
end
Gossip->>Handler: deliver SWM topic message
Handler->>Meta: read DKG_ACCESS_POLICY, DKG_ALLOWED_PEER, and agent gates
alt private access policy has no gossip allowlist
  Handler->>Handler: reject write fail closed
else gossip allowlist exists
  opt agent writer gate exists
    Handler->>Handler: require envelope and verify signature, timestamp, and writer
  end
  opt peer allowlist exists
    Handler->>Handler: require sender peer id in DKG_ALLOWED_PEER
  end
  Handler->>SWM: store accepted write
else receiver graph is open
  Handler->>Handler: decode envelope or legacy raw payload
  Handler->>SWM: store accepted write
end
```

## Encrypted SWM Envelope Primitives

Encrypted Shared Working Memory payloads are defined in `@origintrail-official/dkg-core`
as a nested protocol layer, not as a replacement for the existing
`GossipEnvelope` or `WorkspacePublishRequest` wire schemas. The plaintext
workspace request is encrypted into an `EncryptedWorkspacePayload` with
versioned type constants, AES-256-GCM payload encryption, AES-256-GCM recipient
key slots, and deterministic authenticated data bound to `contextGraphId`,
envelope version and type, sender identity, `operationId`,
`workspaceOperationId`, timestamp, and optional `subGraphName`.

Recipient keys are dedicated workspace encryption keys identified by
`recipientId` and `recipientKeyId`; they are intentionally separate from
Ethereum signing keys. The receiving side recomputes the authenticated data from
decoded metadata and only releases plaintext when a matching recipient key slot
decrypts successfully. Missing recipient keys, unsupported envelope constants,
or metadata tampering fail closed. Open public graphs keep the legacy plaintext
path for backward compatibility, while private graph integration rejects
plaintext fallback.

This encryption boundary is a transport boundary. `DKGAgent.share()`,
`conditionalShare()`, and assertion promotion commit accepted quads to the local
triple store as normal SWM rows, then replicate the `WorkspacePublishRequest`
over GossipSub and/or the Universal Messenger substrate. For private or
agent-gated context graphs, the request bytes are sender-key encrypted when the
sender-key path is configured, or wrapped in `EncryptedWorkspacePayload` as the
legacy encrypted workspace fallback. Receivers decrypt the wire payload first,
run the same authorization and validation checks, and only then insert normal
quads into the local `_shared_memory` graph.

```mermaid
sequenceDiagram
  actor Writer as Local Writer
  participant Runtime as SWM Runtime
  participant Crypto as Core Workspace Encryption
  participant Payload as EncryptedWorkspacePayload
  participant Envelope as GossipEnvelope
  participant Gossip as GossipSub
  participant Receiver as Receiving Runtime
  participant Handler as SharedMemoryHandler

  Writer->>Runtime: prepare WorkspacePublishRequest bytes
  alt private context graph
    Runtime->>Crypto: encryptWorkspacePayload(metadata, plaintext, recipient keys)
    Crypto->>Crypto: compute AAD from context graph, sender, operations, timestamp, subgraph
    Crypto->>Payload: encrypt content key per recipient slot
    Payload-->>Runtime: encoded encrypted workspace bytes
    Runtime->>Envelope: place encrypted bytes in payload
    Runtime->>Gossip: publish signed envelope with ciphertext
    Gossip->>Receiver: deliver raw GossipSub bytes
    Receiver->>Crypto: decodeEncryptedWorkspacePayload and decryptWorkspacePayload(keys)
    alt no matching recipient key or AAD mismatch
      Crypto-->>Receiver: reject fail closed
    else authorized recipient
      Crypto-->>Receiver: plaintext WorkspacePublishRequest bytes
      Receiver->>Handler: apply normal SWM authorization and storage flow
    end
  else open public context graph
    Runtime->>Envelope: keep legacy workspace payload bytes
    Runtime->>Gossip: publish plaintext-compatible SWM message
    Gossip->>Handler: decode envelope or legacy raw payload
  end
```

## Private and SWM Triple-Store Encryption Boundary

Current repository state separates triple-store persistence from peer-to-peer
message confidentiality. See
[ADR 0004](./docs/adr/0004-private-store-plaintext-rdf.md) for the accepted
decision to keep private-store RDF plaintext after message decryption.

- **WM assertions** live in assertion named graphs such as
  `did:dkg:context-graph:<cg>/assertion/<agent>/<name>`. `assertion.write`
  inserts caller quads into that graph unchanged. `assertion.promote` filters
  daemon-reserved metadata, partitions root entities, inserts the promoted quads
  into `_shared_memory`, removes the promoted rows from the assertion graph, and
  updates lifecycle metadata in `_meta`.
- **SWM writes** from `/api/shared-memory/write`,
  `/api/shared-memory/conditional-write`, and assertion promotion persist
  normalized quads directly in `did:dkg:context-graph:<cg>/_shared_memory` or
  the sub-graph equivalent. SWM operation metadata and ownership live in
  `_shared_memory_meta`; the public snapshot store records the same public quads
  for replay and catch-up. The store rows are not `enc:gcm:v1` envelopes.
- **Private content** lives in `_private` graphs through `PrivateContentStore`.
  `storePrivateTriples()` writes accepted RDF object terms unchanged into the
  private graph: literals stay literals, IRI objects stay IRIs, and blank nodes
  stay blank nodes. This is separate from Sender Key SWM and
  `EncryptedWorkspacePayload`, which protect node-to-node messages before the
  receiving node decrypts and stores the payload.
  `storePrivateTriplesForOperation()` remains the async-lift staging path: it
  stores a JSON literal payload in a private staging graph keyed by
  `shareOperationId`, then the async publisher later moves those quads into
  `_private`.
- **Encrypted ACK staging** is a scoped publish-finalization exception, not the
  #633 queryability surface. Curated/private publishes may ask core nodes that
  are not context-graph members to ACK storage without seeing plaintext. In that
  path `StorageACKHandler` stores a temporary base64 ciphertext blob under
  `_shared_memory/staging-encrypted/<merkle-prefix>` and
  `urn:dkg:swm:v10-publish-ciphertext`; those rows are opaque transport escrow,
  not queryable KA triples.

The removed triple-store-level encryption surface was narrow: the
`PrivateContentStore` `enc:gcm:v1` literal seal, `DKG_PRIVATE_STORE_KEY*`
at-rest encryption configuration, exported private-literal decrypt helper, and
publisher exact-dedup decrypt call. Graph routing, private staging, ownership
metadata, assertion lifecycle, SWM persistence, and publisher replay semantics
remain intact. Do not remove the peer-to-peer encryption surfaces: Sender Key
SWM, legacy `EncryptedWorkspacePayload`, or encrypted sender-key setup packages.
The Universal Messenger `sendReliable` / `register` reliability substrate
continues to carry those opaque application payload bytes on the wire. Encrypted
ACK staging also stays out of the #633 fix; if that exception needs to move out
of RDF storage later, handle it as a separate publish-finalization design.

No automatic migration is planned for already-written `_private`
`enc:gcm:v1` rows. They can remain as legacy data and may be overwritten or
recaptured in devnet environments. The scoped fix is forward-looking: new private
triple writes land as plaintext RDF terms so normal SPARQL filters work;
legacy decrypt compatibility is not required for this test/devnet-phase data.
Regression coverage should prove the generic private-store contract, not only
the EPCIS symptom: private writes containing literal objects, IRI objects, blank
nodes, and realistic query predicates must be visible as plaintext RDF terms in
the raw `_private` graph and round-trip through `getPrivateTriples()` without a
decrypt step. EPCIS fixture readback remains useful as manual/devnet validation,
but the core automated regression can live at the storage or publisher layer.
Replace the PR #644 repro narrative that documented literal filters as still
broken; the new regression should assert the intended final contract instead.

## Source Worker Workflow

Source-worker configuration is sensitive operator material. It contains the
daemon bearer token and selects a handler module that the CLI dynamically imports
and executes in the worker process, so it must be protected like the daemon
`auth.token` and must not be committed to source control.

The handler module exposes `createSourceWorkerDeps(context)` either through the
named `handlerExport` selected by config, `default`, `sourceWorker`, or the
module namespace itself. The CLI passes the resolved config plus daemon clients
for Shared Working Memory writes and async publisher lift jobs. The selected
handler returns the source-specific `getFingerprint` and `processSource` hooks.

`getFingerprint(source)` is the content identity contract. Source content that
affects emitted triples or assets must produce a different fingerprint, and
unchanged content must keep the same fingerprint across runs. Fingerprints must
exclude wall-clock time, random values, transient job status, and polling noise.

Worker state is durable process state. Saves use a temp file in the state file's
directory, fsync the file, rename over the target, and fsync the parent directory
where the platform supports it. A failed save removes the temp file and preserves
the previous state file.

```mermaid
sequenceDiagram
actor Operator
participant CLI as dkg CLI
participant Config as SourceWorkerConfig
participant Runner as SourceWorkerRunner
participant Handler as HandlerModule
participant State as StateFile
participant SWM as SharedMemory API
participant Publisher as AsyncPublisher API

Operator->>CLI: dkg source-worker run --config worker.json
CLI->>Config: load and resolve config-relative paths
Config-->>CLI: daemonUrl, daemonToken, handlerModule, handlerExport, stateFile, sources
CLI->>Runner: runConfiguredSourceWorker(configPath)
Runner->>Handler: dynamic import handlerModule and select handler export
Handler-->>Runner: createSourceWorkerDeps(context)
Runner->>State: loadSourceWorkerState(stateFile)
loop each configured source
  Runner->>Handler: getFingerprint(source)
  alt fingerprint is unchanged and prior job is active or finalized
    Runner->>Publisher: GET /api/publisher/job?id=jobId
    Publisher-->>Runner: current job status
    Runner-->>Runner: skip processSource
  else source content changed or retry is needed
    Runner->>Handler: processSource(source, fingerprint, priorState)
    Handler->>SWM: POST /api/shared-memory/write
    SWM-->>Handler: shareOperationId
    Handler->>Publisher: POST /api/publisher/enqueue
    Publisher-->>Handler: jobId
    Handler-->>Runner: nextState
  end
end
Runner->>State: write temp file, fsync file, rename, fsync directory
```

## Main Codex Workflow

The repository workflow uses Codex stages to keep implementation, validation,
review, architecture documentation, and local commit creation separated. This
architecture documentation stage only updates declared architecture write
targets and does not modify code, tests, generated files, dependency files, or
local deployment state.

```mermaid
sequenceDiagram
actor User
participant Workflow as CodexWorkflowGraph
participant Implementer as ImplementFocusedChange
participant Validation as TestsAndCodeReview
participant DocsAgent as MermaidArchitectureAgent
participant Architecture as ARCHITECTURE.md
participant Git as LocalGit

User->>Workflow: continue from failure checkpoint
Workflow->>Implementer: implement focused code change
Implementer-->>Workflow: code and tests changed
Workflow->>Validation: run focused validation and code review
Validation-->>Workflow: passed
Workflow->>DocsAgent: update architecture docs if boundaries changed
DocsAgent->>Architecture: create or update Mermaid diagrams and prose
DocsAgent-->>Workflow: documentation stage complete
Workflow->>Git: create local commits in a later commit stage
```

---

## V10 Publishing Conviction NFT — SDK + daemon wiring (#519)

The V10 `DKGPublishingConvictionNFT` write+read surface is wired
end-to-end through the SDK. Prior to this, the contract was deployed and
invoked by `KnowledgeAssetsLifecycle.publish()` on-chain, but the SDK exposed
only read shims and the daemon `/api/pca/*` routes returned HTTP 503
(the V9 `PublishingConvictionAccount` predecessor was archived in #500).

**Call path (operator → chain):**

```
operator/CLI ─▶ daemon /api/pca/*  ─▶ DKGAgent facade ─▶ ChainAdapter ─▶ DKGPublishingConvictionNFT
                (cli/src/daemon)      (agent/src)        (chain/src)      (evm-module)
publisher  ───────────────────────────────────────────▶ ChainAdapter (read: agentToAccountId, lockDuration)
KnowledgeAssetsLifecycle.publish() ─▶ DKGPublishingConvictionNFT.coverPublishingCost()  (contract-to-contract; NOT in SDK surface)
```

**ChainAdapter V10 PCA surface** (`packages/chain/src/chain-adapter.ts`,
impl `evm-adapter.ts`, parity in `mock-adapter.ts` /
`no-chain-adapter.ts`): `createPublishingConvictionAccount(committedTRAC)`,
`topUpPublishingConvictionAccount(accountId, amount)`,
`registerPublishingConvictionAgent(accountId, agent)`,
`deregisterPublishingConvictionAgent(accountId, agent)`,
`isPublishingConvictionAgent(accountId, agent)`,
`settlePublishingConvictionAccount(accountId)`,
`getPublishingConvictionAccountInfo(accountId)` (V10 12-tuple shape). The dead V9
`publishingConvictionAccount` cache slot was removed.

**V9 → V10 semantic break** (not a rename — DTOs changed shape across
facade / daemon / api-client):

| Concern | V9 (archived) | V10 (wired) |
|---|---|---|
| Lock duration | per-account `lockEpochs` arg | global protocol param (`publishingConvictionEpochs()`); no caller arg |
| Authorization | `authorizedKeys` + `admin` | `registerAgent` + `agentToAccountId` reverse map (one account per agent) |
| Ownership | `admin` field | ERC-721 `ownerOf(accountId)` |
| Funding | `addFunds` → raw balance | `topUp` → persistent `topUpBalance` buffer |
| Settlement | implicit per publish | explicit lazy `settle()` + active sink in `coverPublishingCost` |
| `getAccountInfo` | 6-tuple `(admin,balance,initialDeposit,lockEpochs,conviction,discountBps)` | 12-tuple `(owner,committedTRAC,baseEpochAllowance,createdAtEpoch,expiresAtEpoch,createdAtTimestamp,expiresAtTimestamp,discountBps,topUpBuffer,agentCount,lastSettledWindow,fullySwept)` |

**Owner-gating** (curation trust model): `createPublishingConvictionAccount`
mints to the signer; `topUp` / `registerPublishingConvictionAgent` /
`deregisterPublishingConvictionAgent` are owner-only on chain
(`msg.sender == ownerOf(accountId)`). The SDK surfaces the on-chain
owner revert (`NotAccountOwner`) rather than swallowing it; the daemon
maps it to HTTP **403** (distinct from **503** = no-chain adapter).
Agents publish only — they never mutate the account.

**Daemon HTTP contract** (`packages/cli/src/daemon/routes/pca.ts`,
typed in `packages/cli/src/api-client.ts`): `POST /api/pca`
(`{tokens}`, no `lockEpochs`), `POST /api/pca/:id/funds` (→ `topUp`),
`POST /api/pca/:id/agent` (register) + `DELETE /api/pca/:id/agent/:addr`
(deregister) — replacing the V9 `:id/authorize` key route —
`POST /api/pca/:id/settle`, `GET /api/pca/:id` (V10-shaped body).

**Test coverage:** `packages/chain/test/` exercises the adapter +
mock↔EVM parity; `packages/evm-module/test/v10-pca-lifecycle.test.ts`
covers create → topUp → registerAgent → discounted publish via the real
`KnowledgeAssetsLifecycle.publish()` → expiry revert; the devnet smoke
(`.devnet/run.mjs`) force-boots a **clean** devnet and runs a live
HTTP `/api/pca` round-trip asserting `0 < discountedCost < baseCost`
**on chain** (guards the silent-demotion risk: `KnowledgeAssetsLifecycle` takes the discount
branch only when `publishEpochs == lockDurationEpochs`).

---

## Daemon HTTP Router & Extension Surfaces

The DKG daemon lives in `packages/cli/src/daemon/`. `lifecycle.ts`
(~2,086 LOC) owns process boot — config load, agent/publisher/dashDb
init, Node UI mounting, CORS preflight, and the single global auth
gate. `handle-request.ts` (~446 LOC) owns the per-request HTTP router
and is the file forks historically had to edit to add their own
endpoints. The split between the two is load-bearing for the
route-plugin work: auth and operator-state loading stay in
`lifecycle.ts`, while *dispatch* is a thin sequential chain inside
`handle-request.ts`.

### Request lifecycle

```
HTTP request
  → CORS preflight                                    (lifecycle.ts)
  → httpAuthGuard()        ← single global auth gate  (lifecycle.ts:1865)
  → handleNodeUIRequest()  ← Node UI static + dashboard
  → handleRequest(ctx)     ← per-request router       (handle-request.ts)
      → handleStatusRoutes(ctx)
      → handleAgentChatRoutes(ctx)
      → handleOpenclawRoutes(ctx)
      → handleHermesRoutes(ctx)
      → handleMemoryRoutes(ctx)
      → handlePublisherRoutes(ctx)
      → handleContextGraphRoutes(ctx)
      → handleAssertionRoutes(ctx)
      → handleQueryRoutes(ctx)
      → handleLocalAgentsRoutes(ctx)
      → handleEpcisRoutes(ctx)
      → handlePcaRoutes(ctx)
      → handlePluginRoutes(ctx)   ← route plugins (ADR 0001, slice 1)
      → jsonResponse(res, 404, …)
```

Every dispatcher has the signature
`(ctx: RequestContext) => Promise<void>`. The implicit `next` is "the
response is claimed". The twelve built-in route groups are all
one-shot (they `jsonResponse` / `writeHead` + `end`), so the
short-circuit between them in `handle-request.ts` is just
`if (res.writableEnded) return;` — there is no point checking
`headersSent` for handlers that always end the response synchronously.
Route plugins introduce the streaming case (SSE, `source.pipe(res)`,
chunked transfer); the short-circuit AFTER `handlePluginRoutes(ctx)`
and BEFORE the trailing 404 therefore reads
`if (res.writableEnded || res.headersSent) return;`, so a plugin that
called `writeHead` and is still writing chunks asynchronously is
treated as "claimed" instead of falling through to a 404 + the dispatcher
inside `routes/plugins.ts` retains the same `headersSent`-aware top-of-loop
check across plugins. There is no Express/Koa/Fastify abstraction; the
daemon is bare `node:http`.

### RequestContext — the shared bag

`RequestContext` is defined in `packages/cli/src/daemon/routes/context.ts`
and ferries 24 runtime singletons plus 4 per-request derived locals into
every route group. The fields fall into three buckets:

- **Long-lived runtime handles**: `agent` (DKGAgent), `publisherControl`,
  `publisherRuntime`, `dashDb`, `tracker`, `memoryManager`, `fileStore`,
  `vectorStore`, `embeddingProvider`, `extractionRegistry`,
  `catchupTracker`, `opWallets`, `network`.
- **Configuration & identity**: `config` (DkgConfig), `bridgeAuthToken`,
  `nodeVersion`, `nodeCommit`, `apiHost`, `apiPortRef`, `validTokens`,
  `startedAt`, `assertionImportLocks`, `extractionStatus`.
- **Per-request derived**: `req`, `res`, `url`, `path`, `requestToken`,
  `requestAgentAddress` — the last computed by
  `agent.resolveAgentAddress(requestToken)` so route bodies see a
  uniform agent identity whether the bearer was a node-level token or
  a per-agent token. `emitMemoryGraphChanged` is the SSE fan-out for
  Node UI updates.

The `apiHost` + `apiPortRef` pair exists specifically for
`manifestSelfClient()` to build a self-pointing URL from trusted
server state rather than request headers — SSRF defence carried in
the context.

### Auth boundary — `httpAuthGuard`

The auth boundary is a **single, global, upstream-of-dispatch** check
at `packages/cli/src/daemon/lifecycle.ts:1865`. It runs after CORS
preflight (which short-circuits `OPTIONS`) and before `handleRequest()`,
rejecting with 401 if the bearer token is missing or not in
`validTokens`.

There is one carve-out: a **narrow, per-method public allowlist** in
`packages/cli/src/auth.ts` lets unauthenticated requests through for
specific read-only surfaces:

- `PUBLIC_GET_PATHS` (exact match): `/api/status`, `/api/chain/rpc-health`,
  `/.well-known/skill.md`, `/ui`.
- `PUBLIC_GET_PREFIXES` (trailing-slash anchored): `/ui/`, `/apps/`.
- `PUBLIC_HEAD_PATHS` (HEAD only, narrower than GET): `/api/status`,
  `/api/chain/rpc-health`, `/.well-known/skill.md`. HEAD is honoured
  exactly because the built-in `routes/status.ts` handlers now claim
  HEAD on these three paths (status + headers, no body), so a HEAD
  request never reaches route plugins. `/ui` and `/ui/*`/`/apps/*` are
  deliberately omitted from the HEAD allowlist — they have no built-in
  HEAD claim, so HEAD on those paths must go through auth or a plugin
  matching `HEAD /ui/foo` would run unauthenticated.
- Any non-GET, non-HEAD method on those exact paths (including
  `POST /api/status`, `PUT /.well-known/skill.md`) goes through auth
  like everything else.

Built-in route groups for those public paths therefore can see
unauthenticated GET/HEAD requests. The route-plugin dispatcher
(`handlePluginRoutes`) is the **trailing** step in the chain — it only
runs after every built-in handler has had a chance to claim the
request. A plugin reached by an unauthenticated request would be one
whose path+method overlapped a public allowlist entry that no built-in
claimed. The combination of method-specific path sets + exact path
matching + trailing-slash anchored prefixes + built-in HEAD claims on
the three HEAD-safe paths is designed to make that overlap empty in
practice; route plugins reached after a public fall-through still see
the same `ctx.requestToken` / `ctx.requestAgentAddress` (empty for
unauthenticated) so they can apply finer-grained policy if needed.

For everything outside the allowlist, **every** route group — built-in
or route-plugin — sees only authenticated requests; there is no
per-route auth surface to re-implement.

### Two distinct extension surfaces

The repo deliberately keeps two extension surfaces, with different
trust models and different runtime endpoints. Calling the wrong one a
"plugin" is the most common confusion — see
`packages/cli/src/daemon/CONTEXT.md` for the glossary.

| Surface | Mechanism | Lives in | Trust model | Adds HTTP routes? |
|---|---|---|---|---|
| **`dkg integration`** | Curated registry installer (`InstallCli` / `InstallMcp` / `InstallService` / `InstallAgentPlugin` / `InstallManual`) | `packages/cli/src/integrations/` (`commands.ts`, `schema.ts`, `install-cli.ts`, `install-mcp.ts`, `registry-client.ts`, `verify-npm-provenance.ts`) | Registry-mediated `community` / `verified` / `featured` trust tiers; npm provenance check available | **No** — installs CLI binaries, MCP servers, Docker services, and ElizaOS agent plugins; never mounts daemon endpoints |
| **Route plugin** | npm package exporting `{ name, handle(ctx) }`, named in `config.routePlugins` and loaded once at daemon boot | `packages/cli/src/daemon/plugin-api.ts`, `plugin-loader.ts`, `routes/plugins.ts` (ADR 0001) | Operator-trust (slice 1); npm provenance verification reuses the integrations verifier in v2 | **Yes** — dispatched as the trailing step in the `handleRequest` chain |

The two surfaces may converge later (a new `InstallSpec` kind could
carry a route plugin spec), but slice 1 keeps them separate so fork
authors can ship route plugins without a registry review cycle.

### Route plugin mechanism (ADR 0001)

Approved 2026-05-20 (`docs/adr/0001-daemon-route-plugins.md`, design
`docs/superpowers/specs/2026-05-20-daemon-route-plugins-design.md`):

- **Public contract.** `plugin-api.ts` re-exports `RequestContext` and
  the small set of `http-utils` helpers (`jsonResponse`, `readBody`,
  `readBodyBuffer`, `MAX_BODY_BYTES`, `SMALL_BODY_BYTES`) and defines
  `interface RoutePlugin { name: string; handle(ctx): Promise<void> | void; }`.
  Exposed via a new `./daemon/plugin-api` subpath export on
  `@origintrail-official/dkg`'s `package.json`. Breaking changes are
  semver-major.
- **Startup load.** `loadRoutePlugins(specs, logger)` in
  `plugin-loader.ts` runs once during `lifecycle.ts` boot (after
  agent/publisher init, before `server.listen()`). Spec resolution has
  three cases: (a) absolute filesystem paths are imported directly via
  `pathToFileURL(spec)`; (b) bare specifiers (`@scope/pkg`, `pkg-name`)
  try the ESM resolver first (`await import(spec)`), which honours
  `import` and `default` conditions in the package's `exports` map, and
  on failure (e.g. a CJS-only package whose `exports` declares only a
  `require` condition) fall back to
  `createRequire(import.meta.url).resolve(spec)` and re-import the
  resolved file URL; (c) relative paths (`./foo`, `../foo`) are rejected
  with a fail-soft warn — they would otherwise resolve relative to the
  loader source inside `packages/cli/dist/daemon/` rather than the
  operator's `~/.dkg/config.json`, a footgun that could silently load an
  unrelated daemon module. Validation requires a non-empty `name` and a
  function `handle`. **Fail-soft**: a bad plugin is logged
  (`route-plugin-load-failed`) and skipped; the daemon still boots,
  emitting `route-plugins-loaded { loaded, configured }` so operators
  see the count delta.
- **Per-request dispatch.** `routes/plugins.ts` exports
  `handlePluginRoutes(ctx)` — the thirteenth chain step. It iterates
  `ctx.routePlugins` and calls each plugin's `handle(ctx)` in order.
  An unhandled throw mid-request emits
  `500 { error: 'PluginError', plugin, message }` (only if the
  response hasn't started) and stops the chain. Conflict detection
  between plugins claiming the same path is intentionally absent:
  first plugin in config-list order wins via the same
  `res.writableEnded || res.headersSent` short-circuit the built-in
  chain uses (so streaming plugins claim by starting the response,
  not just by ending it).
- **Operator state, not package state.** `routePlugins?: string[]`
  lives on `DkgConfig` and is read from `~/.dkg/config.json`
  (per-install operator state) so daemon upgrades don't overwrite a
  fork's plugin list. Hot reload is out of scope — restart to pick up
  changes.
- **Footprint.** Adds three files (`plugin-api.ts`, `plugin-loader.ts`,
  `routes/plugins.ts`) and edits five (`handle-request.ts` — one
  import, one parameter, one chain step; `routes/context.ts` — one
  `RoutePlugin[]` field; `lifecycle.ts` — one `loadRoutePlugins` call
  + the new `handleRequest` argument; `config.ts` — one optional
  field; `package.json` — `exports` field). Forks stop conflicting on
  `handle-request.ts` upstream syncs.

EPCIS migration to a route plugin is explicitly out of scope; EPCIS
stays a hard-coded chain step and only moves if/when it needs a code
change for an unrelated reason.
