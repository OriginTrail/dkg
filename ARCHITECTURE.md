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
    Publisher->>Chain: anchor knowledge collection
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
  participant VM as Verified Memory
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
      Suite->>Client: query verified-memory marker
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
# DKG V10 Architecture

This document captures the top-level runtime boundaries for the node, CLI, and
source-worker integration surfaces. Source workers are part of the CLI-operated
ingestion path used to turn configured source content into Shared Working Memory
writes and async publisher jobs.

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
class SharedMemoryHandler {
  +handle(data, from)
  +verifyAgentEnvelope()
  +contextGraphHasPrivateAccessPolicy()
  +getContextGraphAllowedPeers()
}
class AsyncPublisher {
  +enqueue()
  +processNext()
}
class WorkingMemory
class SharedWorkingMemory
class VerifiedMemory

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
GossipEnvelope --> SharedMemoryHandler : delivered on SWM topic
SharedMemoryHandler --> ContextGraphAccessMetadata : reads access policy and gates
SharedMemoryHandler --> SharedWorkingMemory : stores accepted writes
AsyncPublisher --> SharedWorkingMemory : reads source data
AsyncPublisher --> VerifiedMemory : publishes
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

`GossipEnvelope` signing authenticates the SWM writer and binds the payload to
the claimed context graph, but it does not encrypt GossipSub payload bytes.
Operators should treat SWM gossip contents as visible to subscribed peers.

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
