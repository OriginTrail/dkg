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
