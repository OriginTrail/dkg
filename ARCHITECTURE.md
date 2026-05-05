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
class AgentGateMetadata {
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
DKGAgent --> AgentGateMetadata : reads agent gates
DKGAgent --> GossipEnvelope : wraps signed SWM gossip
GossipEnvelope --> SharedMemoryHandler : delivered on SWM topic
SharedMemoryHandler --> AgentGateMetadata : authorizes gated writers
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
Handler->>Meta: read accepted agent writers
alt receiver graph is agent-gated
  Handler->>Handler: require envelope and verify signature, timestamp, and writer
  Handler->>SWM: store accepted write
else receiver graph is not agent-gated
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
