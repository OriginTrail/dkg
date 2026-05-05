/**
 * Pure parser + serializer for the DKG auth token file.
 *
 * File format (extension over the legacy single-line format — backward
 * compat is non-negotiable, see ADR-0003):
 *
 *   <token>                                              # legacy → scopes = '*'
 *   <token><TAB><scope1,scope2,...>                      # scoped
 *   <token><TAB><scopes><TAB><name>                      # scoped + name
 *   <token><TAB><scopes><TAB><name><TAB><createdAt>      # full record
 *   # comment                                            # preserved on round-trip
 *                                                        # blank line preserved
 *
 * Deep-module discipline: no I/O, no global state. The I/O lives in
 * `auth.ts` (which calls `parseTokenFile` on the on-disk content).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A scope is a free-form string (e.g. `kafka:endpoint:write`). The literal
 * string `'*'` is the wildcard "full access" marker — used for legacy
 * scope-less tokens AND for explicitly-root tokens minted via the API.
 */
export type Scope = string;

/**
 * Where a token came from. In-memory only — the parser never reads it
 * (everything from disk is implicitly `'file'`) and the serializer
 * never writes it. Drives:
 *   - `requireRoot` (Codex bug 2): only `'file'` and `'config'` tokens
 *     can pass — `'agent'` tokens have always been auto-issued by
 *     `/api/agent/register` and treating them as root admin would be
 *     a privilege-escalation path.
 *   - `dkg auth list-tokens` rendering (Codex bug 4): operator sees
 *     at a glance which rows are revocable via DELETE (only `'file'`)
 *     vs. which require config edits / agent restarts.
 */
export type TokenSource = 'file' | 'config' | 'agent';

/**
 * Records survive a round-trip: parsing then serializing the same input
 * yields the same bytes for any input that already carries full records
 * (token + scopes + name + createdAt). For inputs missing optional fields
 * (legacy scope-less, or scope-only-no-name lines), the serializer emits
 * the canonical field count for what's present — see `serializeTokenStore`.
 */
export interface TokenRecord {
  /** First 8 chars of the full token. Used for list/revoke API surfaces. */
  prefix: string;
  /** The on-disk secret. NEVER returned in list/get responses. */
  fullToken: string;
  /** Either `'*'` (full access) or a list of explicit scope strings. */
  scopes: Scope[] | '*';
  /** Optional human-readable label. */
  name?: string;
  /** ISO-8601 timestamp the token was minted. */
  createdAt?: string;
  /**
   * Where the token came from. In-memory only; never serialized. The
   * parser stamps every line as `'file'`; consumer code (lifecycle,
   * agent register, mint route) is responsible for tagging non-file
   * sources before inserting into the store.
   */
  source: TokenSource;
}

/**
 * Map keyed by token prefix. We key by prefix (not by full token) because
 * the prefix is the public identifier (used by list/revoke) — full-token
 * lookup goes through `lookupTokenRecord`.
 *
 * Insertion order is preserved (JS Maps do this), and the serializer
 * relies on it for round-trip determinism.
 */
export type TokenStore = Map<string, TokenRecord>;

/**
 * Comments + blank lines that lived in the source file. Stored alongside
 * the records (with their position relative to the records) so the
 * serializer can re-emit them in the right place. Without this, a
 * round-trip would silently strip `# comment` headers from operator-edited
 * files.
 *
 * Position semantics: `index` is the record-position the line appears
 * BEFORE. An `index` equal to `records.length` means "after the last
 * record" (trailing comments / blank lines).
 */
export interface PreservedLine {
  /** Verbatim line content (no trailing newline). */
  text: string;
  /** Insertion position relative to records. */
  index: number;
}

/**
 * Output of `parseTokenFile`. The serializer takes the same shape so a
 * full round-trip stays byte-identical for well-formed inputs.
 */
export interface ParsedTokenFile {
  store: TokenStore;
  preserved: PreservedLine[];
}

/**
 * The first 8 chars of a token are the public identifier. Kept short so
 * it fits in a CLI table, kept consistent across the codebase by going
 * through this single helper.
 *
 * If a token is shorter than 8 chars (only happens in malformed test
 * fixtures — production tokens are 43 chars of base64url) we use the
 * whole thing.
 */
export function tokenPrefix(token: string): string {
  return token.length >= 8 ? token.slice(0, 8) : token;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface ParseTokenFileOptions {
  /**
   * Optional sink for warnings (malformed lines, duplicate prefixes). We
   * route through a callback rather than `console.warn` so the daemon can
   * forward them to its `Logger`. Defaults to silent.
   */
  onWarning?: (msg: string) => void;
}

/**
 * Parse a token-file blob. Skips malformed lines with a warning instead of
 * throwing — a single bad line should never lock an operator out.
 *
 * Lines starting with `#` are comments. Blank lines are preserved. Both
 * are recorded as `PreservedLine` entries so the serializer can re-emit
 * them in their original positions.
 */
export function parseTokenFile(
  raw: string,
  opts: ParseTokenFileOptions = {},
): ParsedTokenFile {
  const onWarning = opts.onWarning ?? (() => { /* silent */ });

  const store: TokenStore = new Map();
  const preserved: PreservedLine[] = [];

  // Splitting on `\n` and stripping a trailing `\r` keeps round-trip
  // semantics correct on both LF and CRLF inputs without forcing one or
  // the other on the serializer (we always emit LF — see
  // `serializeTokenStore`'s contract). A trailing `\n` produces a final
  // empty entry which we skip below.
  const lines = raw.split('\n');

  // Drop a single trailing empty entry produced by a file that ends in
  // `\n` — this lets the round-trip be byte-identical instead of growing
  // an extra blank line on every save.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    // Comments + blank lines: preserve verbatim, skip parsing.
    if (line.length === 0 || line.startsWith('#')) {
      preserved.push({ text: line, index: store.size });
      continue;
    }

    // We tolerate leading/trailing whitespace around the WHOLE line for
    // legacy compatibility (the old parser called `.trim()`), but we do
    // NOT trim per-field — TAB-separated fields can legitimately contain
    // leading spaces in the `name` field. Inner whitespace is the
    // operator's business.
    //
    // The fields:
    //   [0] token (required)
    //   [1] scopes (comma-separated; empty → `'*'`? NO — empty is a
    //       parse error; '*' must be explicit. Legacy lines have NO field
    //       1 at all, which IS the '*' case.)
    //   [2] name (optional, free-form)
    //   [3] createdAt (optional, ISO-8601)
    //
    // Lines with more than 4 fields are malformed. Lines with empty
    // token field are malformed.
    const fields = line.split('\t');
    const token = fields[0]?.trim() ?? '';
    if (token.length === 0) {
      onWarning(`token-store: skipping malformed line (empty token): ${truncateForLog(line)}`);
      continue;
    }

    let scopes: Scope[] | '*';
    if (fields.length === 1) {
      // Legacy: token-only line. Full access.
      scopes = '*';
    } else {
      const scopesField = fields[1] ?? '';
      const parsed = parseScopesField(scopesField);
      if (parsed === null) {
        onWarning(
          `token-store: skipping malformed line (bad scopes field "${truncateForLog(scopesField)}"): token=${tokenPrefix(token)}`,
        );
        continue;
      }
      scopes = parsed;
    }

    if (fields.length > 4) {
      onWarning(
        `token-store: skipping malformed line (too many tab-separated fields, expected ≤4 got ${fields.length}): token=${tokenPrefix(token)}`,
      );
      continue;
    }

    const name = fields[2] && fields[2].length > 0 ? fields[2] : undefined;
    const createdAt = fields[3] && fields[3].length > 0 ? fields[3] : undefined;

    const prefix = tokenPrefix(token);

    if (store.has(prefix)) {
      onWarning(
        `token-store: duplicate token prefix ${prefix} — keeping first occurrence`,
      );
      continue;
    }

    // Every line read off disk is by definition `source: 'file'`. The
    // `'config'` and `'agent'` sources are stamped by lifecycle wiring,
    // never appear in the file format, and never round-trip to disk.
    const record: TokenRecord = { prefix, fullToken: token, scopes, source: 'file' };
    if (name !== undefined) record.name = name;
    if (createdAt !== undefined) record.createdAt = createdAt;
    store.set(prefix, record);
  }

  return { store, preserved };
}

/**
 * Parse a single scopes field. Returns `'*'` when the literal `*` is
 * supplied, an array of trimmed non-empty scopes for a comma list, or
 * `null` to signal a malformed field (caller skips the whole line).
 *
 * An empty string is treated as malformed because legacy "no scopes →
 * full access" comes from a missing field 1, not an empty one.
 */
function parseScopesField(raw: string): Scope[] | '*' | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value === '*') return '*';
  const parts = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  // Reject obviously-malformed scope strings. We allow `:` (the slice 06
  // verb-namespace separator), letters/digits/dash/dot/underscore. Reject
  // whitespace and tabs and the wildcard mixed with other entries.
  for (const p of parts) {
    if (!/^[A-Za-z0-9_.:\-*]+$/.test(p)) return null;
  }
  // A list containing `*` is meaningless — `*` must stand alone. Reject.
  if (parts.includes('*')) return null;
  return parts;
}

function truncateForLog(s: string): string {
  return s.length > 80 ? s.slice(0, 77) + '...' : s;
}

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a token store back to file content. Round-trip-safe for inputs
 * produced by `parseTokenFile`: parsing the output of `serializeTokenStore`
 * applied to a `ParsedTokenFile` yields the same `ParsedTokenFile`.
 *
 * Field-count discipline:
 *   - legacy `'*'` records with no name/createdAt → token-only line
 *   - explicit-`'*'` records with name → token + `*` + name
 *   - scoped records → token + scopes + (name?) + (createdAt?), trailing
 *     empty fields suppressed
 *
 * Comments and blank lines from `preserved` are re-emitted at their
 * recorded positions.
 */
export function serializeTokenStore(parsed: ParsedTokenFile): string {
  const { store, preserved } = parsed;
  const records = [...store.values()];

  const lines: string[] = [];

  // Pre-bucket preserved lines by the record-index they precede. Multiple
  // entries with the same `index` keep their original order.
  const buckets = new Map<number, PreservedLine[]>();
  for (const p of preserved) {
    const bucket = buckets.get(p.index) ?? [];
    bucket.push(p);
    buckets.set(p.index, bucket);
  }

  for (let i = 0; i < records.length; i++) {
    const before = buckets.get(i);
    if (before) {
      for (const p of before) lines.push(p.text);
    }
    lines.push(formatRecord(records[i]!));
  }

  // Trailing preserved lines (after the last record).
  const trailing = buckets.get(records.length);
  if (trailing) {
    for (const p of trailing) lines.push(p.text);
  }

  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

function formatRecord(r: TokenRecord): string {
  const fields: string[] = [r.fullToken];

  // Legacy single-field shape: only used when scopes is '*' AND there's no
  // name/createdAt. Any record with a name or timestamp must emit at
  // least the scopes field so the parser knows the trailing fields are
  // metadata, not part of a malformed token.
  if (r.scopes === '*' && r.name === undefined && r.createdAt === undefined) {
    return fields[0]!;
  }

  fields.push(r.scopes === '*' ? '*' : r.scopes.join(','));

  if (r.name !== undefined || r.createdAt !== undefined) {
    fields.push(r.name ?? '');
  }
  if (r.createdAt !== undefined) {
    fields.push(r.createdAt);
  }

  return fields.join('\t');
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Return the record for a given full token, or undefined. Done as a
 * sequential scan because the map is keyed by prefix and prefix collisions
 * are possible (extremely rare for 32-byte base64url tokens — birthday
 * collision on 8 chars of base64url is ~1 in 2^48 — but possible). On a
 * collision we still want to find the record whose `fullToken` matches.
 *
 * For the common case (no collision) the prefix lookup hits in O(1) and
 * we compare one full token.
 */
export function lookupTokenRecord(
  fullToken: string | undefined,
  store: TokenStore,
): TokenRecord | undefined {
  if (!fullToken) return undefined;
  const prefix = tokenPrefix(fullToken);
  const candidate = store.get(prefix);
  if (candidate && candidate.fullToken === fullToken) return candidate;
  // Collision fallback: linear scan.
  for (const r of store.values()) {
    if (r.fullToken === fullToken) return r;
  }
  return undefined;
}

/**
 * Add a record to BOTH the structured store AND the legacy
 * `validTokens` Set in lockstep (Codex bug 3). Anything that issues a
 * new token at runtime — startup loader, mint route, runtime agent
 * register at `/api/agent/register` — MUST go through this single
 * helper so the two structures never drift.
 *
 * Without this, the historical `validTokens.add(...)` pattern at the
 * agent-register site bypassed the structured store, so freshly
 * registered agents passed `httpAuthGuard` (Set-based) but got 403
 * from every scope-checked route until daemon restart.
 *
 * Returns the record so callers can chain.
 */
export function addTokenToStore(
  store: TokenStore,
  validTokens: Set<string>,
  record: TokenRecord,
): TokenRecord {
  setTokenRecord(store, record);
  validTokens.add(record.fullToken);
  return record;
}

/**
 * Remove a record from BOTH structures in lockstep — the dual of
 * `addTokenToStore`. Returns true when an entry was removed.
 */
export function removeTokenFromStore(
  store: TokenStore,
  validTokens: Set<string>,
  prefix: string,
): boolean {
  const target = store.get(prefix);
  if (!target) return false;
  deleteTokenRecord(store, prefix);
  validTokens.delete(target.fullToken);
  return true;
}

/**
 * Add a record. Returns the same store (mutated). If a prefix collision
 * occurs (vanishingly unlikely with random 43-char tokens, but possible
 * in tests / for short fixtures), the new record replaces the old one
 * and the caller is responsible for any rollback. Mint flows MUST
 * detect collisions before calling this — the API gives them the
 * `lookupTokenRecord` helper for that.
 */
export function setTokenRecord(store: TokenStore, record: TokenRecord): TokenStore {
  store.set(record.prefix, record);
  return store;
}

/** Remove a record by prefix. Returns true when an entry was deleted. */
export function deleteTokenRecord(store: TokenStore, prefix: string): boolean {
  return store.delete(prefix);
}

/**
 * Sanitized public view of a record — drops `fullToken`. List/get APIs
 * MUST go through this to avoid leaking secrets in subsequent responses.
 *
 * `source` IS included (Codex bug 4): operators need to know which rows
 * are revocable via `DELETE /api/auth/tokens/<prefix>` (only `'file'`
 * — `'config'` requires editing dkg.config.yaml; `'agent'` is auto-
 * issued by `/api/agent/register` and lives in the running daemon's
 * memory only).
 */
export interface PublicTokenRecord {
  prefix: string;
  scopes: Scope[] | '*';
  name?: string;
  createdAt?: string;
  source: TokenSource;
}

export function toPublicRecord(r: TokenRecord): PublicTokenRecord {
  const out: PublicTokenRecord = { prefix: r.prefix, scopes: r.scopes, source: r.source };
  if (r.name !== undefined) out.name = r.name;
  if (r.createdAt !== undefined) out.createdAt = r.createdAt;
  return out;
}
