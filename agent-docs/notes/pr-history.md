# PR History Notes

## 2026-07-03 - Node UI Auth Bootstrap Session Upgrade

Branch: `codex/node-ui-auth-bootstrap-session`

Summary:
- Added server-backed dashboard sessions and CSRF support for browser UI access.
- Removed bearer token injection from production and dev UI HTML.
- Converted UI API/SSE/e2e helpers away from JavaScript-readable daemon bearer tokens.
- Added backend/frontend unit tests, devnet smoke coverage, Playwright auth-session coverage, and CI static bundle checks.

Verification:
- CLI auth/session vitest passed.
- Node UI focused vitest suite passed.
- CLI and Node UI typechecks passed.
- Node UI build and CLI build passed.
- Static bundle contract passed.
- WSL one-node devnet UI smoke passed with `PASS=11 FAIL=0`.
- Four-node Playwright auth-session spec passed.

PR driver:
- Opened PR #1428 from `codex/node-ui-auth-bootstrap-session` to `main`.
- Initial CI: real-node Playwright devnet passed; `Kosava: node-ui` exposed test-environment assumptions around dashboard-session bootstrapping and `EventSource`.
- Follow-up fix keeps Vitest browser tests on a stable test dashboard session, adds the missing API mock export, and avoids constructing `EventSource` where the test environment does not provide it.
- Review round 1 fixes added remote dashboard unlock/exchange UX, extracted browser session transport state, made PCA RPC CSRF headers refresh per request, introduced typed server request auth context, and expanded dashboard-session regression tests.
- Review round 1 verification in isolated WSL worktree `/home/jurij/dkg-pr1428`: targeted Node UI vitest suite passed (221 tests, 38 skipped), CLI auth/session vitest passed (47 tests), node-ui TypeScript build passed, Vite UI build passed, and CLI build passed.
- Follow-up review sweep added stale session recovery on browser API 401s plus a focused dashboard-session client test, and tightened the auth-session Playwright spec to prove `/api/events` is actually opened without a query token. Verification: targeted Node UI vitest suite passed (222 tests, 38 skipped), node-ui TypeScript build passed, Vite UI build passed, and focused Playwright auth-session spec passed against the managed real-node devnet.
