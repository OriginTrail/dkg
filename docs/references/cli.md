---
status: current
version: v10
audience: human+agent
doc_type: reference
---

# CLI

Run `dkg <command> --help` for the current option surface.

Common commands:

```bash
dkg init                                 # interactive setup: node name, role, relay, triple-store backend (default: oxigraph-server)
dkg init --role core --network <name>    # initialize a Core Node that will create an on-chain node profile on startup
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, store status
dkg logs                                 # tail the daemon log
dkg peers                                # list discovered agents on the network
dkg peer info <peer-id>                  # inspect a peer's identity and addresses

# Direct messaging
dkg send <name> <msg>                    # encrypted direct message to a peer
dkg chat <name>                          # interactive chat with a peer

# Context graphs (projects)
dkg context-graph create <id>            # create a local context graph
dkg context-graph register <id>          # register an existing CG on-chain (unlocks VM)
dkg context-graph add-agent <id> --agent <addr>   # add an agent to a curated CG allowlist (replaces deprecated 'invite')
dkg context-graph list                   # list known context graphs and subscription state
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id> <curatorPeerId>   # request to join a curated CG (peer id from V10 invite)
dkg context-graph sign-join <id>         # sign a join-request delegation locally without forwarding
dkg context-graph approve-join <id>      # approve a pending join request

# Knowledge Assets: create -> write -> finalize -> share -> publish
dkg ka create <name> -c <cg> --input-file <rdf-file> --share  # one-shot create/write/finalize/share; no VM publish
dkg ka import-file <name> -c <cg> --input-file <file>         # import a document into WM
dkg ka write <name> -c <cg> --input-file <rdf-file>           # append RDF payload quads to WM
dkg ka finalize <name> -c <cg>                                # seal the WM draft
dkg ka share <name> -c <cg>                                   # WM -> SWM
dkg ka share-async <name> -c <cg>                             # enqueue async WM -> SWM share
dkg ka share-jobs [--context-graph-id <cg>]                   # list async share jobs
dkg ka publish <name> -c <cg>                                 # sync SWM -> VM publish
dkg ka publish-async <name> -c <cg> [--publisher-node-identity-id 0]  # enqueue SWM -> VM publish
dkg ka pull-from <name> -c <cg> --layer swm|vm                # seed WM from SWM or VM
dkg ka discard <name> -c <cg>                                 # discard WM draft
dkg ka query <name> -c <cg>                                   # read WM quads
dkg ka history <name> -c <cg>                                 # lifecycle descriptor

# Compatibility aliases
dkg assertion import-file <name> -f <file> -c <cg>  # compatibility alias for document import
dkg assertion promote <name> -c <cg>                # compatibility alias for KA share

# Verification and endorsement
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> [--agent <addr>]  # endorse a published KA as the authenticated agent (--agent only asserts the token's agent matches)

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync catchup-status <cg>             # show background catch-up status for a context graph
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher publish-async <cg> <name> [--publisher-node-identity-id 0]  # alias for dkg ka publish-async
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats
# publisher wallets need native gas plus PCA registration or TRAC; node identity is optional attribution

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show admin and operational wallet addresses and balances
dkg set-ask <amount>                     # set the node's on-chain ask (TRAC per KB·epoch)

# Identity & auth
dkg auth show                            # show the current API auth token
dkg auth rotate                          # generate a new auth token
dkg auth status                          # show whether auth is enabled

# Framework adapters & MCP wiring
dkg openclaw setup                       # install & configure the OpenClaw adapter
dkg hermes setup                         # install & configure the Hermes adapter
dkg mcp setup                            # register the MCP server with Cursor / Claude Code / Claude Desktop / Windsurf / VSCode + Copilot / Cline / Codex CLI
dkg mcp serve                            # run the MCP server on stdio (invoked by the client; not run manually)

# Community integrations (registry: OriginTrail/dkg-integrations)
dkg integration list [--tier community]  # default tier filter is `verified`+
dkg integration info <slug>              # show details for one entry
dkg integration install <slug>           # install cli/mcp kind; --allow-community for community-tier entries

# Health & maintenance
dkg doctor [--json] [--no-orphan-scan]     # diagnose install state, version skew, orphan clones, config sanity

# Update / rollback
dkg update [--check] [--allow-prerelease]  # update node software
dkg rollback                               # roll back to previous version
```

## Context Graph discovery and subscriptions

Every node automatically subscribes to the two protocol control-plane Context
Graphs: `agents` and `ontology`. Context Graphs selected in the node's
`contextGraphs` configuration or a network overlay's `defaultContextGraphs` are
also subscribed at startup because configuration is explicit operator intent.

On edge nodes, other user Context Graphs learned from ontology gossip, the
on-chain registry, or passive local-store discovery are catalogue entries only.
They can appear in `dkg context-graph list`, but remain `subscribed: false` and
do not enter member gossip or catch-up until an explicit subscription, local
create/write, or approved join activates them:

```bash
dkg subscribe <context-graph-id>
```

Core nodes temporarily retain automatic subscription for newly discovered
graphs because they are responsible for Storage ACK custody and the independent
host-mode path does not yet replace every member-subscription handler. A
successful public-graph ACK may additionally set the separate `coreHosted`
flag; that durable hosting obligation is not the same as user membership.
Remove this compatibility bridge only with host-mode separation in #1611.

Nodes upgraded from an older release may already have durable user
subscriptions that cannot be safely classified as manual or discovery-created.
The upgrade deliberately preserves those rows. An operator can inspect active
user subscriptions with `GET /api/context-graph/subscriptions` and deliberately
clear the backlog with the node-admin API:

```bash
curl -X DELETE http://127.0.0.1:9200/api/context-graph/subscriptions \
  -H 'Authorization: Bearer <node-admin-token>'
```

This cleanup clears every non-system, non-`coreHosted` user subscription,
including legitimate subscriptions. It preserves `agents`, `ontology`, hosted
core state, and the graph's VM/SWM data. Re-add wanted user subscriptions
explicitly after cleanup.
