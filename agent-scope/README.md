# agent-scope

Task-scoped write permissions for AI coding agents.

An agent can **read** the whole repo, but can only **write** files that are
listed in the active task's manifest. Attempts to write out-of-scope files
are blocked by a stack of agent hooks (per-agent — Cursor, Claude Code) and
must be explicitly approved by a human (by editing the manifest). Agents
without a hook system (Codex CLI, Gemini CLI, etc.) get the same rules
delivered as instruction files and self-enforce.

The guard restricts **agent** actions only. Humans committing, pushing, or
editing through their own terminal are never restricted — there are no git
hooks and no CI enforcement. If you edit a protected file by hand, you can
commit and push normally.

## Opt-in by default

agent-scope stays **invisible** until you engage it. With no active task and
no bootstrap, Cursor sessions behave as if the system didn't exist: the
session-start hook emits nothing, and the write/shell hooks only fire on the
hardcoded protected paths (the guard's own files). You can do ad-hoc work
without any task ceremony.

You engage the system in one of four ways:

1. **Interactive wizard (default)** — run `pnpm task start`. A terminal
   wizard asks you a few questions (description, which packages, extras),
   drafts a manifest, shows a preview, and activates it. No agent round-trip
   needed; works identically in every agent (Cursor, Claude Code, Codex,
   Gemini, …) and even with no agent at all.
2. **Smart onboarding (`pnpm task start --smart`)** — agent-guided flow.
   The CLI asks you for a multi-line task description, then drops a
   one-shot marker that embeds that description and copies the trigger
   text to your clipboard. The agent reads your description, explores
   the repo semantically, and proposes a scope via a rich two-part
   `AskQuestion` (multi-select packages + single-select action), and on
   `approve` runs `pnpm task create` itself (the `afterShellExecution`
   hook has a narrow allowlist for the canonical invocation — see
   "Architecture / approved-task-create allowlist" below). Use this when
   you want the agent to do the thinking.
3. **Explicit** — `pnpm task set <existing-id>` activates a manifest you
   already have.
4. **Direct** — `pnpm task create <id> --description "..." --allowed "..." --activate`
   builds + activates a manifest in one shot.

Clearing the active task (`pnpm task clear`) returns Cursor to its invisible
default.

## Architecture (defense in depth)

```
Agent  → Cursor sessionStart hook       → injects active-task context + consumes any pending onboarding marker
Agent  → Cursor preToolUse hook         → blocks out-of-scope Write/Edit/Delete
Agent  → Cursor beforeShellExecution    → blocks destructive shell cmds on denied paths
Agent  → Cursor afterShellExecution     → reverts out-of-scope shell writes, deletes untracked files in denied paths
Agent  → Cursor postToolUse hook        → injects pending onboarding trigger in already-open chats (additive, never denies)
System → hardcoded protected paths      → always blocks agent writes to agent-scope itself
Ops    → optional webhook sink          → forwards denials to DKG/Slack/etc.
```

All four agent-facing layers use the same library
(`agent-scope/lib/scope.mjs`) and the same manifests
(`agent-scope/tasks/*.json`). The pre-shell and after-shell layers back each
other up, so destructive commands that slip past the pre-check get reverted
or deleted afterwards.

### Approved-task-create allowlist

The after-shell hooks include a narrow, audited allowlist so the agent
can finish the smart-onboarding flow itself — i.e. on plan-mode
`approve`, the agent runs `pnpm task create <id> ...` and the hook lets
the resulting `agent-scope/tasks/<id>.json` plus `agent-scope/active`
persist.

The allowlist is:

- **Deterministic** — `agent-scope/lib/shell-parse.mjs` (`extractTaskCreateId`)
  tokenises the command and only matches canonical shapes:
  `pnpm task create <id>`, `pnpm run task create <id>`, or
  `node agent-scope/bin/task.mjs create <id>`. Impostors like
  `echo ... > agent-scope/tasks/evil.json`, `cp`, opaque evaluators
  (`node -e`, `python -c`), `npm`/`yarn`/`bun` wrappers, or ids with
  path-escape chars (`..`, `/`, `.`, spaces) return `null` and fall back
  to the default revert/delete behaviour.
- **Narrow** — even with a valid id, only two paths are waived:
  `agent-scope/tasks/<id>.json` (that specific id) and `agent-scope/active`.
  Other files written inside `agent-scope/tasks/**` in the same turn
  (including other task manifests) are still reverted/deleted.
- **Audited** — every approved write is logged to
  `agent-scope/logs/denials.jsonl` as an `afterShell.approved-create`
  event alongside the command and task id.
- **Validated** — the CLI itself rejects invalid ids and schema errors,
  so a syntactically-invalid manifest never reaches disk for the hook to
  allow.

This keeps the smart-onboarding UX one-step (agent runs the command
after you click Approve) without weakening protection: every non-matching
write to `agent-scope/tasks/**` and `agent-scope/active` is still
immediately reverted.

## Concepts

| Concept | File | Description |
|---|---|---|
| **Task manifest** | `agent-scope/tasks/<id>.json` | Declares what files a task is allowed to modify |
| **JSON schema** | `agent-scope/schema/task.schema.json` | Validates manifest structure |
| **Active task** | `agent-scope/active` | One-line file with the active task id (gitignored, per-developer) |
| **Env override** | `AGENT_SCOPE_TASK` | If set, takes precedence over the file |
| **Branch convention** | `task/<id>/*` or `agent-scope/<id>/*` | Branch name auto-detects the task if the env/file is unset |
| **Git config fallback** | `git config agent-scope.task <id>` | Lowest-priority fallback |
| **Denial log** | `agent-scope/logs/denials.jsonl` | Append-only audit trail (gitignored, rotates at 5MB) |
| **Bootstrap token** | `agent-scope/.bootstrap-token` | If present, disables hardcoded path protection (for maintainers editing agent-scope itself) |
| **Bootstrap env** | `AGENT_SCOPE_BOOTSTRAP=1` | Same as above but per-process |
| **Webhook sink** | `AGENT_SCOPE_WEBHOOK=<url>` | POSTs each denial to the URL (opt-in) |

## Supported agents

| Agent | Enforcement | Wired via |
|---|---|---|
| Cursor | **hard hooks** — physical block | `.cursor/hooks/`, `.cursor/hooks.json`, `.cursor/rules/agent-scope.mdc` |
| Claude Code | **hard hooks** — physical block | `.claude/hooks/`, `.claude/settings.json`, `CLAUDE.md` |
| Codex CLI (OpenAI) | soft — agent self-enforces | `AGENTS.md` |
| Gemini CLI | soft — agent self-enforces | `GEMINI.md` |
| Continue / Cline / older Cursor | soft (varies) | `.cursorrules` |

**Hard enforcement** means the hook process physically rejects out-of-scope
writes before they hit disk, regardless of what the agent decides to do.
**Soft enforcement** means the agent reads the rule files at session start
and is expected to comply — this is the best we can do for agents that
don't expose a hook API yet.

The same task manifests, the same CLI (`pnpm task ...`), the same denial
menu structure apply across all agents — only the enforcement layer
differs.

## One-time setup

There is no setup. Each agent loads its own config files (`.cursor/...`,
`.claude/...`, `AGENTS.md`, etc.) automatically when you open the repo.

After pulling the repo, run this once to verify your agent is wired up:

```bash
pnpm scope:check-agent       # or:  pnpm task check-agent
```

It prints a per-agent green/yellow/red status and tells you exactly what
(if anything) you need to do. Sample output:

```
Cursor                              [✓ active]
  enforcement: hard hooks
  ✓ .cursor/hooks.json present
  ✓ .cursor/hooks/scope-guard.mjs executable
  ...

Claude Code                         [✓ active]
  enforcement: hard hooks
  ✓ .claude/settings.json present
  ✓ .claude/hooks/scope-guard.mjs executable
  ...
  setup:
    First-run note: Claude Code will prompt you to TRUST the project hooks
    the first time you open this repo. Approve them — that's how
    enforcement attaches.

Codex CLI                           [~ soft]
  enforcement: soft (no hook system available)
  ✓ AGENTS.md present (Codex CLI reads this on every session)
  ! Hard blocks DO NOT apply here — Codex self-enforces.
```

Other sanity checks:

```bash
pnpm scope:test          # runs the scope library unit tests
pnpm scope:validate      # validates every manifest
```

### Per-agent setup notes

- **Cursor**: hooks load automatically from `.cursor/hooks.json` next time
  you open the repo. No prompt, no action needed.
- **Claude Code**: the first time you open this repo, Claude Code will
  prompt you to **trust the project hooks**. You must approve — that's how
  the enforcement attaches. After that it's automatic.
- **Codex CLI**: reads `AGENTS.md` automatically. No installation step.
  Caveat — Codex CLI has no hook API today, so blocking out-of-scope
  writes depends on the agent obeying the rules.
- **Gemini CLI**: reads `GEMINI.md` automatically. Same self-enforcement
  caveat as Codex.
- **Other agents** (Continue, Cline, Roo, older Cursor): pick up
  `.cursorrules`. Coverage varies — treat as best-effort.

## Quick start

```bash
# Interactive wizard (default) — asks a few questions, drafts + activates a manifest
pnpm task start

# Smart onboarding — paste a description in the CLI, agent proposes scope in chat
pnpm task start --smart

# Non-interactive manifest creation (flags)
pnpm task create my-task \
  --description "Refactor peer sync for workspace auth" \
  --allowed "packages/agent/src/**sync*" \
  --allowed "packages/agent/test/**sync*" \
  --inherits base \
  --activate

# List available tasks (marks the active one with *)
pnpm task list

# Set the active task
pnpm task set sync-refactor

# See which task is active and what it allows
pnpm task show

# Debug how the active task was resolved (env/file/branch/git-config)
pnpm task resolve

# Create a new task manifest interactively (prompts you)
pnpm task init my-task

# Check whether a specific path is in scope
pnpm task check packages/agent/src/sync-handler.ts
# → allow

# Recent denials (audit)
pnpm task audit

# Clear the active task (writes unrestricted again)
pnpm task clear
```

## Onboarding flow

There are two onboarding flows. The **interactive wizard** is the default
— fully deterministic, no agent involvement. The **smart flow**
(`--smart`) is an AI-driven alternative when you want the agent to
understand your task description semantically and propose a scope.

### Flow 1 — interactive wizard (default)

Run `pnpm task start`. The CLI walks you through a short questionnaire:

1. **Description** — one sentence describing the task. Used as
   `description` in the manifest and as the seed for the task id.
2. **Task id** — auto-kebab-cased from the description; press Enter to
   accept or type your own.
3. **Packages** — the wizard discovers workspace packages from
   `pnpm-workspace.yaml` (or `package.json` `workspaces`, or a `packages/*`
   fallback), presents them as a numbered list, and pre-selects the ones
   whose names overlap with keywords in your description. Type the numbers
   you want, or press Enter to accept the suggestion, or `none` to skip.
4. **Build-artefact exemptions** — y/n for the standard
   `**/dist/**`, `**/*.tsbuildinfo`, `pnpm-lock.yaml` set.
5. **Extra allowed globs** (optional) and **extra deny globs** (optional) —
   free-text, one per line, blank to finish. `!**/secrets.*` and
   `!**/.env*` are always denied automatically.
6. **Preview** — prints the drafted manifest JSON.
7. **Save / edit / cancel** — `s` saves & activates, `e` opens `$EDITOR`
   (or `$VISUAL`) on the file and re-validates on exit, `c` aborts without
   writing anything.

No chat round-trip, no agent needed, runs in under a second, works
identically in every agent. This is the recommended path.

If `stdin` is not a TTY (CI, piped input), `pnpm task start` errors out
with guidance to use `pnpm task create <id> --flags...` directly. Both
onboarding modes need interactive input.

### Flow 2 — smart onboarding (`pnpm task start --smart`)

The CLI prompts you for a task description (press Enter to submit —
multi-line pastes are captured in full via paste-detection), then drops
a one-shot marker at
`agent-scope/.pending-onboarding` (gitignored) that *already embeds* your
description inside a `=== USER TASK DESCRIPTION ===` block. The trigger
text is also copied to your clipboard.

Your NEXT message in any chat (new or existing) makes the agent pivot to
smart onboarding. Three parallel consumers compete for the marker so it
fires exactly once:

- **New chat (Cmd+L)** — the `sessionStart` hook injects the trigger.
- **Current chat, any message** — the agent's top-of-turn rule reads the
  marker on its first action; the `postToolUse` hook injects it as
  `additional_context` if the agent happens to call a tool first.
- **Manual paste** — the trigger is already in your clipboard.

The agent then follows a fixed protocol (defined in
`.cursor/rules/agent-scope.mdc`, `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`):

1. Reads your description from the marker (does NOT ask you again).
2. Explores the codebase (Grep / Glob / SemanticSearch / DKG) to find
   relevant files. Counts matching files per candidate package.
3. Proposes a scope via a **single short `AskQuestion`** — one question,
   two options. The prompt is one-line rephrase of the task + the scope
   as 3–5 bullet globs + "Sound good?" The options are:
   - `go` — "Yes, go with that"
   - `custom_instruction` — "Tell me what to change"
4. On `go`, the agent itself runs `pnpm task create <id> ...` via the
   shell tool. The `afterShellExecution` / PostToolUse-Bash hooks
   recognise the canonical task-create invocation and allow its two
   specific writes (`agent-scope/tasks/<id>.json` and `agent-scope/active`)
   to persist; every other write to those paths is still reverted. See
   the "approved-task-create allowlist" section for details.
5. On `custom_instruction`, the agent asks in plain chat what you'd like
   changed, updates the draft, and re-asks step 3.
6. Once approved, the agent starts the real work in the same turn.

From here, every attempted write to an out-of-scope file triggers a
plan-mode AskQuestion menu — see **Escalation** below.

The marker is one-shot: the first hook that consumes it also deletes it,
so the trigger fires exactly once per `pnpm task start --smart`.

## Manifest format

```json
{
  "id": "sync-refactor",
  "description": "Refactor peer sync protocol to add workspace sync auth",
  "owner": "bojan",
  "allowed": [
    "packages/agent/src/**sync*",
    "packages/agent/src/discovery.ts",
    "packages/core/src/**sync*",
    "packages/publisher/src/**sync*",
    "packages/*/test/**sync*",
    "!**/secrets.*"
  ],
  "exemptions": [
    "**/dist/**",
    "**/*.tsbuildinfo",
    "pnpm-lock.yaml"
  ]
}
```

- `allowed` — glob patterns that the agent may write to. Supports `*`, `**`, `?`.
- `exemptions` — patterns that are always allowed (build artifacts, lockfiles).
- `!pattern` — explicit deny, overrides everything else in both lists.
- **Default-deny**: anything not matched is blocked.

Run `pnpm scope:validate` to verify all manifests conform to
`agent-scope/schema/task.schema.json`.

## How enforcement works

Four agent-facing layers, all running inside Cursor:

1. **`sessionStart` hook** (`.cursor/hooks/session-start.mjs`) injects the
   active task's allowed patterns into the agent's context so it knows what
   it may modify from the first turn. **When no task is active and bootstrap
   is off, the hook emits nothing** — the agent's initial context is
   untouched. Only when a task is active (or bootstrap is on) does it surface
   a context block.
2. **`preToolUse` hook** (`.cursor/hooks/scope-guard.mjs`) runs before every
   `Write`, `StrReplace`, `Delete`, `EditNotebook`, `MultiEdit`, and `Edit`.
   It runs the protected-path check first, then the task-scope check.
3. **`beforeShellExecution` hook** (`.cursor/hooks/shell-precheck.mjs`)
   tokenises the pending shell command and blocks destructive verbs
   (`rm`, `mv`, `cp`, `chmod`, `chown`, `truncate`, `ln -sf`, `sed -i`,
   redirections `>` / `>>` / `tee`, `find -delete`, `xargs rm`) when their
   target is out-of-scope or hardcode-protected. Recurses into `bash -c`,
   `sh -c`, and opaque evaluators (`node -e`, `python -c`, `perl -e`) to
   catch bypass attempts that hide destructive operations inside string
   arguments. Parsing logic lives in `agent-scope/lib/shell-parse.mjs` and
   is fully unit-tested.
4. **`afterShellExecution` hook** (`.cursor/hooks/shell-diff-check.mjs`) is
   the backstop for anything the pre-check misses: it runs
   `git status --porcelain`, `git checkout --` reverts any tracked
   out-of-scope/protected modifications, and **deletes** untracked files in
   denied paths (so an agent cannot establish persistent state like a new
   hook file via a pre-shell bypass).
5. **`postToolUse` hook** (`.cursor/hooks/post-tool-use.mjs`) exists only to
   consume a pending onboarding marker (written by `pnpm task start`) in an
   already-open chat. It never denies anything — it just injects the
   onboarding trigger as `additional_context` after the next tool call, so
   the agent pivots to the Task onboarding protocol on its next turn.

If no active task is set (no env, no file, no matching branch, no git-config)
**and** bootstrap is off, layer 1 is silent and layers 2–4 only trigger on
the hardcoded protected paths. Everything else is a no-op — you can do
ad-hoc work without changing the workflow. Layer 5 only emits anything when
`agent-scope/.pending-onboarding` is present.

No layer restricts **humans**. You can `git commit`, `git push`, and edit
anything manually through your terminal or IDE without interacting with the
guard — it only sees what the agent does.

## Hardcoded protected paths

Some files define the enforcement system itself. If the agent were free to
edit them, the whole thing would be worthless. These paths are **always
denied** regardless of active task, unless bootstrap mode is active:

- `.cursor/hooks/**`, `.cursor/hooks.json`, `.cursor/rules/agent-scope.mdc`
- `.claude/hooks/**`, `.claude/settings.json`
- `agent-scope/lib/**`, `agent-scope/bin/**`, `agent-scope/schema/**`
- `agent-scope/tasks/**`, `agent-scope/active`,
  `agent-scope/.bootstrap-token`
- `AGENTS.md`, `GEMINI.md`, `.cursorrules`

(This list applies to **agent** writes only. A human editing any of these
files through their own terminal/IDE is not restricted.)

### Bootstrap mode

To legitimately improve `agent-scope` itself, a human enables bootstrap mode.
Two equivalent switches:

```bash
# Option A — file token (persists across sessions until deleted)
touch agent-scope/.bootstrap-token

# Option B — env var (just for the current Cursor process)
export AGENT_SCOPE_BOOTSTRAP=1
```

While bootstrap is active, the sessionStart hook prints a loud warning into
the agent context. When you're done, remove it:

```bash
rm agent-scope/.bootstrap-token
```

The bootstrap token is in `.gitignore`, so it cannot accidentally leak into
a commit even if you `git add .`. If you ever do `git add -f` it, remove it
before pushing.

## Manifest inheritance

Manifests can share common exemptions (e.g. `**/dist/**`, `pnpm-lock.yaml`)
via an `inherits` field. The `base` task ships as a pure-exemption parent:

```json
{ "id": "child", "inherits": ["base"], "allowed": ["src/**"] }
```

Inheritance merges parents first (deduplicating), then the child's own
`allowed`/`exemptions` are appended. `!pattern` denials in a child override
parent `allowed` patterns. Cycles are detected and rejected.

## Optional webhook sink

Forward denials to a DKG node / Slack / log aggregator by setting
`AGENT_SCOPE_WEBHOOK` to an http(s) URL. Each denial is POSTed as JSON
(fire-and-forget, 1.5s timeout). Activity is also written to
`agent-scope/logs/denials.jsonl` locally with automatic rotation at 5MB.

## Escalation — plan-mode denial menu

Every denial (preToolUse, beforeShellExecution, afterShellExecution) emits both
a short human summary **and** a machine-readable JSON menu embedded in the
hook's response. Agents following `.cursor/rules/agent-scope.mdc`,
`CLAUDE.md`, or `AGENTS.md` must parse the menu and surface it via their
client's plan-mode-style question mechanism (`AskQuestion` in Cursor) —
**one question, two options**.

The structured block is fenced by HTML comments so it's trivial to locate:

```
<!-- agent-scope-menu:begin -->
{
  "version": 1,
  "hook": "preToolUse",
  "reason": "out-of-scope",
  "humanSummary": "I'd like to edit `packages/evm-module/contracts/Staking.sol`, but the active task `sync-refactor` doesn't cover that file.",
  "deniedPath": "packages/evm-module/contracts/Staking.sol",
  "activeTask": "sync-refactor",
  "suggestedGlob": "packages/evm-module/contracts/**",
  "alternativeTasks": [ { "id": "staking", "description": "..." } ],
  "simpleOptions": [
    { "id": "add_glob",           "label": "Add this folder to the task and try again", "action": { "kind": "add_to_manifest", ... } },
    { "id": "custom_instruction", "label": "Something else — tell me what",            "action": { "kind": "custom" } }
  ],
  "options": [
    /* full verbose list — audit/back-compat only, NOT surfaced to users */
  ],
  "recommendedOptionId": "add_glob",
  "agentReasoning": null
}
<!-- agent-scope-menu:end -->
```

Possible `action.kind` values:

| kind | what the agent should do |
|---|---|
| `add_to_manifest` | Add `action.patterns` to `agent-scope/tasks/<action.task>.json` under `allowed`, then retry the original operation. |
| `switch_task` | Run `pnpm task set <action.task>`, then retry. |
| `bootstrap` | Print `action.instruction` to the user and wait for confirmation. Remind them to remove the token after. |
| `fix_manifest` | Open `agent-scope/tasks/<action.task>.json`, fix the error (`action.error`), re-run `pnpm task validate`. |
| `clear_task` | Run `pnpm task clear`. |
| `skip` | Acknowledge and move on. |
| `cancel` | Stop the turn; summarise for the user. |
| `custom` | Ask the user in plain chat what they want instead, then do it. |

Extra guidance in the block:

- `humanSummary` is the one-line natural-language framing of the situation.
  The agent is told to **quote this verbatim** in the AskQuestion prompt and
  add one short sentence of their own reasoning (why they wanted to do it).
  Keep the whole prompt to 3 sentences max.
- `simpleOptions` always has **exactly two entries**: the LLM-recommended
  action (short human label like "Add this folder to the task and try
  again", "Skip it", "Yes, unlock it so I can do this edit") and a
  free-text fallback `custom_instruction` → `"Something else — tell me
  what"`. Agents surface these two options and **never** surface the
  verbose `options` list.
- `options` is the verbose, audit-grade list (add_file, add_glob, switch
  tasks, skip, cancel, bootstrap, fix_manifest, clear_task, custom). It is
  preserved for back-compat, tests, and anyone inspecting the JSON
  directly — but not intended for end-user display.
- `recommendedOptionId` is the id of `simpleOptions[0]`. Chosen
  conservatively: `add_glob` for out-of-scope, `cancel` for protected,
  `fix_manifest` for manifest-load errors.
- `agentReasoning: null` is a placeholder the agent overwrites when
  quoting it in their prompt.

Heuristics (in `agent-scope/lib/denial.mjs`):

- `suggestedGlob` is derived from the denied path's parent directory
  (`dirname/**`).
- `alternativeTasks` lists up to 3 other manifests that already cover the
  denied path.
- Protected denials recommend `cancel` by default — the user must
  explicitly opt into `bootstrap` via the "something else" free-text
  fallback if they want to unlock the system.

Builders and tests live alongside the scope library:

```
agent-scope/lib/denial.mjs         # the builders
agent-scope/lib/denial.test.mjs    # 40 unit tests
```

No special tokens or APIs — the manifest is the source of truth; edit it to
grant permission. Changes to a manifest still go through normal review.

## Debug / audit

```bash
pnpm task resolve        # how was the active task resolved?
pnpm task audit          # recent denials
pnpm task validate       # check all manifests
tail -f agent-scope/logs/denials.jsonl
```
