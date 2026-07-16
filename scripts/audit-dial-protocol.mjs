#!/usr/bin/env node
/**
 * Audit: ban raw `dialProtocol(` outside the network/protocol-router
 * boundary — RFC 07 §3.2.
 *
 * Why this exists
 * ---------------
 * Pre-RFC 07, every consumer that wanted to open a libp2p protocol
 * stream did so via `node.libp2p.dialProtocol(peerId, …)` directly. Each
 * consumer also had its own (or no) story for ensuring the libp2p
 * peerStore had a fresh route to the peer first — chat patched
 * peerStore from the agents context graph; sync didn't patch at all;
 * `/api/connect` did its own DHT walk. Over time the asymmetry produced
 * bugs where chat-to-peer-X succeeded while sync-to-peer-X simultaneously
 * failed, because only the chat path had primed the peerStore.
 *
 * RFC 07 (`dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md`)
 * collapses all of those ad-hoc resolution paths into a single
 * `PeerResolver` that every dial path consults. After PRs 1-3:
 *   - `Messenger.sendToPeer`     consults `PeerResolver` (PR-2)
 *   - `ProtocolRouter.send`      consults `PeerResolver` (PR-3)
 *   - `/api/connect` peerId form consults `PeerResolver` (PR-4 — this PR)
 *
 * The structural property RFC 07 §3.2 commits to is: every protocol
 * stream goes through one of those entry points, so adding a new
 * protocol can never silently bypass the resolver. This audit enforces
 * that property by failing the build if `dialProtocol(` appears in any
 * production source file outside the explicit allowlist below.
 *
 * What's allowed
 * --------------
 *   - `packages/core/src/network/libp2p-network.ts` — the LibP2PNetwork
 *     wrapper IS the dialProtocol gateway; it's what every other consumer
 *     reaches through.
 *   - `packages/core/src/protocol-router.ts` — the centralised request-
 *     response router; `send()` consults the resolver before dialing
 *     (RFC 07 PR-3). New protocols add handlers here, not new dial paths.
 *
 * What's blocked
 * --------------
 * Anything else. A new daemon route, a new sub-protocol, an adapter
 * package — they should all dial via `Messenger` (best for fire-and-
 * forget messaging), `ProtocolRouter.send` (best for request-response),
 * or — in the rare case both are unsuitable — through `LibP2PNetwork`
 * after consulting `PeerResolver` directly.
 *
 * Tests are excluded — they routinely use `dialProtocol` for fixtures
 * with hand-built libp2p instances that have no resolver.
 *
 * Bypass-resistance notes
 * -----------------------
 * Reuses `stripCommentsPreservingPositions` from `audit-create-random.mjs`
 * to blank comments and string contents before scanning, so:
 *   - `// dialProtocol(` in a comment doesn't trigger.
 *   - `"…dialProtocol(…"` in a string doesn't trigger.
 *   - Split invocations like `libp2p\n.dialProtocol(` are caught (the
 *     stripper preserves whitespace/newlines, so the regex sees them).
 *
 * Codex review feedback on PR #499 (round 1): the original regex only
 * caught `.dialProtocol(`, leaving `?.dialProtocol(` and bracket-access
 * forms like `["dialProtocol"](...)` as easy bypasses. Round 1 added
 * those.
 *
 * Codex review feedback on PR #499 (round 4, branarakic): even after
 * rounds 1-3 added optional-chaining, bracket access (with comments),
 * and optional-call forms, the audit still only fires when
 * `dialProtocol` is being CALLED. Aliasing patterns like
 *
 *     const rawDial = libp2p.dialProtocol.bind(libp2p);
 *     await rawDial(peerId, protocol);
 *
 *     const { dialProtocol } = libp2p;
 *     await dialProtocol(peerId, protocol);
 *
 * place the actual call site under a different identifier with no
 * `dialProtocol(` token in sight, so CI stays green while the new
 * path skips PeerResolver. Round 4 widens the detector to flag any
 * PROPERTY ACCESS or DESTRUCTURING of `dialProtocol` outside the
 * allowlist — concretely: any occurrence of the bare `dialProtocol`
 * IDENTIFIER token in stripped text, plus the bracket-string forms
 * (which the stripper blanks out at the identifier level).
 *
 * The detector recognises (pinned in the test file):
 *
 *   member call           foo.dialProtocol(...)
 *   optional-chain call   foo?.dialProtocol(...)
 *   optional-call         foo.dialProtocol?.(...)
 *   bracket call          foo['dialProtocol'](...)   foo["dialProtocol"](...)
 *                          foo[`dialProtocol`](...)
 *   bracket+optional      foo?.["dialProtocol"](...)  foo["dialProtocol"]?.(...)
 *   bracket+comment       foo[ <comment> "dialProtocol" <comment> ](...)
 *   aliased via .bind     const fn = foo.dialProtocol.bind(foo); fn(...)
 *   destructuring         const { dialProtocol } = foo
 *   bare reference        const fn = foo.dialProtocol; fn(...)
 *
 * Strings inside the brackets aren't blanked at the bracket level
 * because the `[…]` index expression IS code, but the stripper blanks
 * string CONTENTS, which would cause the inner `dialProtocol` to be
 * read as blanks after stripping. To detect bracket access we
 * therefore scan the ORIGINAL text for `["dialProtocol"]` (any quote
 * style, with optional inline comments) after verifying the bracket's
 * position isn't itself inside a comment/string in the stripped text.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripCommentsPreservingPositions } from './audit-create-random.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'dist-ui', '.git', '.turbo', 'coverage',
  'test', 'tests', '__tests__', 'cache', 'artifacts', 'typechain',
]);
const SOURCE_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const TEST_SUFFIXES = [
  '.test.ts', '.test.tsx', '.test.mts', '.test.cts', '.test.js', '.test.jsx', '.test.mjs', '.test.cjs',
  '.spec.ts', '.spec.tsx', '.spec.mts', '.spec.cts', '.spec.js', '.spec.jsx', '.spec.mjs', '.spec.cjs',
];

async function* walkSourceFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walkSourceFiles(full);
    } else if (e.isFile()) {
      if (TEST_SUFFIXES.some((s) => e.name.endsWith(s))) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot === -1 || !SOURCE_EXTS.has(e.name.slice(dot))) continue;
      yield full;
    }
  }
}

// Each entry pins the file path that's allowed to mention the
// `dialProtocol` identifier. `expectedHits` is the number of distinct
// occurrences (definitions + accesses) that must appear; a future PR
// adding a second call/alias to the same file will fail CI even
// though one is justified.
//
// Codex feedback PR #499 round 4: with the broader identifier-level
// detection, definition sites count too. The allowlist now pins:
//   - the `Network` interface declaration of the method (network.ts)
//   - the `LibP2PNetwork` impl: definition + the actual libp2p call
//   - `ProtocolRouter.send`: the resolver-consulting call
const ALLOWLIST = new Map([
  [
    'packages/core/src/network/network.ts',
    {
      expectedHits: 1,
      justification: 'Network interface declares dialProtocol() — the contract surface (RFC 07 §5)',
    },
  ],
  [
    'packages/core/src/network/libp2p-network.ts',
    {
      expectedHits: 2,
      justification: 'LibP2PNetwork is the dialProtocol gateway (RFC 07 §5.2): method definition + the underlying libp2p call inside it',
    },
  ],
  [
    'packages/core/src/protocol-router.ts',
    {
      expectedHits: 1,
      justification: 'ProtocolRouter.send consults PeerResolver before dialing (RFC 07 PR-3)',
    },
  ],
  [
    'packages/core/src/message-stream-pool.ts',
    {
      expectedHits: 2,
      justification: 'Long-lived per-peer stream pool for /dkg/10.0.2/message substrate (PR #560): structural PoolNode interface declaration + the single underlying libp2p dial that opens the pooled stream. The pool itself IS the substrate gateway — it owns one outbound stream per (localNode, peerId) for the lifetime of the connection and is consulted by Messenger.sendReliable, exactly mirroring the LibP2PNetwork gateway role for the request-response transport.',
    },
  ],
]);

// Codex feedback PR #499 round 4: detect ANY occurrence of the bare
// `dialProtocol` identifier in stripped (comments/strings blanked)
// text. Word boundaries protect against substrings of unrelated
// identifiers like `dialProtocolFor` or `predialProtocol`. This single
// pattern covers every CALL form (since the call site uses the
// identifier) AND every aliasing/destructuring form (since the alias
// site also uses the identifier).
//
// What it deliberately catches that the previous "must be followed by
// `(`" pattern missed:
//
//   const rawDial = foo.dialProtocol.bind(foo);   // .bind alias
//   const { dialProtocol } = foo;                  // destructuring
//   const fn = foo.dialProtocol;                   // bare reference
//
// Bracket-string access (`foo["dialProtocol"]`) still needs
// BRACKET_ACCESS_RE below — the stripper blanks the identifier inside
// the string literal, so this pattern can't see it there.
const IDENTIFIER_RE = /\bdialProtocol\b/g;

// Bracket access (any quote style, with optional inline comments).
// Examples handled (validated by audit-dial-protocol.test.mjs):
//   ["dialProtocol"](          ['dialProtocol'](          [`dialProtocol`](
//   ?.["dialProtocol"](        ?.['dialProtocol'](
//   [/*x*/"dialProtocol"](     ["dialProtocol"/*x*/](     [/*x*/"dialProtocol"/*y*/](
//   [ //x\n "dialProtocol" ](
//
// Scanned against ORIGINAL text because the stripper blanks string
// contents (so `"dialProtocol"` becomes `"            "` in stripped).
// Position-survival check below filters matches inside comments / strings
// at the file level (commented-out `[...]` blanks to spaces).
const COMMENT_OR_WS = '(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)*';
const BRACKET_ACCESS_RE = new RegExp(
  // Optional optional-chaining prefix: `?.`
  `(?:\\?\\.${COMMENT_OR_WS})?` +
    // The bracketed property access itself
    `\\[${COMMENT_OR_WS}` +
    `(?:"dialProtocol"|'dialProtocol'|\`dialProtocol\`)` +
    `${COMMENT_OR_WS}\\]` +
    // Codex feedback PR #499 round 3: also accept the optional CALL
    // form `["dialProtocol"]?.(...)`. The `?.` here is BETWEEN the
    // closing bracket and the open paren.
    `\\s*(?:\\?\\.\\s*)?\\(`,
  'g',
);

export function findHits(originalText) {
  const stripped = stripCommentsPreservingPositions(originalText);
  const hits = [];

  // Codex feedback PR #499 round 2: dedupe by source INDEX, not by line,
  // so two distinct invocations on the same line count as two hits and
  // can't slip past the allowlist's expectedHits gate.
  const seenIndexes = new Set();
  const recordHit = (index) => {
    if (seenIndexes.has(index)) return;
    seenIndexes.add(index);
    const upToMatch = originalText.slice(0, index);
    const line = upToMatch.split('\n').length;
    const lineStart = upToMatch.lastIndexOf('\n') + 1;
    const lineEnd = originalText.indexOf('\n', index);
    const snippet = originalText
      .slice(lineStart, lineEnd === -1 ? originalText.length : lineEnd)
      .trim();
    hits.push({ line, index, snippet });
  };

  for (const m of stripped.matchAll(IDENTIFIER_RE)) {
    recordHit(m.index);
  }

  // Bracket access scans original to see through string-content blanking.
  // To exclude commented-out / in-string occurrences, require the opening
  // `[` to survive in the stripped text (comments/strings blank to spaces,
  // but a real index expression's `[` is preserved as code).
  for (const m of originalText.matchAll(BRACKET_ACCESS_RE)) {
    const openBracketIdx = originalText.indexOf('[', m.index);
    if (openBracketIdx === -1) continue;
    if (stripped[openBracketIdx] !== '[') continue;
    recordHit(openBracketIdx);
  }

  hits.sort((a, b) => a.index - b.index);
  return hits;
}

async function main() {
  const packagesDir = join(REPO_ROOT, 'packages');
  const violations = [];
  const seenAllowlistPaths = new Set();

  const scanRoot = async (root) => {
    for await (const absPath of walkSourceFiles(root)) {
      const text = await readFile(absPath, 'utf8');
      const hits = findHits(text);
      if (hits.length === 0) continue;
      const relPath = relative(REPO_ROOT, absPath).split('\\').join('/');
      const exemption = ALLOWLIST.get(relPath);
      if (!exemption) {
        violations.push({
          path: relPath,
          kind: 'no-exemption',
          hits,
          expectedHits: 0,
        });
        continue;
      }
      seenAllowlistPaths.add(relPath);
      if (hits.length !== exemption.expectedHits) {
        violations.push({
          path: relPath,
          kind: 'hit-count-mismatch',
          hits,
          expectedHits: exemption.expectedHits,
          justification: exemption.justification,
        });
      }
    }
  };

  await scanRoot(packagesDir);

  const staleAllowlist = [];
  for (const [path] of ALLOWLIST) {
    if (!seenAllowlistPaths.has(path)) staleAllowlist.push(path);
  }

  if (violations.length === 0 && staleAllowlist.length === 0) {
    console.log('audit-dial-protocol: OK — every dialProtocol( call goes through the RFC 07 boundary.');
    if (ALLOWLIST.size > 0) {
      console.log(`Allowlisted (${ALLOWLIST.size}):`);
      for (const [p, { expectedHits, justification }] of ALLOWLIST) {
        console.log(`  - ${p} (${expectedHits} hit${expectedHits === 1 ? '' : 's'}): ${justification}`);
      }
    }
    return 0;
  }

  console.error('audit-dial-protocol: FAIL');
  for (const v of violations) {
    console.error(`\n  ${v.path}`);
    if (v.kind === 'no-exemption') {
      console.error(`    No allowlist entry. Found ${v.hits.length} dialProtocol( call${v.hits.length === 1 ? '' : 's'}:`);
    } else {
      console.error(`    Allowlisted for ${v.expectedHits} hit${v.expectedHits === 1 ? '' : 's'} (${v.justification}), but found ${v.hits.length}:`);
    }
    for (const h of v.hits) console.error(`    L${h.line}: ${h.snippet}`);
  }
  for (const p of staleAllowlist) {
    console.error(`\n  ${p}`);
    console.error('    Allowlist entry is stale (no dialProtocol( found in the file).');
    console.error('    Remove the entry from ALLOWLIST in scripts/audit-dial-protocol.mjs.');
  }
  console.error(`
Why this matters: RFC 07 §3.2 collapses every dial path into a single
in-process resolver so that chat / sync / /api/connect / future protocols
cannot disagree about how to reach a peer. A new dialProtocol( site
outside the allowlist re-introduces the asymmetric-failure class that
RFC 07 was built to eliminate.

If you need to open a protocol stream:
  - prefer Messenger.sendToPeer (fire-and-forget messaging)
  - prefer ProtocolRouter.send (request-response on a known protocol)
  - if neither fits, dial through LibP2PNetwork after consulting
    PeerResolver, and document the new entry point here in the
    allowlist with a one-line justification.

See dkgv10-spec/production_mainnet/07_IN_PROCESS_PEER_RESOLVER.md.
`);
  return 1;
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const exitCode = await main();
  process.exit(exitCode);
}
