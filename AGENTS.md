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

1. The user runs `pnpm task start` and the trigger line
   `agent-scope: start task onboarding.` reaches you (via a hook or via
   your own top-of-turn marker check). The marker already embeds the
   user's task description in a `=== USER TASK DESCRIPTION ===` block —
   do NOT ask the user to describe it again, OR
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

## Task onboarding (when the user runs `pnpm task start`)

`pnpm task start` captures a task description from the user in the
terminal, then drops a one-shot marker file at
`agent-scope/.pending-onboarding` containing trigger text *and* the
user's description embedded in a `=== USER TASK DESCRIPTION ===` block.
The marker is consumed atomically the first time anything reads it.

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
     (the `pnpm task start` flow), use that verbatim as the brief. DO
     NOT ask the user to describe the task again.
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
4. Propose the scope to the user as **one short question with two
   options**. Write it like you're asking a coworker, not filling out a
   form. 3 sentences max: one-line rephrase of the task, the scope you'd
   propose (3–5 numbered globs), then "Sound good?" Example:

   > Refactor peer sync to use the new workspace auth. I'd scope it to:
   > 1) `packages/agent/**`
   > 2) `packages/core/**`
   > 3) inherit `base` (standard build-artefact exemptions)
   >
   > Sound good?

   Options (only these two, IDs exactly):
   - `go` — `"Yes, go with that"`
   - `custom_instruction` — `"Type what you want instead"`

5. On `go`: **run the command yourself** via your shell tool, then
   continue with the actual work in the same turn. The command's
   `--allowed` flags must match your proposed scope verbatim:

   ```bash
   pnpm task create <id> \
     --description "..." \
     --allowed "<glob-1>" \
     --allowed "<glob-2>" \
     --inherits base \
     --activate
   ```

   If the command fails, surface the error and re-ask (still one short
   question, two options) — do not retry blindly.

   On `custom_instruction`: ask the user in plain chat what they want
   changed, apply it to the draft, then re-ask step 4.

> 🛈 **On Cursor / Claude Code the `afterShellExecution` / PostToolUse Bash
> hook has a narrow allowlist** so this one invocation can persist the
> new `agent-scope/tasks/<id>.json` and `agent-scope/active` files. The
> hook recognises only the canonical shapes:
>
> - `pnpm task create <id> ...`
> - `pnpm run task create <id> ...`
> - `node agent-scope/bin/task.mjs create <id> ...`
>
> Any other write to `agent-scope/tasks/**` or `agent-scope/active` (e.g.
> `echo ... > agent-scope/tasks/evil.json`, `cp`, Write/Edit tool, opaque
> evaluators) is still reverted/deleted as before. Agents without hooks
> (Codex CLI, Gemini CLI, etc.) have no hook gate to worry about; just
> follow the protocol.

## Plan-mode denial protocol

When a write is denied (whether by a hard hook or by your own self-check),
the denial message starts with an `agent-scope:` summary line and contains
a fenced JSON block:

```
<!-- agent-scope-menu:begin -->
{ humanSummary, simpleOptions, recommendedOptionId, options, ... }
<!-- agent-scope-menu:end -->
```

When you see this, STOP. Do not retry, rewrite, or work around the denial.
Ask the user **one short question with the two `simpleOptions` entries
verbatim** — never surface the verbose `options` list:

- Prompt = `humanSummary` verbatim + one short sentence of your own
  reasoning (why you wanted to do this) + a simple ask. Keep the whole
  prompt to 3 sentences max. Example:

  > I'd like to edit `packages/evm-module/contracts/S.sol`, but the
  > active task `sync` doesn't cover that file. I was trying to update
  > the staking integration the PR depends on. Want me to add it and
  > continue?

- Options = `simpleOptions` verbatim (exactly two entries: the
  recommendation and "Type what you want instead").

Match the user's answer to the chosen `action.kind` and carry it out. If
they pick `custom_instruction`, ask them in plain chat what they'd like
instead and follow their reply. Never invent options.

### Phrasing rules (onboarding AND denials)

- Write like you're texting a coworker. One short question, one
  recommendation, one "something else" option.
- No ALL CAPS banners ("PROTECTED PATH", "STOP", "WARNING").
- Don't explain internal architecture in the prompt. The user doesn't
  need to know about hooks or manifests to answer.
- One sentence is enough to say why something is restricted.
- No emoji unless the user uses them first.

## CLI quick reference

```
pnpm task start                   # user pastes description; agent proposes scope in chat
pnpm task list                    # list available task manifests
pnpm task show                    # show the active task and its scope
pnpm task set <id>                # set the active task
pnpm task clear                   # clear the active task
pnpm task check <path>            # check a path against the active task
pnpm task create <id> [flags]     # create a manifest non-interactively (agent runs on approve, allowlisted by hooks)
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
