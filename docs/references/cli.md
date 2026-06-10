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
dkg init                                 # interactive setup — node name, role, relay, triple-store backend (default: oxigraph-server)
dkg start [-f]                           # start the node daemon (-f for foreground)
dkg stop                                 # graceful shutdown
dkg status                               # node health, peer count, identity
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
dkg context-graph list                   # list subscribed context graphs
dkg context-graph info <id>              # show context-graph details
dkg context-graph agents <id>            # list agents in the CG allowlist
dkg context-graph request-join <id> <curatorPeerId>   # request to join a curated CG (peer id from V10 invite)
dkg context-graph sign-join <id>         # sign a join-request delegation locally without forwarding
dkg context-graph approve-join <id>      # approve a pending join request

# Working Memory Knowledge Asset drafts (CLI namespace: dkg assertion)
dkg assertion import-file <name> -f <file> -c <cg>   # import a document into WM
dkg assertion extraction-status <name> -c <cg>       # check document extraction status
dkg assertion query <name> -c <cg>                   # read the WM draft's quads
dkg assertion promote <name> -c <cg>                 # WM → SWM (the share operation; CLI verb retained)

# Shared memory (team-visible) and publishing
dkg shared-memory write <cg> [--name <name>] ...   # stage triples into a named WM Knowledge Asset draft (write-first; share + publish later)
dkg shared-memory publish <cg> --name <name>   # finalize + share + publish a staged WM Knowledge Asset → Verifiable Memory (costs TRAC)
dkg publish <cg> -f <file>               # one-shot RDF publish to a context graph
dkg verify <batchId> --context-graph <cg> --verified-graph <id>  # propose M-of-N verification
dkg endorse <ual> --context-graph <cg> [--agent <addr>]  # endorse a published KA as the authenticated agent (--agent only asserts the token's agent matches)

# Querying
dkg query [cg] -q "<sparql>"             # SPARQL against a local context graph
dkg query-remote <peer> -q "<sparql>"    # query a remote peer over P2P
dkg sync catchup-status <cg>             # show background catch-up status for a context graph
dkg subscribe <cg>                       # subscribe to a CG's gossip topics

# Async publisher (optional, for batching)
dkg publisher enable                     # enable the async publisher
dkg publisher enqueue <cg> --root <e> --namespace <n> --scope <s> --authority-proof-ref <ref> --share-operation-id <id>   # enqueue a publish job (flags required)
dkg publisher jobs                       # list publisher jobs
dkg publisher stats                      # publisher throughput stats

# Code & memory indexing
dkg index [directory]                    # index a code repo into the dev-coordination CG
dkg wallet                               # show operational wallet addresses & balances
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

