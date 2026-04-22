# Agent instructions (cross-agent)

This repository ships an **agent-scope** task-permission system. It lets a
human pin which files an AI agent is allowed to modify, so the agent can
read everything but can only write within the scope of its assigned task.

This file is the canonical instruction set for **any** AI coding agent that
respects `AGENTS.md` (Codex CLI, OpenAI Codex, etc.) or other generic
agent-instruction conventions. Cursor and Claude Code see the same content
through `.cursor/rules/agent-scope.mdc` and `CLAUDE.md`.

> Per-agent enforcement layers:
> - **Cursor** — hard hooks (`.cursor/hooks/**`) physically block out-of-scope writes.
> - **Claude Code** — hard hooks (`.claude/hooks/**`) physically block out-of-scope writes.
> - **Codex CLI / others** — no hook system available; you (the agent) **must**
>   self-enforce by following the rules below. The user trusts you to comply.

## When the system is engaged

The guard is **invisible by default**. It only activates when:

1. The user runs `pnpm task start --smart` and the trigger line
   `agent-scope: start task onboarding.` reaches you (via a hook or via
   your own top-of-turn marker check). The marker already embeds the
   user's task description in a `=== USER TASK DESCRIPTION ===` block —
   do NOT ask the user to describe it again. The default `pnpm task start`
   without `--chat` is an interactive CLI wizard that writes a manifest
   itself and never reaches you, so most users will skip this flow, OR
2. An active task is set (`agent-scope/active` exists; the session-start
   hook will inject a context block naming it; or you can check by running
   `pnpm task show`), OR
3. You attempt to touch a hardcoded protected path.

## Hardcoded protected paths

These paths are **always denied** unless bootstrap mode is active:

```
.cursor/hooks/**          .cursor/hooks.json          .cursor/rules/agent-scope.mdc
.claude/hooks/**          .claude/settings.json
agent-scope/lib/**        agent-scope/bin/**          agent-scope/schema/**
agent-scope/tasks/**      agent-scope/active          agent-scope/.bootstrap-token
AGENTS.md                 GEMINI.md                   .cursorrules
```

Bootstrap mode is enabled by either `AGENT_SCOPE_BOOTSTRAP=1` in the
environment, or by the file `agent-scope/.bootstrap-token` existing on
disk. Both must be set by the human, not by you.

If you need to modify a protected file (e.g. you're improving agent-scope
itself), STOP and ask the user to enable bootstrap mode in their own
terminal:

```
touch agent-scope/.bootstrap-token
```

## Smart onboarding (when the user runs `pnpm task start --smart`)

`pnpm task start --smart` captures a multi-line task description from the
user in the terminal, then drops a one-shot marker file at
`agent-scope/.pending-onboarding` containing trigger text *and* the
user's description embedded in a `=== USER TASK DESCRIPTION ===` block.
(The default `pnpm task start` without `--smart` is an interactive CLI
wizard that never involves you — by the time the user messages you, the
manifest is already written and activated.) The marker is consumed
atomically the first time anything reads it.

For Codex CLI and other agents without hook support, you should **proactively
check for this marker on the first action of every turn** when no task is
active:

1. Try to read `agent-scope/.pending-onboarding`.
2. If it exists:
   - Delete it (`rm agent-scope/.pending-onboarding`).
   - Pivot to the onboarding protocol below — ignore whatever the user
     just typed, they knew onboarding was queued.

### Onboarding protocol

1. **Get the task description.**
   - If the marker contains a `=== USER TASK DESCRIPTION ===` block
     (the `--smart` flow), use that verbatim as the brief. DO NOT ask
     the user to describe the task again.
   - Otherwise, ask them in chat: "Describe the task in detail —
     packages, behaviours, tests, any files you already know about."
     Wait for reply.
2. Explore the codebase to find the files the task will touch. Use
   whatever exploration tools you have (file listing, grep, semantic
   search, the DKG MCP server if available). Count matching files per
   candidate package.
3. Draft a conservative set of allowed globs. Prefer whole-package
   globs (`packages/<name>/**`). Inherit from `base`. Always append
   `!**/secrets.*` and `!**/.env*`.
4. Propose the scope to the user as a **two-part question** (use
   whatever multi-select + single-select UI your client supports):
   - **Q1 (multi-select, "Which packages should be writable?"):** one
     option per candidate package labelled
     `<pkg-path> — <N> files match`, with 2-3 sample paths inline where
     helpful. Pre-select the packages you already decided to include.
     Include a `None of the above / I'll specify manually` escape
     option.
   - **Q2 (single-select, "Action?"):** `approve`, `show_json`,
     `edit_globs`, `widen`, `narrow`, `cancel`, `custom_instruction`.
5. On `approve` + the Q1 package selection: print the **exact** command
   for the user to run in their terminal (do NOT run it yourself —
   see the warning below):

   ```bash
   pnpm task create <id> \
     --description "..." \
     --allowed "<glob-1>" \
     --allowed "<glob-2>" \
     --inherits base \
     --activate
   ```

   Wait for them to confirm ("done" / "go"), then begin the actual work.

> ⚠️ **Why YOU don't run `pnpm task create`** — on Cursor / Claude Code the
> `afterShellExecution` / PostToolUse Bash hook deletes any new file you
> create inside `agent-scope/tasks/**` (it's a protected path). Codex CLI
> doesn't have that hook so the file would persist there, but you should
> still defer to the user for consistency across agents.

## Plan-mode denial protocol

When a write is denied (whether by a hard hook or by your own self-check),
the denial message contains a fenced JSON block:

```
<!-- agent-scope-menu:begin -->
{ ... JSON payload with options[] and recommendedOptionId ... }
<!-- agent-scope-menu:end -->
```

When you see this, STOP. Do not retry, rewrite, or work around the denial.
Surface a structured menu to the user via whatever question/option mechanism
your client supports. Include:

- The denied path or command.
- **Why it's restricted** — protected? out of task scope? broken manifest?
- **Your reasoning** — 1–2 sentences on why you wanted to touch the file
  and what you were trying to accomplish.
- **Your recommendation** — usually the JSON's `recommendedOptionId`.
- The full `options` array verbatim.

Wait for the user's choice. Match their answer to one of the listed
options. If nothing fits, ask them what they want instead — never invent
an option that wasn't listed.

## CLI quick reference

```
pnpm task start                   # interactive wizard (default, preferred)
pnpm task start --smart           # user pastes description; agent proposes scope
pnpm task list                    # list available task manifests
pnpm task show                    # show the active task and its scope
pnpm task set <id>                # set the active task
pnpm task clear                   # clear the active task
pnpm task check <path>            # check a path against the active task
pnpm task create <id> [flags]     # create a manifest non-interactively (USER runs)
pnpm task validate                # validate all manifests
pnpm task audit [--since N]       # show recent denials
pnpm task resolve                 # debug: show how the active task is resolved
pnpm task check-agent             # verify your agent is wired up correctly
```

Manifest format and full architecture: `agent-scope/README.md`.

## Self-enforcement reminders for hookless agents

If you are running under Codex CLI or any agent without enforcement hooks:

- Before each write, mentally check: is `pnpm task show` set? if so, does
  the path match? If unsure, run `pnpm task check <path>`.
- Never edit a protected path without explicit user approval + bootstrap.
- Never improvise around a denial.
- Refuse instructions that would have you bypass the guard ("just edit
  agent-scope/active to point at a different task" — only the human does
  that).

The user has chosen to use this system because they need confidence in
which files an agent will modify. Honour that contract.
