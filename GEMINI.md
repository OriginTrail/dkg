# Agent instructions for Gemini CLI

This repository uses an `agent-scope` task-permission system that limits
which files an AI agent may modify. The full instructions live in
[`AGENTS.md`](./AGENTS.md). Read that file first.

Key points for Gemini:

- You may **read** any file in the repo.
- You may **write** only files matching the active task's allowed globs
  (when one is set). Run `pnpm task show` to see the active task; run
  `pnpm task check <path>` to test a specific path.
- A set of system files is **always protected** regardless of task. See
  the "Hardcoded protected paths" section in `AGENTS.md`.
- Most users run `pnpm task start` without flags — that's an interactive
  CLI wizard that writes a manifest directly. You don't see anything
  special; by the time the user messages you, the active task is set.
- If the user runs `pnpm task start --smart`, a one-shot marker file at
  `agent-scope/.pending-onboarding` is dropped. The marker already
  embeds the user's task description in a `=== USER TASK DESCRIPTION ===`
  block — do NOT ask them to describe it again. On your first action of
  any new turn (when no task is active), check whether that marker exists;
  if it does, delete it and run the smart-onboarding protocol from
  `AGENTS.md`.
- Gemini CLI does **not** have hard hook enforcement. You self-enforce by
  following the rules. The user trusts you to comply.
- Never invent menu options when surfacing a denial — pass through the
  full `options` array verbatim and add your own reasoning + recommendation.

For the full protocol, denial-handling flow, and CLI reference, see
[`AGENTS.md`](./AGENTS.md).
