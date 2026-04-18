# `@origintrail-official/dkg-mcp`

A small [Model Context Protocol](https://modelcontextprotocol.io) server
that exposes your local DKG daemon to **Cursor**, **Claude Code**, and
any other MCP-aware coding assistant.

Once installed, an agent can do things like:

- `dkg_list_projects` — see every context graph this node participates in
- `dkg_list_activity` — catch up on the last 25 decisions / tasks / PRs, who authored each
- `dkg_search "tree-sitter"` — full-text search across labels + body text
- `dkg_get_entity urn:dkg:decision:…` — pull a decision's full provenance + 1-hop neighbours
- `dkg_get_chat --keyword "hook"` — ask "what was my teammate's assistant discussing about hooks?"
- `dkg_sparql "SELECT ?d WHERE { ?d a decisions:Decision }"` — drop down to raw SPARQL when the canned tools aren't enough

## Install

```bash
# in the monorepo
pnpm --filter @origintrail-official/dkg-mcp build

# once published to npm
npx -p @origintrail-official/dkg-mcp dkg-mcp
```

The binary is called `dkg-mcp` and reads config from two places, in order:

1. **`.dkg/config.yaml`** walked upwards from the working directory (the spec-canonical workspace config, see `dkgv10-spec / 22_AGENT_ONBOARDING §2.1`)
2. **environment variables** — `DKG_API`, `DKG_TOKEN`, `DKG_PROJECT`, `DKG_AGENT_URI`

Env values always win over the file, and tool-call arguments (`projectId`,
`layer`, …) always win over env.

### Minimal `.dkg/config.yaml`

Copy `packages/mcp-dkg/config.yaml.example` into `<workspace>/.dkg/config.yaml`
and edit:

```yaml
contextGraph: dkg-code-project

node:
  api: http://localhost:9201
  tokenFile: ../.devnet/node1/auth.token   # relative to the YAML file

agent:
  uri: urn:dkg:agent:cursor-branarakic

capture:
  subGraph: chat
  assertion: chat-log
  privacy: team
autoShare: true
```

`.dkg/` is gitignored repo-wide so this file stays local to each operator.

## Wire it into Cursor

Put this in `~/.cursor/mcp.json` (or the workspace-scoped
`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-dkg/dist/index.js"]
    }
  }
}
```

Published via npm:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "npx",
      "args": ["-y", "-p", "@origintrail-official/dkg-mcp", "dkg-mcp"]
    }
  }
}
```

Cursor automatically picks up `.dkg/config.yaml` from the workspace,
so as long as your project has one committed, the server will resolve
the right daemon URL, token, and project id without any per-machine
tweaks.

## Wire it into Claude Code

Either edit `~/.claude/mcp.json` with the same block as above, or
run:

```bash
claude mcp add dkg node /absolute/path/to/packages/mcp-dkg/dist/index.js
```

Inside a Claude Code session you can then do:

```
/mcp dkg_list_activity
/mcp dkg_search "branarakic tree-sitter"
```

## Capture hook

The package also ships a Cursor / Claude Code hook script at
`hooks/capture-chat.mjs` that turns every conversation turn into
`chat:Turn` triples on the project's `chat` sub-graph, and auto-promotes
them to SWM so teammates see them immediately.

Wiring (already committed at the repo root under `.cursor/hooks.json`):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart":       [{ "command": "node packages/mcp-dkg/hooks/capture-chat.mjs sessionStart",       "failClosed": false }],
    "beforeSubmitPrompt": [{ "command": "node packages/mcp-dkg/hooks/capture-chat.mjs beforeSubmitPrompt", "failClosed": false }],
    "afterAgentResponse": [{ "command": "node packages/mcp-dkg/hooks/capture-chat.mjs afterAgentResponse", "failClosed": false }],
    "sessionEnd":         [{ "command": "node packages/mcp-dkg/hooks/capture-chat.mjs sessionEnd",         "failClosed": false }]
  }
}
```

`failClosed: false` is deliberate — the hook exists to enrich the DKG,
never to block the user's conversation. Any error is logged to
`/tmp/dkg-capture.log` (override via `DKG_CAPTURE_LOG`) and the hook
still exits `0`.

Per-turn state is kept in `~/.cache/dkg-mcp/sessions/*.json`; safe to
delete at any time.

## Tools at a glance

| Tool                 | What it does                                                             |
| -------------------- | ------------------------------------------------------------------------ |
| `dkg_list_projects`  | List every context graph this node knows about                           |
| `dkg_list_subgraphs` | List the sub-graphs in one project with entity counts                    |
| `dkg_sparql`         | Execute any SPARQL (prefixes auto-injected) scoped by layer (wm/swm/vm)  |
| `dkg_get_entity`     | Entity detail: all outgoing triples + inbound 1-hop neighbours           |
| `dkg_search`         | Keyword search across labels + body predicates                           |
| `dkg_list_activity`  | Recent activity feed, newest first, with agent attribution               |
| `dkg_get_agent`      | Agent profile card + per-type authored counts                            |
| `dkg_get_chat`       | Captured chat turns, filterable by session / agent / keyword / time      |

All read-only. Write tools (propose decision, add task, comment, etc.)
will arrive in a follow-up release that coincides with the R/W
attribution PR landing.

## Layer semantics

The `layer` argument (where supported) scopes the query to one of the
three DKG memory layers:

- `wm` — working memory (local, private to this node's agents)
- `swm` — shared working memory (gossiped to every participant on the CG)
- `union` — wm + swm combined (default for most tools; matches the
  Node UI's default reader)
- `vm` — verified / on-chain memory (hits `verifiedGraph: true` on
  the daemon, whose responses include UAL + publisher info)

Chat tools default to `union` so you see everything your own agent
wrote plus everything your teammates shared.

## Troubleshooting

- **"No project specified"** — set `contextGraph: <id>` in `.dkg/config.yaml`
  or pass `projectId` on each tool call.
- **HTTP 401** — your token is wrong. Point `node.tokenFile` at the
  `auth.token` file produced by your daemon's devnet setup, or export
  `DKG_TOKEN`.
- **HTTP 404 on `/api/context-graph/list`** — you're on an older daemon;
  the client automatically falls back to `/api/paranet/list`.
