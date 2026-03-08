# PR #38 Follow-up TODOs

Remaining Codex Review feedback from PR #38 — tracked across follow-up PRs.

## 1. daemon.ts — Scoped loopback token injection for `/apps/*`  ✅

**File:** `packages/cli/src/daemon.ts`

Removed `req.socket.remoteAddress`-based localhost detection. Token injection
now prefers a verified `Authorization: Bearer` header. When no auth header
is present and the request is for `/apps/*`, a first-stored-token fallback
is used **only** when the server is bound to loopback (`127.0.0.1` / `::1`).
TCP binding guarantees only local connections reach loopback sockets.

## 2. Apps.tsx — Separate-origin isolation + nonce handshake  ✅

**File:** `packages/node-ui/src/ui/pages/Apps.tsx`

Refactored to follow the `AppHostPage` isolation model: when a separate-origin
static server is available (`staticUrl`), the iframe loads from that origin
and `allow-same-origin` is omitted from the sandbox, enforcing real cross-origin
isolation. Falls back to same-origin path with `allow-same-origin` only when
the static server is unavailable. Token delivery uses a per-load nonce
handshake via `validateTokenRequest()` (exported pure function, tested).

## 3. coordinator.ts — Verify force-resolved ordering is correct  ✅

**File:** `packages/origin-trail-game/src/dkg/coordinator.ts`

Already fixed in PR #38: the leader-only `force-resolved` fast-path executes
before local tally validation, preventing follower state divergence. Test
`leader force-resolved proposal bypasses tally validation` confirms.

## Future improvements

- **Per-app separate origins:** Currently all apps share one static-server
  port. Moving to per-app origins (or subdomains) would provide inter-app
  isolation beyond iframe sandboxing.
