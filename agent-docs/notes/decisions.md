# Decisions Notes

## 2026-07-03 - Node UI Browser Auth

Decision: replace browser-visible daemon bearer token bootstrap with server-side dashboard sessions.

Rationale:
- `/ui` is intentionally public enough to serve the SPA shell, so it must not distribute reusable API credentials.
- `HttpOnly` session cookies reduce credential exfiltration risk from XSS and static asset exposure.
- CSRF checks are required once browser cookies authenticate unsafe methods.
- Bearer tokens remain the right model for CLI, automation, and machine clients.

Consequence:
- Frontend code must route same-origin API calls through session-aware helpers.
- Tests and devnet smoke must stop scraping `window.__DKG_TOKEN__`.
- Public/reverse-proxy dashboard deployments still need explicit operator auth and trusted origin policy before being treated as safe.

## 2026-07-03 - Dashboard Sessions As Typed Auth Context

Decision: represent dashboard-cookie authentication as a typed request auth context instead of rewriting `req.headers.authorization`.

Rationale:
- Browser dashboard sessions, Authorization bearer requests, and SSE query-token auth are different sources and should stay distinguishable after the guard accepts them.
- Downstream routes still need a trusted token/agent identity, but that identity should come from the guard result rather than reparsing mutable headers.

Consequence:
- `httpAuthGuard` owns auth-source classification and CSRF validation state.
- `handleRequest` derives `requestToken`/`requestAgentAddress` from `getRequestAuthContext(req)`.
- Future route policies can distinguish dashboard sessions from machine bearer clients without relying on ad-hoc request mutation.
