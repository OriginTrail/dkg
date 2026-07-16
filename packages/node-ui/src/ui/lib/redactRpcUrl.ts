/**
 * Mask the trailing path-token segment of a third-party RPC URL so
 * screenshots / screen-shares don't leak the tenant secret (BUG-012).
 *
 * QuickNode, Infura, Alchemy, etc. all use a per-tenant token at the
 * end of the path:
 *   https://greatest-greatest-sound.base-sepolia.quiknode.pro/664a23a04122d3fa485778b9141bc92e17293c73/
 *   https://mainnet.infura.io/v3/abcdef0123456789...
 *   https://eth-mainnet.alchemyapi.io/v2/abcdef0123456789...
 *
 * Anyone with that URL can call the endpoint, billed to the tenant.
 * We keep the host intact (useful for diagnostics — operators need to
 * know which provider they're talking to) and redact every "secret-
 * shaped" path segment. A segment is treated as a secret if it's
 * length-≥16 and consists of hex/base64-ish characters.
 */
// Use ASCII bullet `*` for masking — `URL` percent-encodes any
// non-ASCII character we put back into pathname/search, which would
// turn a friendly `••••••••` into `%E2%80%A2…` and defeat the point
// of the redaction.
const MASK = '************';

// "Secret-shaped" run heuristic: length-≥16 alphanumeric (+ `_` / `-`)
// span, matching the per-segment predicate used on the parsed path
// branch. Covers hex (Infura/Alchemy), base62 (QuickNode), and JWT-ish
// path tokens uniformly so the malformed-URL fallback below does not
// silently leak non-hex secrets (codex #752 review).
const SECRET_RUN_RE = /[A-Za-z0-9_-]{16,}/g;

export function redactRpcUrl(rpc: string | null | undefined): string {
  if (!rpc) return '';
  let parsed: URL;
  try {
    parsed = new URL(rpc);
  } catch {
    // Not a valid URL (typically a scheme-less paste like
    // `mainnet.infura.io/v3/<token>`). Reuse the same secret-run
    // heuristic the parsed-path branch uses so we still mask base62
    // / base64 tokens, not only hex ones.
    return rpc.replace(SECRET_RUN_RE, MASK);
  }
  // Some operators paste RPC URLs with HTTP basic auth baked in
  // (`https://user:pass@host/path` or `https://tenantonly@host/path`).
  // Strip BOTH userinfo fields whenever EITHER is present — the
  // username alone identifies the tenant on many providers (e.g.
  // `tenantId@rpc.example.com`) and is just as much of a screen-share
  // leak as the password.
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  const segments = parsed.pathname.split('/').map((seg) => {
    if (seg.length < 16) return seg;
    if (/^[A-Za-z0-9_-]+$/.test(seg)) return MASK;
    return seg;
  });
  parsed.pathname = segments.join('/');
  if (parsed.search) {
    const params = new URLSearchParams(parsed.search);
    for (const key of Array.from(params.keys())) {
      if (/key|token|secret|auth/i.test(key)) params.set(key, MASK);
    }
    parsed.search = params.toString();
  }
  return parsed.toString();
}
