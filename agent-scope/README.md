# agent-scope

Keeps AI coding agents from editing files they shouldn't.

The agent can read the whole repo, but can only **write** the files
covered by an `in_progress` `tasks:Task` in the local DKG, attributed to
the agent. If it tries to touch something else, you get a short question
first — accept or tell it what to do instead. You're never restricted.
This only watches the agent.

## Mental model

agent-scope is a thin write-time guard. The "active scope" is the
**union of `tasks:scopedToPath` globs** across every `tasks:Task` that
is `in_progress` AND attributed (`prov:wasAttributedTo`) to the current
agent. There is no separate manifest file, no per-task JSON, no "active
task" pointer — the local DKG daemon is the source of truth and the
guard reads it live (with a 5-second cache).

That means starting / extending / finishing a piece of work is exactly
the same call you'd make to log it in your project's task graph anyway:

```ts
dkg_add_task({
  taskUri: 'urn:dkg:task:peer-sync-auth',
  title: 'Peer sync uses workspace auth',
  status: 'in_progress',
  assignee: '<agent uri>',
  scopedToPath: ['packages/agent/**', 'packages/core/**'],
})

// later …
dkg_update_task_status({ taskUri: '…', status: 'done' })
```

There's nothing to install, no CLI to learn — the guard just observes
the graph.

## When the agent wants to go out of scope

You'll see something like this in the chat:

> I'd like to edit `packages/foo/bar.ts`, but no in-progress task covers
> that file. Want me to file a new in-progress task covering
> `packages/foo/**` and continue?
>
> A) Yes, file it and continue
> B) Type what you want instead

Pick A, or just type what you'd rather have. Nothing out of scope gets
written without your OK.

## Supported agents

- **Cursor** and **Claude Code** — hard-blocked at the hook level, the
  agent physically can't write out-of-scope files.
- **Codex CLI** and **Gemini CLI** — no hook API yet, so they read
  `AGENTS.md` / `GEMINI.md` on session start and are expected to follow
  the rules. Best-effort.

## Onboarding (new clone)

The intended flow for a coworker who just cloned the repo:

```bash
pnpm install                      # postinstall auto-runs scope-setup
pnpm build                        # builds packages/mcp-dkg/dist/index.js
dkg start                         # in another terminal, leave running
# open Cursor → chat normally
```

What the postinstall step does for you (`scripts/scope-setup.mjs`):

1. **Writes `.dkg/config.yaml`** if it doesn't exist, with sensible
   defaults (`http://localhost:9200`, `~/.dkg/auth.token`,
   `contextGraph: dev-coordination`) and a per-machine agent URI
   auto-derived as `urn:dkg:agent:cursor-${user}-${hostname}`.
2. **Creates the `dev-coordination` paranet** on your local DKG daemon
   if it isn't there yet (skipped silently if the daemon isn't up — the
   next manual `pnpm scope:setup` will pick it up).

If postinstall hooks make you nervous you can run it explicitly any
time:

```bash
pnpm scope:setup                  # idempotent, safe to re-run
pnpm scope:check-agent            # verify Cursor / Claude Code are wired
```

### When the project-level MCP doesn't load in Cursor

Cursor's project `.cursor/mcp.json` is committed and points at the
built `packages/mcp-dkg/dist/index.js`. If after `pnpm build` and a
Cursor restart you still don't see `dkg_*` tools in the chat, fall
back to adding it to your global `~/.cursor/mcp.json` with absolute
paths:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["/absolute/path/to/dkg/packages/mcp-dkg/dist/index.js"],
      "cwd": "/absolute/path/to/dkg"
    }
  }
}
```

This is the safety net for Cursor environments where `node` isn't on
the spawn PATH.

## Editing agent-scope itself

The files that run the guard are permanently off-limits to the agent —
otherwise it could disable itself. To edit them, drop a token:

```bash
touch agent-scope/.bootstrap-token   # unlock
rm agent-scope/.bootstrap-token      # lock again
```

## Architecture (one-pager)

| Layer | Cursor | Claude Code | Soft agents |
|---|---|---|---|
| Inject scope context at session start | `.cursor/hooks/session-start.mjs` | `.claude/hooks/session-start.mjs` | reads `AGENTS.md` / `GEMINI.md` |
| Block out-of-scope writes pre-tool | `.cursor/hooks/scope-guard.mjs` | `.claude/hooks/scope-guard.mjs` | self-enforce |
| Block destructive shell pre-execution | `.cursor/hooks/shell-precheck.mjs` | `.claude/hooks/shell-precheck.mjs` | self-enforce |
| Revert / delete leakage post-execution | `.cursor/hooks/shell-diff-check.mjs` | `.claude/hooks/shell-diff-check.mjs` | n/a |
| Bootstrap reminder per turn | n/a | `.claude/hooks/user-prompt-submit.mjs` | n/a |

All hook implementations sit on the same shared library at
`agent-scope/lib/`:

- `scope.mjs` — protected-path list, glob matching, `checkPath()`,
  bootstrap detection.
- `dkg-source.mjs` — talks to the local DKG daemon, runs the SPARQL
  query that resolves the active scope, caches results for 5s.
- `denial.mjs` — builds the human-readable summary + the structured
  `simpleOptions` menu the agent surfaces via `AskQuestion`.
- `shell-parse.mjs` — pure parser for the shell pre/post hooks.
- `log.mjs` — appends decisions and denials to `agent-scope/logs/`.
- `check-agent.mjs` — diagnostics CLI.

The guard restricts **agent** actions only. Humans committing,
pushing, or editing through their own terminal are not restricted —
there are no git hooks and no CI enforcement.
