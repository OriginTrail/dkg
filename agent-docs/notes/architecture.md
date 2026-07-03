# Architecture Notes

## Node UI Dashboard Authentication

The Node UI should be a secret-free Vite SPA. Browser authentication is now modeled as a dashboard session instead of a JavaScript-readable daemon bearer token.

Core shape:
- CLI and automation keep using bearer-token auth.
- Browsers receive an opaque `HttpOnly`, `SameSite=Strict` dashboard cookie backed by a server-side session record.
- Loopback dashboard bootstrap is allowed only for loopback remote addresses and loopback Host values.
- Remote/browser token exchange is explicit through dashboard-session endpoints.
- Unsafe same-origin dashboard API methods require a CSRF token supplied by the session module.
- SSE uses same-origin cookie authentication at `/api/events` instead of `?token=`.
- `/ui` HTML is served without inline secrets and with security headers that are compatible with a strict static app.

Important integration points:
- `packages/cli/src/daemon/dashboard-session.ts` owns session records, cookies, CSRF, and dashboard session endpoints.
- `packages/cli/src/auth.ts` maps valid dashboard sessions into the existing request auth path while preserving explicit bearer auth precedence.
- `packages/node-ui/src/ui/api.ts` centralizes session-aware browser fetches.
- `packages/node-ui/src/ui/hooks/useNodeEvents.ts` opens SSE after ensuring a dashboard session, without a query bearer token.
