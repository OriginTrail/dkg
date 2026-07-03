# Active Work

## 2026-07-03 - Execute Node UI Auth Bootstrap Session Upgrade

Risk: High. This changes the browser authentication boundary for Node UI, protected API access, SSE authentication, dev-mode bootstrap, and real-node UI verification. Target branch: `codex/node-ui-auth-bootstrap-session`; target PR base: `main`.

Plan:
- [x] Re-read `agent-docs/node-ui-auth-bootstrap-team-prompt.md` and `agent-docs/node-ui-auth-bootstrap-upgrade-plan.md`.
- [x] Confirm worktree hygiene and create a focused `codex/` branch.
- [x] Inspect current server auth, UI static serving, CORS/session-adjacent helpers, frontend fetch helpers, SSE, Vite dev injection, and related tests.
- [x] Implement daemon dashboard-session primitives with HttpOnly cookie issuance, loopback bootstrap, bearer exchange, status, logout, and CSRF support.
- [x] Remove production and Vite `window.__DKG_TOKEN__` injection and make `/ui` a secret-free static shell with security headers.
- [x] Update frontend API helpers, SSE, current-agent/session UX, mock-mode behavior, and e2e helpers away from JS bearer tokens.
- [x] Add/adjust unit tests for auth routing, static serving, sessions, CSRF, no token injection, and frontend API behavior.
- [x] Update devnet smoke, Playwright auth/session coverage, and CI static bundle contract.
- [x] Run focused verification and document any deferred checks with rationale.
- [x] Update project memory and prepare PR-driver-ready summary/test plan.
- [ ] Push the branch, open a PR into `main`, and use the `github-pr-driver` workflow to drive CI/review convergence.

Review:
- Added server-side dashboard sessions in `packages/cli/src/daemon/dashboard-session.ts`, wired into the daemon lifecycle and `httpAuthGuard`.
- Removed production and Vite dev `window.__DKG_TOKEN__` HTML injection.
- Moved browser API calls to same-origin session credentials with CSRF for unsafe methods and no query bearer token for SSE.
- Added unit coverage, focused Playwright coverage, devnet smoke assertions, and a CI static bundle contract.
- Verification passed in WSL `/home/jurij/dkg`:
  - `pnpm --filter @origintrail-official/dkg exec vitest run --config vitest.unit.config.ts test/auth.test.ts test/dashboard-session.test.ts`
  - `pnpm --filter @origintrail-official/dkg-node-ui exec vitest run test/api-routes.test.ts test/ui-compat.test.ts test/ui-api-pure.test.ts test/pca-api.test.ts test/web3-clients.test.ts test/use-current-agent.test.ts test/openclaw-bridge.test.ts --no-file-parallelism`
  - `pnpm --filter @origintrail-official/dkg-node-ui exec tsc --noEmit`
  - `pnpm --filter @origintrail-official/dkg exec tsc --noEmit`
  - `pnpm --filter @origintrail-official/dkg-node-ui run build:ui`
  - `pnpm --filter @origintrail-official/dkg run build`
  - Static contract check against `packages/node-ui/dist-ui/index.html`.
  - `scripts/devnet-test-node-ui-smoke.sh` against a one-node WSL devnet: `PASS=11 FAIL=0`.
  - `PLAYWRIGHT_DEVNET_TIMEOUT_MS=300000 PW_HEADLESS=1 pnpm exec playwright test e2e/specs/auth-session.spec.ts`: `1 passed`.
