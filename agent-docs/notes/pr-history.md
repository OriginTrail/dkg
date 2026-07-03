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
