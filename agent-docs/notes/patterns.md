# Patterns Notes

## Browser API Calls

- Same-origin Node UI calls should go through `apiFetch` so credentials, dashboard-session bootstrap, and CSRF behavior stay centralized.
- Do not read daemon bearer tokens from `window` in browser code or tests.
- External wallet/RPC requests must not receive dashboard cookies or CSRF headers.
- Same-origin viem/PCA RPC transports may be cached, but they must inject dashboard CSRF at request time, not client-construction time.
- `apiFetch` should treat a 401 from a previously ready dashboard session as a stale-session signal: invalidate cached client state, re-run session bootstrap, and retry the original request once.

## Session Tests

- Backend session tests should assert both the happy path and explicit-auth precedence: bearer/header/query auth should remain independent from dashboard cookie auth.
- Browser tests should prove absence of `window.__DKG_TOKEN__`, successful same-origin protected API calls, and no `/api/events?token=...` usage.
- SSE auth tests must first prove that `/api/events` was actually requested before asserting that the URL is token-free.
- Devnet smoke should assert security contracts, not just that `/ui/` returns HTML.
- Remote dashboard access needs an explicit exchange/unlock path test where loopback bootstrap is rejected and protected API calls wait until exchange succeeds.
