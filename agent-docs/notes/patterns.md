# Patterns Notes

## Browser API Calls

- Same-origin Node UI calls should go through `apiFetch` so credentials, dashboard-session bootstrap, and CSRF behavior stay centralized.
- Do not read daemon bearer tokens from `window` in browser code or tests.
- External wallet/RPC requests must not receive dashboard cookies or CSRF headers.

## Session Tests

- Backend session tests should assert both the happy path and explicit-auth precedence: bearer/header/query auth should remain independent from dashboard cookie auth.
- Browser tests should prove absence of `window.__DKG_TOKEN__`, successful same-origin protected API calls, and no `/api/events?token=...` usage.
- Devnet smoke should assert security contracts, not just that `/ui/` returns HTML.
