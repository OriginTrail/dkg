#!/usr/bin/env node
/**
 * Audit: ban undisciplined `Wallet.createRandom()` in production code.
 *
 * Why this exists
 * ---------------
 * On 2026-05-01 every testnet node bootstrapped on the V10 isolated Hub got
 * its on-chain admin key from `ethers.Wallet.createRandom()` inside
 * `EVMChainAdapter.ensureProfile()`. The wallet existed only as a local
 * variable for the duration of one `createProfile` tx, then was garbage
 * collected. The private key was never logged, never persisted, never
 * surfaced to the operator. Result: nine identities (1–9) had their admin
 * keys destroyed at registration time, breaking PR #366's auto-add of
 * operational ACK signers (which is `onlyAdmin`) and forcing a partial
 * network rebuild.
 *
 * PR #366 itself fixed `ensureProfile` (added a hard `if (!this.adminSigner)
 * throw` guard so the random+discard path can't run silently). This audit
 * script keeps that fix from regressing AND catches the same anti-pattern
 * elsewhere — the publisher constructor had an analogous bug producing
 * unverifiable signatures attributed to throw-away addresses, fixed in the
 * same PR as this script.
 *
 * What it does
 * ------------
 * Walks every `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` /
 * `.cjs` source file under root `scripts/**` and every non-test package
 * source under `packages/**`, then fails if it finds `Wallet.createRandom(`
 * (including obvious `Wallet` aliases and equivalent optional/bracket access
 * forms) outside the explicitly allowlisted call sites below. Each allowlist
 * entry pins ONE expected hit with a one-line
 * justification — adding a second `createRandom()` to the same file does
 * NOT inherit the existing exemption and must be reviewed on its own.
 *
 * What's allowed
 * --------------
 * Random key generation IS legitimate when the resulting key is either
 *   (a) returned to a caller that persists it (e.g. `loadOpWallets`
 *       writes to `wallets.json`, custodial agent registration writes to
 *       the keystore), OR
 *   (b) used in a hardhat deploy script that prints the key for the
 *       operator to capture.
 * It is NEVER legitimate to use a random key for actual signing inside the
 * daemon and let it go out of scope without persistence.
 *
 * Tests are excluded — they routinely use random keys for fixtures and
 * never run against real chains.
 *
 * Bypass-resistance notes
 * -----------------------
 *   - Whole-file scan after a small lexer blanks comments AND string /
 *     template-literal contents (preserving byte length and newlines so
 *     line numbers in error output stay accurate). This means:
 *       * Split invocations like `Wallet\n.createRandom()` or
 *         `Wallet /* … *​/.createRandom()` cannot bypass via formatting.
 *       * Import/local aliases such as `import { Wallet as EthersWallet }`
 *         and `const W = Wallet; W.createRandom()` are scanned too.
 *       * `//` or `/​*` inside a string literal does NOT trigger comment
 *         mode (so `const url = "http://"; Wallet.createRandom();` is
 *         correctly flagged — previously the `//` inside the string
 *         silently blanked the real call after it).
 *       * A string literal containing the literal text `Wallet.createRandom(`
 *         is blanked along with the rest of the string, so the regex
 *         can't false-positive on it either.
 *   - Per-hit allowlist (not per-file): an extra `createRandom()` call
 *     added to an already-exempt file fails CI and must be justified.
 *   - Template-literal substitutions (`${ … }`) ARE scanned as code, so a
 *     `\`${Wallet.createRandom()}\`` would be flagged. Nested strings
 *     and templates inside substitutions are properly re-lexed via the
 *     state stack — so braces inside a string inside a substitution
 *     (e.g. `\`${"}" + Wallet.createRandom()}\``) cannot prematurely
 *     close the substitution and hide a real call after it.
 */

import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// Each entry pins ONE expected hit. `expectedHits` is the number of
// `Wallet.createRandom(` invocations that must appear in this file; a
// future PR adding a second call will fail CI even though one is justified.
const ALLOWLIST = new Map([
  [
    'packages/agent/src/op-wallets.ts',
    {
      expectedHits: 1,
      justification: 'first-run admin+op wallet generation, persisted to wallets.json (chmod 0600)',
    },
  ],
  [
    'packages/agent/src/agent-keystore.ts',
    {
      expectedHits: 1,
      justification: 'custodial chat-agent keypair, returned to caller and persisted in keystore',
    },
  ],
  [
    'packages/evm-module/utils/helpers.ts',
    {
      expectedHits: 1,
      justification: 'hardhat deploy-script utility, key returned to operator (`generateEvmWallet`)',
    },
  ],
]);

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Blank out comments AND string / template-literal contents from `text`,
 * replacing them with spaces (newlines preserved) so the returned string
 * has the same byte length as the input and match indexes still resolve
 * to the original line numbers.
 *
 * Stack-based state machine (small, intentionally not a full TS parser).
 * Each context on the stack is one of:
 *
 *   normal              → code we want to scan
 *   line-comment        // … \n          (only above normal/substitution)
 *   block-comment       /​* … *​/          (only above normal/substitution)
 *   sq-string           ' … '            (\-escapes consumed)
 *   dq-string           " … "            (\-escapes consumed)
 *   tpl-string          ` … `            (\-escapes; ${ pushes a substitution)
 *   tpl-substitution    { braceDepth }   ends when braceDepth → 0 on a `}`
 *   regex-literal       / … /flags       (\-escapes + character classes)
 *
 * Why a stack? We need string contexts to be re-entered RECURSIVELY when
 * we're inside a template substitution, so braces inside such strings
 * can't prematurely close the substitution. A flat `state` + `braceDepth`
 * (the previous attempt) misses this case. Concretely:
 *
 *   `${"}" + Wallet.createRandom()}`
 *
 *   Without the stack, the `}` inside `"}"` decremented the substitution's
 *   braceDepth to 0 and popped us back to template-string mode, blanking
 *   the rest including the real `Wallet.createRandom()`. With the stack,
 *   the `"` pushes dq-string on top of tpl-substitution, the `}` is just
 *   string content (blanked, brace counter untouched), the closing `"`
 *   pops back to tpl-substitution which still has braceDepth=1, and the
 *   real `Wallet.createRandom()` is detected.
 *
 * Bypass-history regression cases that this stripper now correctly
 * blocks:
 *   - `// or /* inside a string literal` (PR #371 codex round 1)
 *   - `} inside a string inside a ${ ... } substitution` (round 2)
 *
 * Strings are blanked rather than passed through verbatim so that a
 * literal `"Wallet.createRandom("` inside a string can't false-positive
 * the regex either.
 *
 * Regex literals are handled conservatively when `/` appears in an
 * expression-start position (`=`, `(`, `[`, `{`, `,`, `;`, etc.). This is
 * still not a full JS parser, but it closes the dangerous false-negative
 * class where `//` or `/*` inside a regex body was previously treated as
 * a real comment and blanked a following `Wallet.createRandom()` call.
 */
export function stripCommentsPreservingPositions(text) {
  const len = text.length;
  let out = '';
  let i = 0;

  // Stack of contexts. Top of the stack is the active state.
  const stack = [{ kind: 'normal' }];
  const top = () => stack[stack.length - 1];
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  const previousSignificantToken = () => {
    for (let j = out.length - 1; j >= 0; j -= 1) {
      if (/\s/.test(out[j])) continue;
      if (/[A-Za-z_$]/.test(out[j])) {
        let start = j;
        while (start > 0 && /[\w$]/.test(out[start - 1])) start -= 1;
        return { kind: 'word', value: out.slice(start, j + 1) };
      }
      return { kind: 'char', value: out[j] };
    }
    return { kind: 'start', value: '' };
  };
  const canStartRegexLiteral = () => {
    const prev = previousSignificantToken();
    if (prev.kind === 'start') return true;
    if (prev.kind === 'char') return '([{=,:;!&|?+-*~^<>%'.includes(prev.value);
    return new Set([
      'return', 'throw', 'case', 'delete', 'void', 'typeof', 'yield',
      'await', 'new', 'else', 'do', 'in', 'of', 'instanceof',
    ]).has(prev.value);
  };

  while (i < len) {
    const cur = top();
    const c = text[i];
    const next = i + 1 < len ? text[i + 1] : '';

    if (cur.kind === 'normal' || cur.kind === 'tpl-substitution') {
      // tpl-substitution behaves exactly like normal code, EXCEPT that
      // top-level `{` / `}` adjust the substitution's brace counter and
      // the closing `}` pops back to the enclosing tpl-string.
      if (cur.kind === 'tpl-substitution') {
        if (c === '{') {
          cur.braceDepth += 1;
          out += c; i += 1;
          continue;
        }
        if (c === '}') {
          cur.braceDepth -= 1;
          if (cur.braceDepth === 0) {
            stack.pop();
            out += ' '; i += 1;
            continue;
          }
          out += c; i += 1;
          continue;
        }
      }
      if (c === '/' && next === '/') {
        out += '  '; i += 2;
        stack.push({ kind: 'line-comment' });
      } else if (c === '/' && next === '*') {
        out += '  '; i += 2;
        stack.push({ kind: 'block-comment' });
      } else if (c === '/' && canStartRegexLiteral()) {
        out += ' '; i += 1;
        stack.push({ kind: 'regex-literal', inClass: false });
      } else if (c === '"' || c === "'") {
        out += ' '; i += 1;
        stack.push({ kind: c === '"' ? 'dq-string' : 'sq-string' });
      } else if (c === '`') {
        out += ' '; i += 1;
        stack.push({ kind: 'tpl-string' });
      } else {
        out += c; i += 1;
      }
      continue;
    }

    if (cur.kind === 'line-comment') {
      if (c === '\n') {
        out += '\n'; i += 1;
        stack.pop();
      } else {
        out += ' '; i += 1;
      }
      continue;
    }

    if (cur.kind === 'block-comment') {
      if (c === '*' && next === '/') {
        out += '  '; i += 2;
        stack.pop();
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (cur.kind === 'regex-literal') {
      if (c === '\n') {
        out += '\n'; i += 1;
        stack.pop();
      } else if (c === '\\' && i + 1 < len) {
        out += blank(c) + blank(text[i + 1]);
        i += 2;
      } else if (c === '[') {
        cur.inClass = true;
        out += ' '; i += 1;
      } else if (c === ']' && cur.inClass) {
        cur.inClass = false;
        out += ' '; i += 1;
      } else if (c === '/' && !cur.inClass) {
        out += ' '; i += 1;
        while (i < len && /[A-Za-z]/.test(text[i])) {
          out += ' '; i += 1;
        }
        stack.pop();
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (cur.kind === 'sq-string' || cur.kind === 'dq-string') {
      const quote = cur.kind === 'sq-string' ? "'" : '"';
      if (c === '\\' && i + 1 < len) {
        out += blank(c) + blank(text[i + 1]);
        i += 2;
      } else if (c === quote) {
        out += ' '; i += 1;
        stack.pop();
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }

    if (cur.kind === 'tpl-string') {
      if (c === '\\' && i + 1 < len) {
        out += blank(c) + blank(text[i + 1]);
        i += 2;
      } else if (c === '`') {
        out += ' '; i += 1;
        stack.pop();
      } else if (c === '$' && next === '{') {
        out += '  '; i += 2;
        stack.push({ kind: 'tpl-substitution', braceDepth: 1 });
      } else {
        out += blank(c); i += 1;
      }
      continue;
    }
  }
  return out;
}

export function findHits(originalText) {
  const stripped = stripCommentsPreservingPositions(originalText);
  const walletAliases = collectWalletAliases(stripped);
  const hits = [];
  const seen = new Set();

  for (const alias of walletAliases) {
    const pattern = new RegExp(String.raw`\b${escapeRegExp(alias)}\b`, 'g');
    for (const m of stripped.matchAll(pattern)) {
      if (!matchesCreateRandomCall(originalText, stripped, m.index + alias.length)) continue;
      if (seen.has(m.index)) continue;
      seen.add(m.index);
      hits.push(hitFromIndex(originalText, stripped, m.index, alias));
    }
  }

  hits.sort((a, b) => a.index - b.index);
  return hits.map(({ index: _index, ...hit }) => hit);
}

function skipWhitespace(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

function skipToQuotedProperty(originalText, stripped, index) {
  let i = index;
  while (i < originalText.length) {
    if (originalText[i] === '"' || originalText[i] === "'" || originalText[i] === '`') return i;
    if (/\s/.test(originalText[i]) || /\s/.test(stripped[i] ?? '')) {
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

function readQuotedProperty(originalText, index) {
  const quote = originalText[index];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let value = '';
  let i = index + 1;
  while (i < originalText.length) {
    const c = originalText[i];
    if (c === '\\' && i + 1 < originalText.length) {
      value += originalText[i + 1];
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && originalText[i + 1] === '{') return null;
    if (c === quote) return { value, end: i + 1 };
    value += c;
    i += 1;
  }
  return null;
}

function matchesCreateRandomCall(originalText, stripped, indexAfterAlias) {
  let i = skipWhitespace(stripped, indexAfterAlias);

  if (stripped.startsWith('?.[', i)) {
    i += 3;
    const property = readQuotedProperty(originalText, skipToQuotedProperty(originalText, stripped, i));
    if (!property || property.value !== 'createRandom') return false;
    i = skipWhitespace(stripped, property.end);
    if (stripped[i] !== ']') return false;
    i = skipWhitespace(stripped, i + 1);
    if (stripped.startsWith('?.', i)) i = skipWhitespace(stripped, i + 2);
    return stripped[i] === '(';
  }

  if (stripped[i] === '[') {
    i += 1;
    const property = readQuotedProperty(originalText, skipToQuotedProperty(originalText, stripped, i));
    if (!property || property.value !== 'createRandom') return false;
    i = skipWhitespace(stripped, property.end);
    if (stripped[i] !== ']') return false;
    i = skipWhitespace(stripped, i + 1);
    if (stripped.startsWith('?.', i)) i = skipWhitespace(stripped, i + 2);
    return stripped[i] === '(';
  }

  if (stripped.startsWith('?.', i)) {
    i += 2;
  } else if (stripped[i] === '.') {
    i += 1;
  } else {
    return false;
  }

  i = skipWhitespace(stripped, i);
  if (!stripped.startsWith('createRandom', i)) return false;
  const afterName = i + 'createRandom'.length;
  if (/[\w$]/.test(stripped[afterName] ?? '')) return false;
  i = skipWhitespace(stripped, afterName);
  if (stripped.startsWith('?.', i)) i = skipWhitespace(stripped, i + 2);
  return stripped[i] === '(';
}

function hitFromIndex(originalText, stripped, index, identifier) {
  const upToMatch = stripped.slice(0, index);
  const line = upToMatch.split('\n').length;
  const lineStart = upToMatch.lastIndexOf('\n') + 1;
  const lineEnd = stripped.indexOf('\n', index);
  const snippet = originalText
    .slice(lineStart, lineEnd === -1 ? originalText.length : lineEnd)
    .trim();
  return { index, line, snippet, identifier };
}

function collectWalletAliases(stripped) {
  const aliases = new Set(['Wallet']);
  const namespaceAliases = new Set(['ethers']);
  const importPattern = new RegExp(String.raw`\bimport\s*\{([^}]*)\}\s*from\b`, 'g');

  // Namespace imports, including aliases: import * as E from ...
  // As with named imports below, the module specifier string has been
  // blanked by the lexer, so this intentionally treats namespace imports
  // conservatively rather than allowing `ethers` aliases to bypass the gate.
  const namespaceImportPattern = new RegExp(String.raw`\bimport\s+\*\s+as\s+(${IDENT})\s+from\b`, 'g');
  for (const m of stripped.matchAll(namespaceImportPattern)) {
    namespaceAliases.add(m[1]);
  }

  // Named namespace imports, including aliases: import { ethers as E } from ...
  // The source string is blanked, so treat the binding shape conservatively.
  for (const m of stripped.matchAll(importPattern)) {
    for (const rawSpecifier of m[1].split(',')) {
      const specifier = rawSpecifier.trim();
      const aliasMatch = specifier.match(new RegExp(String.raw`^ethers\s+as\s+(${IDENT})$`));
      if (aliasMatch) namespaceAliases.add(aliasMatch[1]);
      if (specifier === 'ethers') namespaceAliases.add('ethers');
    }
  }

  // CommonJS namespace aliases: const E = require('ethers')
  // String contents are blanked, so any require namespace alias is treated as
  // potentially ethers. This may false-positive, but avoids a CI gate bypass in
  // JS/CJS files.
  const requireNamespacePattern = new RegExp(
    String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*require\s*\(`,
    'g',
  );
  for (const m of stripped.matchAll(requireNamespacePattern)) {
    namespaceAliases.add(m[1]);
  }

  const requireDestructurePattern = new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(`,
    'g',
  );
  for (const m of stripped.matchAll(requireDestructurePattern)) {
    for (const rawSpecifier of m[1].split(',')) {
      const specifier = rawSpecifier.trim();
      const aliasMatch = specifier.match(new RegExp(String.raw`^ethers\s*:\s*(${IDENT})$`));
      if (aliasMatch) namespaceAliases.add(aliasMatch[1]);
      if (specifier === 'ethers') namespaceAliases.add('ethers');
    }
  }

  let namespaceChanged = true;
  while (namespaceChanged) {
    namespaceChanged = false;
    const namespacePattern = [...namespaceAliases].map(escapeRegExp).join('|');
    const namespaceAliasPattern = new RegExp(
      String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*(?:${namespacePattern})\b`,
      'g',
    );
    for (const m of stripped.matchAll(namespaceAliasPattern)) {
      if (!namespaceAliases.has(m[1])) {
        namespaceAliases.add(m[1]);
        namespaceChanged = true;
      }
    }
  }

  const namespacePattern = [...namespaceAliases].map(escapeRegExp).join('|');

  // Named imports, including aliases: import { Wallet as EthersWallet } from ...
  // String contents are blanked by the lexer, so this intentionally keys on the
  // imported binding shape rather than the module specifier. The audit is a
  // fail-safe for high-impact key loss, so a conservative false positive is
  // preferable to an alias bypass.
  for (const m of stripped.matchAll(importPattern)) {
    for (const rawSpecifier of m[1].split(',')) {
      const specifier = rawSpecifier.trim();
      const aliasMatch = specifier.match(new RegExp(String.raw`^Wallet\s+as\s+(${IDENT})$`));
      if (aliasMatch) aliases.add(aliasMatch[1]);
      if (specifier === 'Wallet') aliases.add('Wallet');
    }
  }

  const addWalletDestructureAliases = (bindingList) => {
    for (const rawSpecifier of bindingList.split(',')) {
      const specifier = rawSpecifier.trim();
      const aliasMatch = specifier.match(new RegExp(String.raw`^Wallet\s*:\s*(${IDENT})$`));
      if (aliasMatch) aliases.add(aliasMatch[1]);
      if (specifier === 'Wallet') aliases.add('Wallet');
    }
  };

  // Destructuring aliases from ethers: const { Wallet: W } = ethers;
  const destructurePattern = new RegExp(
    String.raw`\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:${namespacePattern})\b`,
    'g',
  );
  for (const m of stripped.matchAll(destructurePattern)) {
    addWalletDestructureAliases(m[1]);
  }

  // Direct CommonJS destructuring: const { Wallet: W } = require('ethers');
  for (const m of stripped.matchAll(requireDestructurePattern)) {
    addWalletDestructureAliases(m[1]);
  }

  // Follow simple assignment aliases transitively:
  //   const W = Wallet;
  //   const W = ethers.Wallet;
  //   const W = E.Wallet;     (where E is an ethers namespace import)
  //   const W2 = W;
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of [...aliases]) {
      const aliasPattern = new RegExp(
        String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*${escapeRegExp(alias)}\b`,
        'g',
      );
      for (const m of stripped.matchAll(aliasPattern)) {
        if (!aliases.has(m[1])) {
          aliases.add(m[1]);
          changed = true;
        }
      }
    }
    const namespaceWalletPattern = new RegExp(
      String.raw`\b(?:const|let|var)\s+(${IDENT})\s*=\s*(?:${namespacePattern})\s*\.\s*Wallet\b`,
      'g',
    );
    for (const m of stripped.matchAll(namespaceWalletPattern)) {
      if (!aliases.has(m[1])) {
        aliases.add(m[1]);
        changed = true;
      }
    }
  }

  return aliases;
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

  await scanRoot(join(REPO_ROOT, 'scripts'));
  await scanRoot(packagesDir);

  // A stale allowlist entry is itself a violation — we don't want exemptions
  // to silently outlive the file/call site they were granted for.
  const staleAllowlist = [];
  for (const [path] of ALLOWLIST) {
    if (!seenAllowlistPaths.has(path)) staleAllowlist.push(path);
  }

  if (violations.length === 0 && staleAllowlist.length === 0) {
    console.log('audit-create-random: OK — no undisciplined Wallet.createRandom() in production code.');
    if (ALLOWLIST.size > 0) {
      console.log(`Allowlisted (${ALLOWLIST.size}):`);
      for (const [p, { expectedHits, justification }] of ALLOWLIST) {
        console.log(`  - ${p} (${expectedHits} hit${expectedHits === 1 ? '' : 's'}): ${justification}`);
      }
    }
    return 0;
  }

  console.error('audit-create-random: FAIL');
  for (const v of violations) {
    console.error(`\n  ${v.path}`);
    if (v.kind === 'no-exemption') {
      console.error(`    No allowlist entry. Found ${v.hits.length} hit${v.hits.length === 1 ? '' : 's'}:`);
    } else {
      console.error(`    Allowlisted for ${v.expectedHits} hit${v.expectedHits === 1 ? '' : 's'} (${v.justification}), but found ${v.hits.length}:`);
    }
    for (const h of v.hits) console.error(`    L${h.line}: ${h.snippet}`);
  }
  for (const p of staleAllowlist) {
    console.error(`\n  ${p}`);
    console.error('    Allowlist entry is stale (no Wallet.createRandom() found in the file).');
    console.error('    Remove the entry from ALLOWLIST in scripts/audit-create-random.mjs.');
  }
  console.error(`
Why this matters: random keys generated in-process and then discarded
produce unverifiable signatures and unrecoverable on-chain identities.
This is exactly how the May 2026 testnet incident destroyed nine admin
keys — see scripts/audit-create-random.mjs header for the full story.

If your new use site genuinely persists the key (and the operator can
recover it), add it to the ALLOWLIST in scripts/audit-create-random.mjs
with a one-line justification. Otherwise: take a key from the caller.
`);
  return 1;
}

// Run only when invoked directly (so the test file can import the lexer
// + findHits without triggering a full repository scan + process.exit).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const exitCode = await main();
  process.exit(exitCode);
}
