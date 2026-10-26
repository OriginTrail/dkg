import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { verifyReleaseTag } from '../release-policy.mjs';
import { fileIdentity, verifyCertificate } from './bundle.mjs';
import { run } from '../release-process.mjs';

function validateRegistry(registry) {
  if (!registry) return;
  const url = new URL(registry);
  assert.ok(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'registry URL must not contain credentials or query secrets');
}
export function registryDist(pkg, registry) {
  validateRegistry(registry);
  const result = spawnSync('npm', ['view', `${pkg.name}@${pkg.version}`, 'dist', '--json', ...(registry ? ['--registry', registry] : [])], { encoding: 'utf8' });
  if (result.status !== 0) {
    // Only a positively identified missing version permits publication. Network,
    // auth, malformed metadata and all other acquisition errors fail closed.
    let error;
    try { error = JSON.parse(result.stdout)?.error; } catch { /* malformed is not absence */ }
    if (error?.code === 'E404') return null;
    throw new Error(`Registry metadata unavailable for ${pkg.name}`);
  }
  const dist = JSON.parse(result.stdout);
  assert.ok(typeof dist?.integrity === 'string', `Registry integrity absent for ${pkg.name}`);
  return dist;
}
export function checkRegistrySet(manifest, readDist, { allowMissing = false } = {}) {
  return manifest.packages.map(pkg => {
    const dist = readDist(pkg);
    if (dist === null) { assert.ok(allowMissing, `unpublished package: ${pkg.name}`); return { pkg, exists: false }; }
    assert.equal(dist.integrity, pkg.integrity, `registry integrity mismatch: ${pkg.name}@${pkg.version}`);
    return { pkg, exists: true };
  });
}
// Publication exposes a dist-tag immediately. Publish every internal runtime
// dependency first so a failed later command cannot strand an exposed consumer.
function publicationOrder(manifest) {
  const packages = new Map(manifest.packages.map(pkg => [pkg.name, pkg]));
  const policies = new Map(manifest.expectedPackages.map(pkg => [pkg.name, pkg.dependencies]));
  const active = new Set(), visited = new Set(), ordered = [];
  const visit = name => {
    if (visited.has(name)) return;
    assert.ok(!active.has(name), `cyclic internal publication dependency: ${name}`);
    active.add(name);
    const deps = policies.get(name);
    for (const dependency of Object.keys({ ...deps.dependencies, ...deps.optionalDependencies, ...deps.peerDependencies }).sort()) {
      if (packages.has(dependency)) visit(dependency);
    }
    active.delete(name);
    visited.add(name);
    ordered.push(packages.get(name));
  };
  for (const pkg of manifest.packages) visit(pkg.name);
  return ordered;
}
function mutate(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) throw new Error('npm mutation failed; inspect npm output and obtain a fresh OTP if needed');
}
// npm without a terminal: stdin is closed, so npm cannot fall back to its
// interactive or web authentication prompt. The one-time code reaches npm in
// its environment, never its arguments, and a failure carries npm's error code
// only, never its output or arguments.
function quietNpm(args, { otp, timeout = 60_000 } = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'npm_config_otp'));
  if (otp) env.npm_config_otp = otp;
  return new Promise((resolve, reject) => {
    const child = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(new Error('npm did not start'), { code: error.code })); });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      if (status === 0) return resolve(stdout);
      const code = timedOut ? 'ETIMEDOUT' : signal ?? /npm (?:error|ERR!) code (\S+)/.exec(stderr)?.[1];
      reject(Object.assign(new Error(`npm failed${code ? ` (${code})` : ''}`), { code }));
    });
  });
}
// The dist-tags endpoint npm itself reads before a tag write. `npm view` reads
// the package document, which the registry's CDN can serve minutes stale.
export async function registryDistTags(pkg, registry) {
  validateRegistry(registry);
  let listing;
  try { listing = await quietNpm(['dist-tag', 'ls', pkg.name, ...(registry ? ['--registry', registry] : [])]); }
  catch { throw new Error(`Registry dist-tags unavailable for ${pkg.name}`); }
  return Object.fromEntries([...listing.matchAll(/^([^\s:]+): (\S+)$/gm)].map(([, name, version]) => [name, version]));
}
// The terminal echoes nothing: readline reads it in raw mode and writes its
// echo into a sink.
export function promptOtp({ input = process.stdin, output = process.stderr } = {}) {
  const prompt = createInterface({ input, output: new Writable({ write: (_chunk, _encoding, done) => done() }), terminal: true });
  output.write('npm one-time code (hidden; use one that has just appeared): ');
  return new Promise((resolve, reject) => {
    prompt.once('line', resolve);
    prompt.once('SIGINT', () => reject(new Error('Cancelled; no tag moved')));
    prompt.once('close', () => reject(new Error('No one-time code entered; no tag moved')));
  }).finally(() => { prompt.close(); output.write('\n'); });
}
async function inParallel(items, limit, fn) {
  const results = [];
  let next = 0;
  const lane = async () => { while (next < items.length) { const index = next++; results[index] = await fn(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}
function stopped({ stop, otp, completed, planned, remaining, version }) {
  if (!stop) return `npm accepted every tag write, but the registry does not show ${remaining} of them on ${version} (listed above). Check again in a minute with --dry-run, and run the same command again for any it still lists.`;
  const at = `${stop.pair.channel} of ${stop.pair.pkg.name}`;
  const cause = stop.reason ? `Promotion stopped before ${at}: ${stop.reason}.`
    : stop.code === 'E429' ? `npm is rate-limiting one-time codes (E429 at ${at}). Wait about ten minutes, then run the same command again with a fresh code.`
    : stop.code === 'EOTP' && otp ? `npm no longer accepts the one-time code (EOTP at ${at}). Run the same command again with a fresh code.`
    : stop.code === 'EOTP' ? `npm needs a one-time code (EOTP at ${at}). Run the same command in a terminal to be asked for one, or pass --otp or NPM_CONFIG_OTP.`
    : stop.code === 'E401' ? `npm refused the login (E401 at ${at}). Check npm whoami, run npm login if it fails, then run the same command again.`
    : `npm could not move ${at}${stop.code ? ` (${stop.code})` : ''}. Fix the cause, then run the same command again.`;
  return `${cause} npm accepted ${completed} of ${planned} tag moves; ${remaining > 0
    ? `${remaining} tags are not on ${version}, and a re-run moves only those.`
    : `the registry shows every tag on ${version}.`}`;
}
// Moves only the (package, tag) pairs the registry does not show on the
// version, so a re-run continues where an earlier run stopped.
async function promote({ manifest, tags, bundle, receiptFile, expected, registry, otp, dryRun, readTags, runner, askOtp, parallel, settle, log }) {
  const describe = ({ pkg, channel }) => ({ package: pkg.name, tag: channel });
  const readPairs = read => inParallel(manifest.packages, parallel, async pkg => {
    const current = await read(pkg);
    return tags.map(channel => ({ pkg, channel, now: current === null ? 'not readable' : current?.[channel] ?? 'unset' }));
  }).then(perPackage => perPackage.flat());
  const pending = pairs => pairs.filter(({ pkg, now }) => now !== pkg.version);
  const before = await readPairs(readTags);
  const planned = pending(before);
  const progress = { mode: 'promote', dryRun, reused: [], alreadyOnVersion: before.length - planned.length, completed: [], planned: planned.map(describe) };
  log(`${manifest.packages.length} packages, tags ${tags.join(', ')}: ${progress.alreadyOnVersion} already on ${expected.version}, ${planned.length} to move`);
  // Asked for after the reads, so the code is fresh when the writes start.
  const entered = dryRun || planned.length === 0 ? undefined : otp || (askOtp ? await askOtp() : undefined);
  const code = entered === undefined ? undefined : String(entered).replace(/\s/g, '');
  if (code !== undefined && !/^\d{6,8}$/.test(code)) throw new Error('A one-time code is 6 to 8 digits; no tag moved');
  // Recheck package AND evidence bytes after acquisition and the prompt,
  // immediately before the first write.
  verifyCertificate(bundle, receiptFile, expected);
  if (dryRun) for (const { pkg, channel, now } of planned) log(`Would move ${channel} of ${pkg.name} to ${pkg.version} (now ${now})`);
  if (planned.length === 0) log('Nothing to move');
  if (dryRun || planned.length === 0) return progress;
  let stop;
  const intact = pkg => {
    try { return isDeepStrictEqual(fileIdentity(path.join(bundle, pkg.tarball)), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }); } catch { return false; }
  };
  const move = async pair => {
    if (stop) return false;
    const { pkg, channel } = pair;
    if (!intact(pkg)) {
      stop ??= { pair, reason: `the bundle's tarball of ${pkg.name} changed` };
      return false;
    }
    try {
      await runner('npm', ['dist-tag', 'add', `${pkg.name}@${pkg.version}`, channel, ...(registry ? ['--registry', registry] : [])], { otp: code });
    } catch (error) {
      // Only npm's error code: runner errors can carry npm's arguments.
      stop ??= { pair, code: typeof error?.code === 'string' ? error.code : undefined };
      return false;
    }
    progress.completed.push(describe(pair));
    log(`Moved ${channel} of ${pkg.name} to ${pkg.version}`);
    return true;
  };
  const lanes = manifest.packages.map(pkg => planned.filter(pair => pair.pkg === pkg)).filter(lane => lane.length > 0);
  // The first write goes alone, so npm refuses a stale or mistyped code once
  // rather than once per parallel write: refused codes count towards its rate
  // limit. Then packages in parallel, each package's tags in sequence: two
  // writes to one package's dist-tags at once can fail with E409 Conflict.
  if (await move(lanes[0].shift())) {
    await inParallel(lanes.filter(lane => lane.length > 0), parallel, async lane => { for (const pair of lane) if (!await move(pair)) return; });
  }
  // npm has accepted tag writes before that the registry never showed.
  if (settle > 0) await new Promise(resolve => setTimeout(resolve, settle));
  const remaining = pending(await readPairs(async pkg => { try { return await readTags(pkg); } catch { return null; } }));
  progress.remaining = remaining.map(pair => ({ ...describe(pair), now: pair.now }));
  for (const { pkg, channel, now } of remaining) log(`Not on ${pkg.version} yet: ${channel} of ${pkg.name} is ${now}`);
  if (!stop && remaining.length === 0) {
    log(`Done: every listed tag of the ${manifest.packages.length} packages is on ${expected.version}`);
    return progress;
  }
  const error = new Error(stopped({ stop, otp: code, completed: progress.completed.length, planned: planned.length, remaining: remaining.length, version: expected.version }));
  error.progress = progress;
  throw error;
}
export async function preparedRelease({
  mode, bundle, receiptFile, expected, rootDir, tag, tags, registry, otp,
  dryRun = false, readDist = pkg => registryDist(pkg, registry),
  readTags = pkg => registryDistTags(pkg, registry),
  runner = mode === 'promote' ? (_command, args, options) => quietNpm(args, options) : mutate,
  askOtp = process.stdin.isTTY ? promptOtp : null, parallel = 8, settle = 4_000,
  gitRunner = (cmd, args) => run(cmd, args, { cwd: rootDir }),
  log = console.log,
}) {
  assert.ok(['publish', 'promote'].includes(mode));
  validateRegistry(registry);
  assert.ok(tags?.length > 0 && new Set(tags).size === tags.length && tags.every(t => /^[a-z][a-z0-9-]*$/.test(t)), 'invalid/duplicate dist-tags');
  if (mode === 'publish') assert.equal(tags.length, 1, 'publish accepts exactly one initial dist-tag');
  const { manifest } = verifyCertificate(bundle, receiptFile, expected);
  const problems = verifyReleaseTag({ tag, version: expected.version, runner: gitRunner });
  assert.deepEqual(problems, [], 'release signed-tag/version/ancestry preflight failed');
  assert.equal(gitRunner('git', ['rev-parse', `${tag}^{commit}`]), expected.commit, 'tag does not identify prepared source');
  // Preflight EVERY package before even the first mutation. A matching version
  // alone cannot make a partial publication safe to resume.
  const state = checkRegistrySet(manifest, readDist, { allowMissing: mode === 'publish' });
  if (mode === 'promote') return promote({ manifest, tags, bundle, receiptFile, expected, registry, otp, dryRun, readTags, runner, askOtp, parallel, settle, log });
  const existing = new Set(state.filter(s => s.exists).map(s => s.pkg.name));
  const operations = publicationOrder(manifest).filter(pkg => !existing.has(pkg.name)).flatMap(pkg => tags.map(channel => ({
    pkg, channel, tarball: path.join(bundle, pkg.tarball),
    args: ['publish', path.join(bundle, pkg.tarball), '--access', 'public', '--tag', channel],
  })));
  const describe = ({ pkg, channel }) => ({ package: pkg.name, tag: channel });
  const progress = { mode, dryRun, reused: state.filter(s => s.exists).map(s => s.pkg.name), completed: [], planned: operations.map(describe) };
  // Recheck package AND evidence bytes after acquisition and immediately before
  // mutation; no build-info generation/build/repack exists in this path.
  verifyCertificate(bundle, receiptFile, expected);
  try {
    for (const operation of operations) {
      const { pkg, channel, tarball, args } = operation;
      assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed before mutation: ${pkg.name}`);
      // Neither dry-run nor errors interpolate OTPs or registry credentials.
      log(`${dryRun ? 'Would' : 'Will'} ${mode} ${pkg.name}@${pkg.version} (${channel})`);
      if (dryRun) continue;
      runner('npm', [...args, ...(registry ? ['--registry', registry] : []), ...(otp ? [`--otp=${otp}`] : [])]);
      progress.completed.push(describe(operation));
      assert.deepEqual(fileIdentity(tarball), { size: pkg.size, sha256: pkg.sha256, integrity: pkg.integrity }, `tarball changed during publication: ${pkg.name}`);
    }
  } catch (cause) {
    // Do not repeat runner exceptions: npm wrappers can include their secret args.
    const error = new Error(`Partial ${mode}; completed ${JSON.stringify(progress.completed)}; reused ${JSON.stringify(progress.reused)}. Re-run only after registry integrity verification.`);
    error.progress = progress;
    error.cause = cause;
    throw error;
  }
  return progress;
}
