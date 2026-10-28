import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { preparedRelease, promptOtp } from '../package-certification/publish.mjs';
import { fixture, releaseGitFixture } from './package-certification-fixture.mjs';

const CODE = '913579';
const TAGS = ['testnet', 'mainnet', 'latest'];
const OLD = '10.0.24';

// Twelve packages, so eight writes run at once.
function packageSet(t) {
  const expected = structuredClone(fixture(t).expected);
  for (let i = 0; i < 10; i++) {
    expected.packages.push({ name: `@origintrail-official/dkg-extra-${i}`, version: expected.version, dependencies: { dependencies: {}, optionalDependencies: {}, peerDependencies: {}, devDependencies: {} } });
  }
  return fixture(t, { expected });
}
// npm and the registry, faked. A write takes a few milliseconds, so writes
// overlap; `fail` picks a write's npm error code by its start order, and an
// `unshown` write is accepted but never shows.
function fakeNpm(f, { onVersion = [], fail = () => undefined, unshown = [] } = {}) {
  const tags = new Map(f.manifest.packages.map(pkg => [pkg.name, Object.fromEntries(TAGS.map(tag => [tag, OLD]))]));
  for (const [name, tag] of onVersion) tags.get(name)[tag] = f.expected.version;
  const npm = { events: [], calls: [], overlaps: [], busiest: 0, fail };
  const writing = new Set();
  let running = 0;
  npm.readTags = async pkg => { npm.events.push(['read', pkg.name]); return { ...tags.get(pkg.name) }; };
  npm.runner = async (command, args, options) => {
    const [, , spec, tag] = args, at = spec.lastIndexOf('@'), name = spec.slice(0, at);
    npm.calls.push({ command, args, options });
    const index = npm.calls.length;
    if (writing.has(name)) npm.overlaps.push(name);
    writing.add(name);
    npm.busiest = Math.max(npm.busiest, ++running);
    npm.events.push(['start', name, tag]);
    await new Promise(resolve => setTimeout(resolve, 5));
    writing.delete(name);
    running--;
    const code = npm.fail({ name, tag, index });
    if (code) {
      npm.events.push(['fail', name, tag]);
      // Like an npm wrapper's error, this one carries npm's arguments and the code.
      throw Object.assign(new Error(`npm ${args.join(' ')} --otp=${options.otp} failed`), { code });
    }
    if (!unshown.some(([n, t]) => n === name && t === tag)) tags.get(name)[tag] = spec.slice(at + 1);
    npm.events.push(['end', name, tag]);
  };
  return npm;
}
function options(f, npm, extra = {}) {
  return {
    mode: 'promote', bundle: f.bundle, receiptFile: f.receiptFile, expected: f.expected, tags: TAGS,
    ...releaseGitFixture(f.expected), evidenceFile: 'fixture-decision.json', prepareEvidence: () => ({ recheckLocalIntegrity: () => {} }), readDist: pkg => ({ integrity: pkg.integrity }),
    readTags: npm.readTags, runner: npm.runner, otp: CODE, askOtp: null, settle: 0, log: () => {}, ...extra,
  };
}
const pairs = list => list.map(({ package: name, tag }) => `${tag} of ${name}`).sort();
const failure = promise => promise.then(() => assert.fail('the promotion went through'), error => error);
const startedAfterFailure = npm => npm.events.slice(npm.events.findIndex(([kind]) => kind === 'fail')).some(([kind]) => kind === 'start');

test('promote moves only the tags not on the version yet and reports how many are', async t => {
  const f = fixture(t), [cli, core] = f.manifest.packages.map(pkg => pkg.name), version = f.expected.version;
  const npm = fakeNpm(f, { onVersion: [[cli, 'testnet'], [cli, 'mainnet'], [core, 'testnet']] });
  const lines = [];
  let asked = 0;
  const askOtp = () => { asked++; return CODE; };
  const progress = await preparedRelease(options(f, npm, { askOtp, log: line => lines.push(line) }));
  assert.equal(progress.alreadyOnVersion, 3);
  assert.deepEqual(pairs(progress.planned), [`latest of ${cli}`, `latest of ${core}`, `mainnet of ${core}`]);
  assert.deepEqual(npm.calls.map(({ args }) => args.slice(2).join(' ')).sort(), [`${cli}@${version} latest`, `${core}@${version} latest`, `${core}@${version} mainnet`].sort());
  assert.ok(lines.includes(`2 packages, tags testnet, mainnet, latest: 3 already on ${version}, 3 to move`), lines.join('\n'));
  assert.deepEqual(progress.remaining, []);
  assert.equal(asked, 0, 'a code passed in is not asked for');
  // Every tag is on the version now: a re-run writes nothing and asks for no code.
  const again = await preparedRelease(options(f, npm, { otp: undefined, askOtp }));
  assert.deepEqual([again.alreadyOnVersion, again.planned, asked, npm.calls.length], [6, [], 0, 3]);
});

test("promote writes eight packages at a time and one package's tags strictly in sequence", async t => {
  const f = packageSet(t), npm = fakeNpm(f);
  const progress = await preparedRelease(options(f, npm));
  assert.equal(progress.completed.length, 36);
  assert.deepEqual(npm.overlaps, [], 'two writes to one package at once');
  assert.equal(npm.busiest, 8);
  for (const pkg of f.manifest.packages) {
    assert.deepEqual(npm.events.filter(([kind, name]) => kind === 'start' && name === pkg.name).map(([, , tag]) => tag), TAGS);
  }
  // The first write goes alone.
  assert.deepEqual(npm.events.filter(([kind]) => kind !== 'read').slice(0, 3).map(([kind]) => kind), ['start', 'end', 'start']);
});

test('a stale code (EOTP) starts no new writes, reports what moved, and a re-run continues', async t => {
  const f = packageSet(t), npm = fakeNpm(f, { fail: ({ index }) => (index > 12 ? 'EOTP' : undefined) });
  const error = await failure(preparedRelease(options(f, npm)));
  assert.match(error.message, /no longer accepts the one-time code \(EOTP at .*fresh code/);
  assert.ok(!startedAfterFailure(npm), 'a write started after npm refused the code');
  const moved = npm.events.filter(([kind]) => kind === 'end').map(([, name, tag]) => `${tag} of ${name}`).sort();
  assert.ok(moved.length >= 12 && moved.length < 36);
  assert.deepEqual(pairs(error.progress.completed), moved);
  assert.equal(error.progress.remaining.length, 36 - moved.length);
  assert.match(error.message, new RegExp(`npm accepted ${moved.length} of 36 tag moves; ${36 - moved.length} tags are not on .*a re-run moves only those`));
  // With a fresh code, the re-run moves exactly what is left.
  npm.fail = () => undefined;
  const progress = await preparedRelease(options(f, npm));
  assert.deepEqual(pairs(progress.planned), pairs(error.progress.remaining));
  assert.deepEqual(progress.remaining, []);
});

test('a rate limit (E429) starts no new writes and says to wait about ten minutes', async t => {
  const f = packageSet(t), npm = fakeNpm(f, { fail: ({ index }) => (index > 4 ? 'E429' : undefined) });
  const error = await failure(preparedRelease(options(f, npm)));
  assert.match(error.message, /rate-limiting one-time codes \(E429 at .*Wait about ten minutes/);
  assert.ok(!startedAfterFailure(npm), 'a write started after the rate limit');
  assert.equal(error.progress.completed.length, npm.events.filter(([kind]) => kind === 'end').length);
  assert.equal(error.progress.remaining.length, 36 - error.progress.completed.length);
});

test('npm refuses a stale or mistyped code once, not once per parallel write', async t => {
  const f = packageSet(t), npm = fakeNpm(f, { fail: () => 'EOTP' });
  await assert.rejects(preparedRelease(options(f, npm)), /EOTP/);
  assert.equal(npm.calls.length, 1);
});

test('the code is asked for after the reads and reaches npm, but never output, errors or arguments', async t => {
  const f = packageSet(t), npm = fakeNpm(f, { fail: ({ index }) => (index > 20 ? 'E409' : undefined) });
  const order = [], lines = [];
  const error = await failure(preparedRelease(options(f, npm, {
    otp: undefined, log: line => lines.push(line),
    readTags: pkg => { order.push('read'); return npm.readTags(pkg); },
    askOtp: async () => { order.push('ask'); return ` ${CODE.slice(0, 3)} ${CODE.slice(3)} `; },
    runner: (...call) => { order.push('write'); return npm.runner(...call); },
  })));
  assert.deepEqual(order.slice(0, 14), [...Array(12).fill('read'), 'ask', 'write']);
  assert.equal(order.filter(step => step === 'ask').length, 1);
  assert.ok(npm.calls.every(({ options: { otp } }) => otp === CODE), 'npm gets the code');
  assert.ok(npm.calls.every(({ args }) => !args.some(arg => arg.includes(CODE))), 'never as an argument');
  assert.match(error.message, /could not move .* \(E409\)/);
  for (const text of [...lines, error.message, error.stack, JSON.stringify(error.progress)]) assert.ok(!text.includes(CODE), text);
});

test('without a code or a terminal, one write fails and says how to give a code', async t => {
  const f = packageSet(t), npm = fakeNpm(f, { fail: () => 'EOTP' });
  await assert.rejects(preparedRelease(options(f, npm, { otp: undefined, askOtp: null })), /npm needs a one-time code \(EOTP at .*in a terminal/);
  assert.equal(npm.calls.length, 1);
  assert.equal(npm.calls[0].options.otp, undefined);
});

test('a typed code that is not 6 to 8 digits moves nothing and is not repeated', async t => {
  const f = fixture(t), npm = fakeNpm(f);
  const error = await failure(preparedRelease(options(f, npm, { otp: undefined, askOtp: () => '91357' })));
  assert.match(error.message, /6 to 8 digits; no tag moved/);
  assert.ok(!error.message.includes('91357'));
  assert.equal(npm.calls.length, 0);
});

test('an integrity mismatch is refused before any dist-tag read, code prompt or write', async t => {
  const f = fixture(t), npm = fakeNpm(f), [, second] = f.manifest.packages;
  let asked = 0;
  await assert.rejects(preparedRelease(options(f, npm, {
    otp: undefined, askOtp: () => { asked++; return CODE; },
    readDist: pkg => ({ integrity: pkg.name === second.name ? 'sha512-different' : pkg.integrity }),
  })), /registry integrity mismatch/);
  assert.deepEqual([npm.events, npm.calls, asked], [[], [], 0]);
});

test('dry-run prints the plan and asks for no code', async t => {
  const f = fixture(t), [cli] = f.manifest.packages.map(pkg => pkg.name), version = f.expected.version;
  const npm = fakeNpm(f, { onVersion: [[cli, 'testnet']] });
  const lines = [];
  let asked = 0;
  const progress = await preparedRelease(options(f, npm, { dryRun: true, otp: undefined, askOtp: () => { asked++; return CODE; }, log: line => lines.push(line) }));
  assert.deepEqual([progress.dryRun, progress.completed, progress.alreadyOnVersion, progress.planned.length, asked, npm.calls.length], [true, [], 1, 5, 0, 0]);
  assert.ok(lines.includes(`Would move mainnet of ${cli} to ${version} (now ${OLD})`), lines.join('\n'));
  assert.ok(!lines.some(line => line.startsWith(`Would move testnet of ${cli} `)));
});

test('a tag write npm accepted but the registry does not show is listed, and the run fails', async t => {
  const f = fixture(t), [, core] = f.manifest.packages.map(pkg => pkg.name), version = f.expected.version;
  const npm = fakeNpm(f, { unshown: [[core, 'mainnet']] });
  const lines = [];
  const error = await failure(preparedRelease(options(f, npm, { log: line => lines.push(line) })));
  assert.match(error.message, /npm accepted every tag write, but the registry does not show 1 of them on /);
  assert.deepEqual(error.progress.remaining, [{ package: core, tag: 'mainnet', now: OLD }]);
  assert.equal(error.progress.completed.length, 6);
  assert.ok(lines.includes(`Not on ${version} yet: mainnet of ${core} is ${OLD}`), lines.join('\n'));
});

test('the code prompt asks, but never shows the typed code', async () => {
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode() { return this; } });
  let shown = '';
  const output = { write: text => { shown += text; return true; } };
  const input = terminal();
  const answer = promptOtp({ input, output });
  input.write(`${CODE}\r`);
  assert.equal(await answer, CODE);
  assert.match(shown, /one-time code/);
  assert.ok(!shown.includes(CODE));
  const interrupted = terminal();
  const cancelled = promptOtp({ input: interrupted, output });
  interrupted.write('\x03');
  await assert.rejects(cancelled, /Cancelled; no tag moved/);
});


test('real npm makes one PUT on HTTP 429 and stops promotion with rate-limit guidance', async t => {
  const f = fixture(t), npm = fakeNpm(f);
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.setHeader('content-type', 'application/json');
    if (request.method === 'PUT') {
      response.writeHead(429);
      response.end(JSON.stringify({ error: 'rate limited' }));
    } else {
      response.end(JSON.stringify(Object.fromEntries(TAGS.map(tag => [tag, OLD]))));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const config = {
    NPM_CONFIG_USERCONFIG: path.join(f.root, 'user.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: path.join(f.root, 'global.npmrc'),
    NPM_CONFIG_CACHE: path.join(f.root, 'npm-cache'),
    NPM_CONFIG_FETCH_RETRIES: '2',
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT: '1',
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT: '1',
  };
  fs.writeFileSync(config.NPM_CONFIG_USERCONFIG, '');
  fs.writeFileSync(config.NPM_CONFIG_GLOBALCONFIG, '');
  const saved = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, config);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const error = await failure(preparedRelease(options(f, npm, {
    runner: undefined,
    registry: `http://127.0.0.1:${server.address().port}`,
  })));
  assert.match(error.message, /E429.*Wait about ten minutes/);
  const puts = requests.filter(request => request.method === 'PUT');
  assert.equal(puts.length, 1, 'inherited npm retry settings must not retry a rate-limited write');
  assert.equal(error.progress.completed.length, 0);
  assert.equal(error.progress.remaining.length, 6);
});

test('changing the certificate during OTP entry rejects promotion before every write', async t => {
  const f = fixture(t), npm = fakeNpm(f);
  await assert.rejects(preparedRelease(options(f, npm, {
    otp: undefined,
    askOtp: () => {
      const receipt = JSON.parse(fs.readFileSync(f.receiptFile, 'utf8'));
      fs.writeFileSync(f.receiptFile, JSON.stringify({ ...receipt, outcome: 'FAIL' }));
      return CODE;
    },
  })), /certification did not pass/);
  assert.equal(npm.calls.length, 0);
});

test('a pending tarball changed after the first write is never promoted and progress stays accurate', async t => {
  const f = packageSet(t), npm = fakeNpm(f), pending = f.manifest.packages[1];
  let changed = false;
  const error = await failure(preparedRelease(options(f, npm, {
    runner: async (...args) => {
      await npm.runner(...args);
      if (!changed) {
        fs.appendFileSync(path.join(f.bundle, pending.tarball), 'changed after first write');
        changed = true;
      }
    },
  })));
  assert.match(error.message, /bundle's tarball .* changed/);
  assert.ok(changed);
  assert.ok(npm.calls.every(({ args }) => args[2] !== `${pending.name}@${pending.version}`));
  const moved = npm.events.filter(([kind]) => kind === 'end').map(([, name, tag]) => `${tag} of ${name}`).sort();
  assert.ok(moved.length > 0);
  assert.deepEqual(pairs(error.progress.completed), moved);
  assert.equal(error.progress.remaining.length, 36 - moved.length);
  assert.equal(error.progress.remaining.filter(({ package: name }) => name === pending.name).length, 3);
});


test('local evidence that changes during OTP entry blocks the first parallel promotion write', async t => {
  const f = fixture(t), npm = fakeNpm(f);
  let valid = true, checks = 0;
  await assert.rejects(preparedRelease(options(f, npm, {
    otp: undefined,
    askOtp: () => { valid = false; return CODE; },
    prepareEvidence: () => { checks++; return { recheckLocalIntegrity: () => assert.ok(valid, 'evidence changed during OTP entry') }; },
  })), /evidence changed during OTP entry/);
  assert.equal(checks, 2);
  assert.equal(npm.calls.length, 0);
});

test('delayed remote qualification finishes before OTP entry and only local checks follow it', async t => {
  const f = fixture(t), npm = fakeNpm(f), events = [];
  await preparedRelease(options(f, npm, {
    otp: undefined,
    prepareEvidence: async () => {
      events.push('acquire');
      await new Promise(resolve => setTimeout(resolve, 20));
      events.push('qualified');
      return { recheckLocalIntegrity: () => events.push('local integrity') };
    },
    askOtp: () => { events.push('otp'); return CODE; },
  }));
  assert.deepEqual(events, ['acquire', 'qualified', 'acquire', 'qualified', 'otp', 'local integrity']);
  assert.ok(npm.calls.length > 0);
});
