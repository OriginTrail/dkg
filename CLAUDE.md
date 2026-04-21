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

1. The user pastes a line starting with `agent-scope: start task onboarding`
   (output of `pnpm task start`), OR
2. An active task is set (session-start hook injects a context block naming
   it), OR
3. You try to touch one of the hardcoded protected paths that defend the
   guard itself — those are always blocked unless the user has enabled
   bootstrap mode.

### Task onboarding protocol (triggered by `pnpm task start` / "start a scoped task")

1. Acknowledge in plain chat and ask the user to describe the task in detail
   (which packages, which behaviours, which tests, any specific files).
2. Wait for the description.
3. Explore the codebase with DKG queries + `Glob` + `Grep` + `Read` to find
   the files the task will touch.
4. Draft a set of globs that covers those files plus their tests. Err
   slightly broad; inherit `base`; always append `!**/secrets.*`,
   `!**/.env*`.
5. Propose the scope via `AskQuestion`. The prompt must include a one-line
   rephrase of the task, the list of proposed globs, and your recommendation.
   Options: `approve`, `show_globs`, `edit`, `cancel`, `custom_instruction`.
6. On `approve`, print a fenced bash block with the **exact** command for the
   user to run in their terminal (not you — the `afterShellExecution` hook
   would delete a new manifest file you created yourself):

   ```bash
   pnpm task create <id> \
     --description "..." \
     --allowed "<glob-1>" \
     --allowed "<glob-2>" \
     --inherits base \
     --activate
   ```

   Wait for them to confirm ("done"/"go"), then start the actual work.
7. On `show_globs`, print the manifest JSON, then re-ask with the same options.
8. On `edit`, ask which globs to change, loop back to step 5.
9. On `cancel`, acknowledge and keep working without a task.
10. On `custom_instruction`, ask in plain chat what they want instead.

### Plan-mode denial protocol (runs for every agent-scope denial)

When any of these happen, stop and surface a menu. Do NOT retry, rewrite, or
work around the denial — the defense-in-depth layers revert tracked changes
and delete untracked files in denied paths anyway:

- `preToolUse` returned `{ permission: "deny" }` with `OUT OF TASK SCOPE` or
  `PROTECTED PATH` in the message.
- `beforeShellExecution` returned `{ permission: "deny" }` with
  `Destructive shell command blocked` in the message.
- `afterShellExecution` returned `additional_context` starting with
  `agent-scope: shell command modified`.

Every such message contains a fenced JSON block:

```
<!-- agent-scope-menu:begin -->
{ ... JSON payload ... }
<!-- agent-scope-menu:end -->
```

The JSON has `options[]` and `recommendedOptionId`. It also has a placeholder
`agentReasoning: null` — you fill this in by including your reasoning in the
AskQuestion prompt (see below).

**Protocol:**

1. **Stop.** Do not retry via another tool or command form.
2. **Extract the JSON.** Parse between the fences.
3. **Call `AskQuestion`** with ONE question whose prompt **must include**:
   - The denied path / command.
   - **Your reasoning in 1–2 sentences** — why you wanted to touch this file,
     what you were trying to accomplish. This is the "here's what I was
     thinking" that the user needs to make an informed decision.
   - **Your recommendation** — lead with the JSON's `recommendedOptionId`
     unless you have a concrete reason to override it.
   - The full `options` array, verbatim — use each entry's `id`/`label`.
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
   - `custom` → ask the user in plain chat "what should I do instead?", do
     what they say.
5. **Never invent options.** If nothing fits and no `custom` is listed (it
   always is), pick `cancel`.

### CLI quick reference

```
pnpm task start                   # begin guided onboarding (prints chat trigger)
pnpm task create <id> [flags]     # non-interactive manifest build — USER runs this
pnpm task list | show | set <id> | clear | check <path> | audit | resolve
pnpm scope:status | scope:validate | scope:test
```

Manifest format is in `agent-scope/README.md`. Never edit a protected path
(`.cursor/hooks/**`, `agent-scope/lib/**`, etc.) without user-granted
bootstrap. Never improvise around a denial.

The guard restricts **agent** actions only. Humans committing, pushing, or
editing through their own terminal are not restricted — there are no git
hooks and no CI enforcement layer. That distinction matters if a user edits
a protected file by hand: they can commit and push normally.

