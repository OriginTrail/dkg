# DKG Dev Coordination — Agent Instructions

This repository uses a **Decentralized Knowledge Graph (DKG)** for multi-agent development coordination. A local DKG node maintains a structured code graph and project knowledge that you should query before exploring files directly.

## Setup

The DKG MCP server must be configured in your MCP settings:

```json
{
  "mcpServers": {
    "dkg": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

The DKG daemon must be running (`dkg start`).

## Session Start Protocol

Before exploring the codebase, **always** query the dev-coordination paranet first. These queries cost a fraction of the tokens that file exploration does.

### 1. Check what has been worked on recently

```sparql
SELECT ?s ?summary ?agent ?date ?cost WHERE {
  ?s a <https://ontology.dkg.io/devgraph#Session> ;
     <https://ontology.dkg.io/devgraph#summary> ?summary ;
     <https://ontology.dkg.io/devgraph#agent> ?agent ;
     <https://ontology.dkg.io/devgraph#startedAt> ?date .
  OPTIONAL { ?s <https://ontology.dkg.io/devgraph#estimatedCost> ?cost }
}
ORDER BY DESC(?date) LIMIT 10
```

### 2. Check active tasks

```sparql
SELECT ?t ?desc ?status ?assignee WHERE {
  ?t a <https://ontology.dkg.io/devgraph#Task> ;
     <https://ontology.dkg.io/devgraph#description> ?desc ;
     <https://ontology.dkg.io/devgraph#status> ?status .
  OPTIONAL { ?t <https://ontology.dkg.io/devgraph#assignee> ?assignee }
  FILTER(?status != "done")
}
```

### 3. Check recent architectural decisions

```sparql
SELECT ?d ?summary ?rationale ?by ?date WHERE {
  ?d a <https://ontology.dkg.io/devgraph#Decision> ;
     <https://ontology.dkg.io/devgraph#summary> ?summary ;
     <https://ontology.dkg.io/devgraph#rationale> ?rationale ;
     <https://ontology.dkg.io/devgraph#madeBy> ?by ;
     <https://ontology.dkg.io/devgraph#madeAt> ?date .
}
ORDER BY DESC(?date) LIMIT 5
```

## Code Exploration via DKG

Instead of using Glob/Grep/Read to find files, **query the code graph first**:

### Find modules related to a topic

```sparql
SELECT ?path ?lineCount ?pkg WHERE {
  ?m a <https://ontology.dkg.io/devgraph#CodeModule> ;
     <https://ontology.dkg.io/devgraph#path> ?path ;
     <https://ontology.dkg.io/devgraph#lineCount> ?lineCount ;
     <https://ontology.dkg.io/devgraph#containedIn> ?p .
  ?p <https://ontology.dkg.io/devgraph#name> ?pkg .
  FILTER(CONTAINS(LCASE(?path), "staking"))
}
```

### Find a function and what it calls

```sparql
SELECT ?name ?sig ?path WHERE {
  ?f a <https://ontology.dkg.io/devgraph#Function> ;
     <https://ontology.dkg.io/devgraph#name> ?name ;
     <https://ontology.dkg.io/devgraph#definedIn> ?mod .
  ?mod <https://ontology.dkg.io/devgraph#path> ?path .
  OPTIONAL { ?f <https://ontology.dkg.io/devgraph#signature> ?sig }
  FILTER(?name = "requestWithdrawal")
}
```

### Find package dependencies

```sparql
SELECT ?pkg ?dep WHERE {
  ?p a <https://ontology.dkg.io/devgraph#Package> ;
     <https://ontology.dkg.io/devgraph#name> ?pkg ;
     <https://ontology.dkg.io/devgraph#dependsOn> ?d .
  ?d <https://ontology.dkg.io/devgraph#name> ?dep .
}
```

### Find what imports a module

```sparql
SELECT ?importerPath WHERE {
  ?importer <https://ontology.dkg.io/devgraph#imports> ?target ;
            <https://ontology.dkg.io/devgraph#path> ?importerPath .
  ?target <https://ontology.dkg.io/devgraph#path> ?targetPath .
  FILTER(CONTAINS(?targetPath, "chain-adapter"))
}
```

### Find Solidity contract inheritance

```sparql
SELECT ?child ?parent ?path WHERE {
  ?c a <https://ontology.dkg.io/devgraph#Contract> ;
     <https://ontology.dkg.io/devgraph#name> ?child ;
     <https://ontology.dkg.io/devgraph#inherits> ?parent ;
     <https://ontology.dkg.io/devgraph#definedIn> ?mod .
  ?mod <https://ontology.dkg.io/devgraph#path> ?path .
}
```

### Find test files for a module

```sparql
SELECT ?srcPath ?testPath WHERE {
  ?m a <https://ontology.dkg.io/devgraph#CodeModule> ;
     <https://ontology.dkg.io/devgraph#path> ?srcPath ;
     <https://ontology.dkg.io/devgraph#testFile> ?t .
  ?t <https://ontology.dkg.io/devgraph#path> ?testPath .
  FILTER(CONTAINS(?srcPath, "evm-adapter"))
}
```

## During Your Session

### When making architectural decisions

Publish a `devgraph:Decision` so other agents can see it:

Use the `dkg_publish` MCP tool with quads like:
- `<urn:decision:TIMESTAMP> rdf:type devgraph:Decision`
- `<urn:decision:TIMESTAMP> devgraph:summary "Chose X over Y for Z"`
- `<urn:decision:TIMESTAMP> devgraph:rationale "Because ..."`
- `<urn:decision:TIMESTAMP> devgraph:madeBy "claude-code"`
- `<urn:decision:TIMESTAMP> devgraph:affects <file:path/to/module.ts>`

### When completing a task

Update the task status:
- `<urn:task:ID> devgraph:status "done"`
- `<urn:task:ID> devgraph:completedIn <urn:session:TIMESTAMP>`

## When to Fall Back to File Tools

Use Read/Grep/Glob when:
- The code graph doesn't cover the specific file (e.g., config files, scripts)
- You need to see the actual implementation, not just the structure
- The graph is not yet indexed for a new file you just created

The DKG graph gives you the **map**; file tools give you the **territory**. Start with the map.

## Vocabulary Reference

All classes and properties use the `devgraph:` namespace (`https://ontology.dkg.io/devgraph#`).

| Class | Description |
|-------|-------------|
| `Session` | A coding agent work session |
| `Decision` | An architectural decision |
| `Task` | A planned work item |
| `Package` | A workspace package |
| `CodeModule` | A source file |
| `Function` | An exported function or method |
| `Class` | An exported class |
| `Contract` | A Solidity smart contract |

The full ontology is at `packages/mcp-server/schema/dev-paranet.ttl`.

---

## Task-scoped writes (`agent-scope`) — MANDATORY behaviour

This repo ships an opt-in task-scoping guard. It stays **invisible** unless
engaged. Default behaviour: write normally, read anything. The guard only
kicks in when:

1. The user runs `pnpm task start` and the trigger line
   `agent-scope: start task onboarding` appears in your context (marker
   consumed by a hook or by your top-of-turn check). The marker already
   embeds the user's task description — do NOT ask them to describe it
   again, OR
2. An active task is set (session-start hook injects a context block naming
   it), OR
3. You try to touch one of the hardcoded protected paths that defend the
   guard itself — those are always blocked unless the user has enabled
   bootstrap mode.

### Task onboarding protocol (triggered by `pnpm task start` / "start a scoped task")

`pnpm task start` asks the user for a task description in the terminal,
drops `agent-scope/.pending-onboarding` (gitignored) with that description
already embedded, and copies the trigger to the user's clipboard. The
marker is one-shot: the first thing that consumes it also deletes it, so
it fires for **exactly one** user message no matter which chat that
message lands in.

Three parallel consumers — whichever runs first wins:

- `sessionStart` hook — fires on any NEW Cursor chat.
- `postToolUse` hook — fires after ANY tool call in an existing chat.
- **You, on the very first action of every turn** (see the mandatory
  top-of-turn check below) — covers the gap when the user sends a purely
  conversational message (e.g. "hi") that would not otherwise cause a tool
  call.

### MANDATORY top-of-turn marker check

Before responding to **every** user message in a session that has **no
active task** (`agent-scope/active` is absent), your FIRST action MUST be:

1. `Read` the path `agent-scope/.pending-onboarding`. If the file does not
   exist, continue with your normal response — no further action.
2. If the file exists:
   a. Delete it immediately using the `Delete` tool or `rm` via a single
      shell command. This is critical — if you leave it there, the next
      turn will re-trigger onboarding.
   b. IGNORE the user's actual message (whatever they typed, even if it
      was a specific instruction — they knew onboarding was pending when
      they sent it).
   c. Pivot to the **Task onboarding protocol** below: parse the marker
      payload for a `=== USER TASK DESCRIPTION ===` block. If present, use
      it as the brief and skip step 1 below. Otherwise, ask the user to
      describe the task.

Skip this check only when `agent-scope/active` exists (a task is already
set — no onboarding needed) or when this is a multi-turn conversation
already mid-onboarding.

When you receive additional_context / initial context beginning with
`agent-scope: start task onboarding.` (from the hooks), treat it exactly
like the marker was present: STOP your current plan and run the onboarding
protocol below.

1. **Get the task description.**
   - If the trigger / marker contains a `=== USER TASK DESCRIPTION ===`
     block (the `pnpm task start` flow), use that verbatim. DO NOT ask the
     user to describe the task again — they already typed it into the CLI.
   - Otherwise, ask them in plain chat: "OK, let's scope a new task.
     Describe in detail what we're building or fixing — packages,
     behaviours, tests, any files you already know about." Wait for
     reply.
2. **Explore the codebase** with `Glob`, `Grep`, `SemanticSearch`, `Read`,
   and the DKG SPARQL queries to find the files the task will touch.
   Count matching files per candidate package.
3. **Draft a set of globs** that covers those files plus their tests. Err
   slightly broad; prefer whole-package globs (`packages/<name>/**`) over
   file-level globs; inherit `base`; always append `!**/secrets.*`,
   `!**/.env*`.
4. **Propose the scope via a SINGLE `AskQuestion` — one question, two
   options.** Write it like you're asking a coworker, not filling out a
   form. 3 sentences max: one-line rephrase of the task, the scope you'd
   propose (3–5 numbered globs), then "Sound good?" Example:

   > Refactor peer sync to use the new workspace auth. I'd scope it to:
   > 1) `packages/agent/**`
   > 2) `packages/core/**`
   > 3) inherit `base` (standard build-artefact exemptions)
   >
   > Sound good?

   Options (IDs must match exactly — only these two):
   - `go` — `"Yes, go with that"`
   - `custom_instruction` — `"Type what you want instead"`

5. **On `go`**, **YOU (the agent) run the command yourself** via the
   Shell tool. The `afterShellExecution` hook has a narrow allowlist for
   exactly this invocation: a canonical `pnpm task create <id> ...` or
   `node agent-scope/bin/task.mjs create <id> ...` is the ONLY shape that
   may persist new files under `agent-scope/tasks/` and `agent-scope/active`.
   The command's `--allowed` flags must match your proposed scope verbatim
   (any deviation is a protocol violation):

   ```bash
   pnpm task create <id> \
     --description "..." \
     --allowed "<glob-1>" \
     --allowed "<glob-2>" \
     --inherits base \
     --activate
   ```

   After the command succeeds, continue with the actual work in the same
   turn. If the command fails, surface the error and re-ask via
   AskQuestion instead of retrying blindly.

6. **On `custom_instruction`**, ask the user in plain chat what they want
   changed (packages, globs, task id, whatever), apply it to the draft,
   then re-ask step 4 — still one short question with two options.

### Plan-mode denial protocol (runs for every agent-scope denial)

When agent-scope blocks a write or reverts a shell command, stop and
surface a short menu. Do NOT retry, rewrite, or work around the denial —
the defense-in-depth layers revert tracked changes and delete untracked
files in denied paths anyway.

Every denial message starts with `agent-scope:` prose and contains a
fenced JSON block:

```
<!-- agent-scope-menu:begin -->
{ ... JSON payload ... }
<!-- agent-scope-menu:end -->
```

The JSON shape (key fields only):

```ts
{
  humanSummary: string,           // QUOTE this in your AskQuestion prompt
  simpleOptions: [                // exactly two entries — SURFACE these
    { id, label, action },        // the recommended option
    { id: "custom_instruction",   // free-text fallback (always present)
      label: "Type what you want instead",
      action: { kind: "custom" } }
  ],
  recommendedOptionId: string,    // matches simpleOptions[0].id
  reason: "out-of-scope" | "protected" | "manifest-load-error" | "unknown",
  deniedPath?, command?, activeTask, options: [ /* verbose — do NOT surface */ ],
}
```

**Protocol:**

1. **Stop.** Do not retry via another tool or command form.
2. **Extract the JSON.** Parse between the fences.
3. **Call `AskQuestion`** — ONE question, the TWO `simpleOptions` entries
   verbatim. Prompt = `humanSummary` verbatim, plus one short sentence of
   your own reasoning (why you wanted to do this), plus a simple ask.
   Keep the whole prompt to 3 sentences max. Example:

   > I'd like to edit `packages/evm-module/contracts/S.sol`, but the
   > active task `sync` doesn't cover that file. I was trying to update
   > the staking integration the PR depends on. Want me to add it and
   > continue?

   Do NOT surface the verbose `options` list. Do NOT add or rewrite options.

4. **Act on the user's choice** by matching the `action.kind`:
   - `add_to_manifest` → edit `agent-scope/tasks/<task>.json`, append patterns
     to `allowed`, retry.
   - `switch_task` → `pnpm task set <task>`, retry.
   - `bootstrap` → print `action.instruction` verbatim, wait for the user.
     Remind them to `rm agent-scope/.bootstrap-token` when done.
   - `fix_manifest` → open the manifest, fix the error, validate.
   - `clear_task` → `pnpm task clear`.
   - `skip` → acknowledge, move on.
   - `cancel` → stop the turn, summarise.
   - `custom` → ask the user in plain chat "OK, what should I do instead?"
     Wait for their free-text reply, then carry out whatever they say.

5. **Never invent options.** The `custom_instruction` entry is always in
   `simpleOptions` — route through it when neither side fits.

### Phrasing rules (onboarding AND denials)

- Write like you're texting a coworker. One short question. One
  recommendation. One "something else" option.
- Never use ALL CAPS banners ("PROTECTED PATH", "STOP", "WARNING").
- Don't explain internal architecture in the prompt. The user doesn't
  need to know about hooks or manifests to answer.
- One sentence is enough to say why something is restricted.
- No emoji unless the user uses them first.

### CLI quick reference

```
pnpm task start                   # user pastes description in CLI; agent proposes scope in chat
pnpm task create <id> [flags]     # non-interactive manifest build — agent runs this on approve (allowlisted)
pnpm task list | show | set <id> | clear | check <path> | audit | resolve
pnpm scope:status | scope:validate | scope:test
```

Manifest format is in `agent-scope/README.md`. Never edit a protected path
(`.cursor/hooks/**`, `.claude/hooks/**`, `agent-scope/lib/**`, `AGENTS.md`,
`GEMINI.md`, `.cursorrules`, etc.) without user-granted bootstrap. Never
improvise around a denial.

The guard restricts **agent** actions only. Humans committing, pushing, or
editing through their own terminal are not restricted — there are no git
hooks and no CI enforcement layer. That distinction matters if a user edits
a protected file by hand: they can commit and push normally.

### Cross-agent coverage

This system supports multiple agents:

| Agent | Enforcement | Wired via |
|---|---|---|
| Cursor | hard hooks (block writes physically) | `.cursor/hooks/`, `.cursor/hooks.json`, `.cursor/rules/agent-scope.mdc` |
| Claude Code | hard hooks (block writes physically) | `.claude/hooks/`, `.claude/settings.json`, `CLAUDE.md` |
| Codex CLI | soft (no hook system available) | `AGENTS.md` — agent self-enforces |
| Gemini CLI | soft | `GEMINI.md` — agent self-enforces |
| Continue / Cline / older Cursor | soft | `.cursorrules` (legacy) |

Coworkers should run `pnpm task check-agent` after pulling to verify their
agent is wired up correctly. The same task manifests, same CLI, same
denial menus apply across all agents — only the enforcement layer differs.

When you're running under Claude Code, the first time the user opens this
repo Claude Code will prompt them to **trust** the project hooks. They
must approve — that's how the enforcement attaches.

