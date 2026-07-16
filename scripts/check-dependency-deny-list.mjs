#!/usr/bin/env node
/**
 * Dependency deny-list scanner — supply-chain hardening §13.
 *
 * Reads `.github/dependency-deny-list.json` and asserts that:
 *
 *   1. No name in `denied_package_names[]` appears in `pnpm-lock.yaml`
 *      or in any `package.json` file under the workspace.
 *   2. No path in `denied_files[]` exists at the exact repo-root-
 *      relative location given.
 *   3. No file whose basename is in `denied_filenames[]` exists
 *      anywhere in the workspace tree (recursive — used for AI-
 *      injection persistence files like `.cursorrules` where the
 *      attacker could plant the file at any depth).
 *
 * Exit codes:
 *
 *     0  clean (and the lockfile sanity check passed)
 *     1  one or more denied entries matched
 *     2  scanner broken (deny-list file missing / unparseable / wrong
 *        schema version, OR none of the configured sanity-check
 *        anchors were found in pnpm-lock.yaml so the scan path
 *        cannot be trusted to be exercising the lockfile)
 *
 * Design constraints:
 *
 *   - Vanilla Node only. No `npm install` step in the calling workflow.
 *     We use `node:fs`, `node:path`, `node:url`. Nothing else. The
 *     scanner is bit-for-bit reproducible from the committed file.
 *   - Hard sanity check: if NONE of the configured anchor packages are
 *     found in the lockfile, exit 2. A future workflow refactor that
 *     renames `pnpm-lock.yaml` or moves it cannot silently start
 *     reporting clean for unrelated reasons. (Same lesson the
 *     pnpm-audit step in this workflow learned the hard way — see
 *     §H + §13 in SUPPLY_CHAIN_HARDENING.md.)
 *   - Both pnpm-lock.yaml AND every package.json anywhere in the
 *     workspace are scanned. Lockfile catches transitives; package.json
 *     catches a direct-dep addition before the lockfile updates.
 *   - Outputs a job-summary table when GITHUB_STEP_SUMMARY is set
 *     (CI context) and a plain terminal report otherwise (local dev).
 *     The same script works for pre-push checks and CI gates.
 *
 * Usage:
 *
 *     node scripts/check-dependency-deny-list.mjs
 *
 *     # Pre-push hook:
 *     pnpm exec node scripts/check-dependency-deny-list.mjs || exit 1
 */

import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const DENY_LIST_PATH = '.github/dependency-deny-list.json';
const LOCKFILE_PATH = 'pnpm-lock.yaml';

/**
 * Maximum deny-list schema version this scanner can handle. Bumping
 * this is a deliberate scanner change that must land in the same PR
 * as the JSON field additions it enables.
 *
 *   v1 — initial: denied_package_names, denied_files, scanner_sanity_check
 *   v2 — adds denied_filenames[] (recursive basename match)
 *
 * The scanner accepts the JSON when `schema_version <= MAX_SUPPORTED_SCHEMA`
 * AND fails with exit 2 if it sees a higher version, on the theory that a
 * stale local checkout reading a newer file should fail loudly rather than
 * silently ignore the new fields. The JSON file is required to declare a
 * version (`schema_version` field); omitting it is a load-time error.
 */
const MAX_SUPPORTED_SCHEMA = 2;

function fail(code, message) {
  console.error(`::error title=dependency-deny-list scanner::${message}`);
  process.exit(code);
}

function info(message) {
  console.log(message);
}

function loadDenyList() {
  const path = join(repoRoot, DENY_LIST_PATH);
  if (!existsSync(path)) {
    fail(2, `${DENY_LIST_PATH} not found; cannot scan.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    fail(2, `${DENY_LIST_PATH} is not valid JSON: ${err.message}`);
  }
  // Schema version. Required since v1. Fail loudly on either an unknown
  // higher version (stale local scanner reading a newer file) or a
  // missing version (malformed file).
  if (typeof parsed.schema_version !== 'number') {
    fail(2, `${DENY_LIST_PATH} missing required field 'schema_version' (number).`);
  }
  if (parsed.schema_version > MAX_SUPPORTED_SCHEMA) {
    fail(2, `${DENY_LIST_PATH} declares schema_version=${parsed.schema_version} but this scanner only supports up to ${MAX_SUPPORTED_SCHEMA}. Pull latest main and re-run.`);
  }
  if (!Array.isArray(parsed.denied_package_names)) {
    fail(2, `${DENY_LIST_PATH} missing or malformed denied_package_names[].`);
  }
  if (!Array.isArray(parsed.denied_files)) {
    fail(2, `${DENY_LIST_PATH} missing or malformed denied_files[].`);
  }
  // denied_filenames[] is optional — added in the second hardening pass.
  // Older deny-list files without it still load cleanly.
  if (parsed.denied_filenames !== undefined && !Array.isArray(parsed.denied_filenames)) {
    fail(2, `${DENY_LIST_PATH} denied_filenames must be an array if present.`);
  }
  if (!Array.isArray(parsed.scanner_sanity_check?.expected_packages_in_lockfile)
      || parsed.scanner_sanity_check.expected_packages_in_lockfile.length === 0) {
    fail(2, `${DENY_LIST_PATH} missing scanner_sanity_check.expected_packages_in_lockfile[] (must contain at least one anchor).`);
  }

  // Detect duplicate entries — a duplicate name in the JSON would
  // produce duplicate annotations on a hit and signal that the list
  // is being maintained sloppily. Belt-and-braces against accidental
  // copy-paste during a bulk add.
  const seenNames = new Set();
  const dupes = [];
  for (const entry of parsed.denied_package_names) {
    if (!entry?.name) {
      fail(2, `${DENY_LIST_PATH}: denied_package_names[] entry missing .name field: ${JSON.stringify(entry)}`);
    }
    if (seenNames.has(entry.name)) dupes.push(entry.name);
    seenNames.add(entry.name);
  }
  const seenPaths = new Set();
  for (const entry of parsed.denied_files) {
    if (!entry?.path) {
      fail(2, `${DENY_LIST_PATH}: denied_files[] entry missing .path field: ${JSON.stringify(entry)}`);
    }
    if (seenPaths.has(entry.path)) dupes.push(entry.path);
    seenPaths.add(entry.path);
  }
  const seenFilenames = new Set();
  for (const entry of (parsed.denied_filenames ?? [])) {
    if (!entry?.filename) {
      fail(2, `${DENY_LIST_PATH}: denied_filenames[] entry missing .filename field: ${JSON.stringify(entry)}`);
    }
    if (entry.filename.includes('/') || entry.filename.includes('\\')) {
      fail(2, `${DENY_LIST_PATH}: denied_filenames[] .filename must be a basename only (no path separators): ${entry.filename}`);
    }
    if (seenFilenames.has(entry.filename)) dupes.push(entry.filename);
    seenFilenames.add(entry.filename);
  }
  if (dupes.length > 0) {
    fail(2, `${DENY_LIST_PATH}: duplicate entries detected (${dupes.join(', ')}); deduplicate before committing.`);
  }
  return parsed;
}

/**
 * Build a regex that matches a package NAME as a whole token (not a
 * substring of a longer name). Package names appear in many positions
 * across pnpm-lock.yaml and package.json. Examples that MUST match:
 *
 *     pkg-name:                       ← pnpm v9 importer dep block
 *     pkg-name@x.y.z:                 ← pnpm v9 snapshot key
 *     /pkg-name@x.y.z:                ← pnpm v8 snapshot key (legacy)
 *     pkg-name@x.y.z(peer@y.y.y):     ← pnpm v9 peer-suffixed snapshot
 *     pkg-name@<x.y.z: y.y.y          ← overrides / patchedDependencies
 *     '@scope/pkg@x.y.z':             ← scoped, quoted snapshot key
 *     "pkg-name": "^x.y.z"            ← package.json dep
 *     "pkg-name": "npm:other@x.y.z"   ← npm alias (name in value)
 *     "pkg-name": "github:user/x"     ← git URL form
 *
 * Strategy: a name-continuation character is any of [a-zA-Z0-9._-].
 * That is the set of chars a valid npm name (outside the `@scope/`
 * prefix marker) can be made of. The boundary then is the negation of
 * that set — anything else (`@`, `/`, `:`, quote, space, `(`, `)`, `<`,
 * end-of-line, …) is a valid boundary.
 *
 * Scope semantics: an UNSCOPED deny entry must NOT match the scope
 * portion of a different, scoped package. For example, deny entry
 * 'origintrail-official' must not flag '@origintrail-official/dkg' as a
 * hit — those are different npm identities. We enforce this by adding
 * '@' to the LEFT boundary-failure class for unscoped entries: if the
 * candidate match is immediately preceded by `@`, it's the scope of a
 * scoped package and the unscoped entry must not match it.
 *
 * For scoped entries (already starting with `@`), the `@` is part of
 * the match and the standard boundary rule applies.
 *
 * Properties:
 *   - 'super-commander-pro' does NOT match 'commander' (the `-` adjacent
 *     to `commander` fails the boundary check on both sides).
 *   - 'commander-extras' does NOT match 'commander' (trailing `-`).
 *   - '@evil/commander' does NOT match 'commander' alone (the `/`
 *     before `commander` is technically a valid boundary, but in
 *     practice the lockfile/package.json text is '@evil/commander':,
 *     so the regex would still find 'commander' there — known false
 *     positive shape if an unscoped deny entry happens to share a
 *     name with the second path component of a scoped legit package.
 *     None of the current 34 deny entries collide with anything
 *     scoped in our tree (verified by the clean-run sanity check).
 *
 * Known limitations (documented in SUPPLY_CHAIN_HARDENING.md §13):
 *   - Tarball references where the version glues directly onto the
 *     name (e.g. `file:./eth-wallet-sentinel-1.0.0.tgz`) are NOT
 *     caught — the `-1.0.0` suffix puts a name-continuation char
 *     adjacent to the name and the regex correctly refuses to match
 *     a substring of a longer-looking token. This is a narrow vector
 *     (requires committing the tarball to the repo) and is covered
 *     in defence-in-depth by §1 (SHA-pinned actions), §3 (no
 *     postinstall execution without an allow-list), and CODEOWNERS
 *     routing on `pnpm-lock.yaml` + `package.json`.
 */
function buildNameMatcher(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isScoped = name.startsWith('@');
  // For unscoped deny entries, the `@` on the LEFT would indicate
  // we are inside a scope name, which is a different identity from
  // the unscoped name. Add `@` to the failure class in that case.
  // For scoped entries the `@` is part of the match itself, so the
  // standard boundary rule applies.
  const leftClass = isScoped ? 'a-zA-Z0-9._-' : 'a-zA-Z0-9._@-';
  // Non-capturing left-boundary group (we never read the capture).
  return new RegExp(`(?:^|[^${leftClass}])${escaped}(?![a-zA-Z0-9._-])`, 'm');
}

/**
 * Compile a regex matcher for each deny-list entry exactly once,
 * up front, so the inner per-file loop is just `matcher.test(content)`
 * (no rebuild). Caller passes the resulting array to `scanFileWithMatchers`.
 */
function buildAllMatchers(entries) {
  return entries.map((entry) => ({ entry, matcher: buildNameMatcher(entry.name) }));
}

function scanFileWithMatchers(filePath, matchers) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const hits = [];
  for (const { entry, matcher } of matchers) {
    if (matcher.test(content)) hits.push(entry);
  }
  return hits;
}

/**
 * Walk the workspace once, collecting two things at the same time:
 *   - every `package.json` for the name-deny scan
 *   - every file whose basename appears in `denied_filenames[]`
 *
 * Single traversal so the recursive filename check costs nothing
 * beyond what the existing package.json walk already does.
 *
 * NB: dot-prefixed directories are skipped EXCEPT `.github` and the
 * committed `.cursor` rules tree — so a `.cursorrules` planted inside
 * `.husky/`, `.idea/`, etc. would NOT be caught. That's intentional for
 * the current scope: most IDE/editor configs are user-local and not
 * normally committed; if a future review wants to extend coverage to
 * specific dot-dirs, add them to the EXTRA_SCAN_DOT_DIRS set.
 */
function walkWorkspace(dir, deniedFilenameSet) {
  const pkgJsons = [];
  const filenameHits = [];
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache', 'coverage', '.publish-artifacts']);
  const EXTRA_SCAN_DOT_DIRS = new Set(['.github', '.cursor']);

  function walk(d) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) {
        // Skip dot-prefixed directories so we don't descend into
        // `.git`, `.idea`, `.vscode`, `.husky`, etc. — none of those
        // hold package.json files we care about, and pulling in
        // editor configs would slow the walk and risk false positives.
        // EXTRA_SCAN_DOT_DIRS allows opting specific ones back in
        // (e.g. `.github` and this repo's committed `.cursor` rules).
        if (e.name.startsWith('.') && !EXTRA_SCAN_DOT_DIRS.has(e.name)) continue;
        walk(full);
      } else if (e.isFile()) {
        // Dot-prefixed FILES are not skipped — we explicitly WANT to
        // see `.cursorrules` and any other AI-injection persistence
        // file the deny-list lists.
        if (e.name === 'package.json') pkgJsons.push(full);
        if (deniedFilenameSet.has(e.name)) filenameHits.push({ path: relative(dir, full), basename: e.name });
      }
    }
  }
  walk(dir);
  return { pkgJsons, filenameHits };
}

function checkLockfileSanity(sanityNames) {
  const path = join(repoRoot, LOCKFILE_PATH);
  if (!existsSync(path)) {
    fail(2, `${LOCKFILE_PATH} not found at repo root; the lockfile must exist for the deny-list scan to mean anything.`);
  }
  const content = readFileSync(path, 'utf-8');
  // Multi-anchor: as long as AT LEAST ONE configured anchor is found
  // in the lockfile, the matcher + scan path are working. A future
  // dep removal of one anchor will not silently break the scanner.
  const found = sanityNames.filter((n) => buildNameMatcher(n).test(content));
  if (found.length === 0) {
    fail(2, `Sanity check failed: none of the expected anchor packages (${sanityNames.join(', ')}) were found in ${LOCKFILE_PATH}. This means either the lockfile path/format has drifted or the matcher regex is broken. Refusing to report clean. Update scanner_sanity_check.expected_packages_in_lockfile in ${DENY_LIST_PATH} if every chosen anchor has been removed from deps.`);
  }
  return found;
}

function emitSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  try {
    appendFileSync(summaryPath, lines.join('\n') + '\n');
  } catch (err) {
    console.error(`(non-fatal) failed to write GITHUB_STEP_SUMMARY: ${err.message}`);
  }
}

function main() {
  const denyList = loadDenyList();
  const sanityAnchors = denyList.scanner_sanity_check.expected_packages_in_lockfile;

  // Sanity check FIRST. If this fails we don't even attempt to report
  // clean — the scanner is broken and any "no hits" result is meaningless.
  const found = checkLockfileSanity(sanityAnchors);
  info(`✓ Lockfile sanity check passed (${found.length}/${sanityAnchors.length} anchor(s) found: ${found.join(', ')}).`);

  const allHits = [];

  // Single tree walk: gathers package.json files and basename-deny hits
  // in one pass. `denied_filenames[]` is optional (introduced in
  // schema v2); older deny-list files without it Just Work.
  const deniedFilenames = denyList.denied_filenames ?? [];
  const deniedFilenameMap = new Map(deniedFilenames.map((d) => [d.filename, d]));
  const { pkgJsons: pkgJsonFiles, filenameHits } = walkWorkspace(repoRoot, new Set(deniedFilenameMap.keys()));

  // Pre-compile a matcher for every denied package name, once. The
  // per-file loop below then just runs `matcher.test(content)` against
  // each file — no rebuild per iteration. With 34 entries × ~27 files
  // this is microscopic either way, but explicit precompilation
  // documents the intent and keeps the inner loop O(files × patterns).
  const nameMatchers = buildAllMatchers(denyList.denied_package_names);

  // 1. Package-name deny-list scan against the lockfile.
  const lockHits = scanFileWithMatchers(join(repoRoot, LOCKFILE_PATH), nameMatchers);
  for (const hit of lockHits) {
    allHits.push({ kind: 'package_name', file: LOCKFILE_PATH, ...hit });
  }

  // 2. Same scan against every package.json under the workspace.
  for (const pkgJson of pkgJsonFiles) {
    const hits = scanFileWithMatchers(pkgJson, nameMatchers);
    for (const hit of hits) {
      allHits.push({ kind: 'package_name', file: relative(repoRoot, pkgJson), ...hit });
    }
  }

  // 3. Exact-path file deny-list.
  for (const denied of denyList.denied_files) {
    const path = join(repoRoot, denied.path);
    if (existsSync(path)) {
      allHits.push({ kind: 'denied_file', file: denied.path, ...denied });
    }
  }

  // 4. Recursive-basename file deny-list. Catches `.cursorrules`
  // (or any other tagged basename) ANYWHERE in the tree, not just
  // at the repo root. This is the right scope for AI-injection
  // persistence files — the TrapDoor advisory explicitly says
  // "check ANY unexpected `.cursorrules`", not just root.
  for (const hit of filenameHits) {
    const denied = deniedFilenameMap.get(hit.basename);
    allHits.push({ kind: 'denied_filename', file: hit.path, basename: hit.basename, ...denied });
  }

  info(`Scanned ${pkgJsonFiles.length} package.json files + 1 lockfile + ${denyList.denied_files.length} exact path(s) + ${deniedFilenames.length} basename(s) (recursive).`);

  if (allHits.length === 0) {
    info(`✓ Clean. ${denyList.denied_package_names.length} package names, ${denyList.denied_files.length} exact path(s), and ${deniedFilenames.length} basename(s) checked; zero matches.`);
    emitSummary([
      '## Dependency deny-list scan',
      '',
      '✓ **Clean.** No denied package names or paths found.',
      '',
      `**Scanned:** ${pkgJsonFiles.length} \`package.json\` files + \`${LOCKFILE_PATH}\` + ${denyList.denied_files.length} exact path(s) + ${deniedFilenames.length} basename(s) (recursive).`,
      `**Deny-list entries:** ${denyList.denied_package_names.length} package names, ${denyList.denied_files.length} exact paths, ${deniedFilenames.length} basenames.`,
      `**Lockfile sanity check:** ${found.length}/${sanityAnchors.length} anchor(s) found (${found.join(', ')}) ✓`,
    ]);
    process.exit(0);
  }

  // Hits found — emit detailed annotations for each.
  console.error(`✗ ${allHits.length} deny-list hit(s) found:`);
  const summaryLines = [
    '## Dependency deny-list scan',
    '',
    `✗ **${allHits.length} deny-list hit(s) found.** Refusing to merge.`,
    '',
    '| Kind | Match | Where | Campaign | Source |',
    '|------|-------|-------|----------|--------|',
  ];
  for (const hit of allHits) {
    let label;
    if (hit.kind === 'package_name') label = hit.name;
    else if (hit.kind === 'denied_filename') label = hit.basename;
    else label = hit.path;
    console.error(`  - ${hit.kind}: ${label} (file: ${hit.file}, campaign: ${hit.campaign})`);
    console.error(`::error file=${hit.file},title=Denied ${hit.kind} matched::${label} is on the supply-chain deny-list (campaign: ${hit.campaign}). See ${hit.source_url}`);
    summaryLines.push(`| ${hit.kind} | \`${label}\` | \`${hit.file}\` | ${hit.campaign} | [link](${hit.source_url}) |`);
  }
  summaryLines.push('', `If a hit is a known false positive, document the rationale and remove the entry from \`${DENY_LIST_PATH}\` in the same PR. Do not bypass this check by editing the scanner.`);
  emitSummary(summaryLines);
  process.exit(1);
}

main();
