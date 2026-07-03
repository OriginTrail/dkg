# Lessons Notes

## 2026-07-03 - Playwright Request Wait Timing

Mistake pattern: started `page.waitForRequest('/api/events')` before the app shell navigation had finished.

Root cause: the wait's timeout ran concurrently with `page.goto()`, so slow devnet page load could fail the request wait before the app had a chance to open SSE.

Preventive rule: attach passive request listeners before navigation, but only start active request waits after the page reaches the state that should trigger the request unless missing the earliest request would make the test invalid.

## 2026-07-03 - React Session Store Test Cleanup

Mistake pattern: reset a module-level session store while the component under test was still subscribed.

Root cause: the test cleanup restored default session state before unmounting `DashboardSessionGate`, which triggered a React state update outside `act()`.

Preventive rule: unmount React subscribers before resetting shared test stores, or wrap the reset itself in `act()` when the subscription intentionally remains mounted.

## 2026-07-03 - PR Driver Worktrees

Mistake pattern: continued PR follow-up work in a shared WSL checkout after the active branch had changed.

Root cause: the PR-driver loop assumed the checkout still belonged to the PR branch instead of re-validating the branch immediately before edits.

Preventive rule: for active PR sweeps, use an isolated worktree for the PR branch and verify `git status --branch` before editing, staging, or running long verification.

## 2026-07-03 - WSL Command Hygiene

Mistake pattern: complex PowerShell-to-Bash command strings introduced quoting and CRLF artifacts while driving WSL.

Root cause: nested quoting across PowerShell, WSL, Bash, and command-line test tools is brittle, especially when piping here-strings or embedding shell variables.

Preventive rule: prefer simple WSL commands with explicit paths, avoid CRLF-sensitive piped scripts for long test invocations, and inspect the exact failure before treating a tool exit as a product failure.

## 2026-07-03 - Playwright Devnet Topology

Mistake pattern: tried to shortcut the focused auth e2e spec with a two-node devnet.

Root cause: Playwright global setup seeds VM content for all specs and therefore still needs the standard four-node quorum topology.

Preventive rule: use the repository default four-node Playwright devnet unless the global setup is explicitly bypassed or changed for the target spec.
