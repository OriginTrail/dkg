import fs from 'node:fs';
import path from 'node:path';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

// A controlled executable exercises the production gh arguments and bytes. A
// missing --paginate deliberately hides later pages, just as the real API does.
export function installGithubFixture(bin, config) {
  fs.mkdirSync(bin, { recursive: true });
  const configFile = path.join(bin, 'github-fixture.json');
  const calls = path.join(bin, 'github-calls.jsonl');
  const script = path.join(bin, 'gh-fixture.cjs');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(script, `const fs = require('node:fs'), path = require('node:path');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] === 'api') {
  const endpoint = args.find(a => a.startsWith('repos/'));
  if (endpoint.endsWith('/workflows/ci.yml/runs')) {
    const pages = args.includes('--paginate') ? config.pages : config.pages.slice(0, 1);
    process.stdout.write(pages.flat().map(row => JSON.stringify(row)).join('\\n'));
  } else {
    const match = endpoint.match(/\\/runs\\/(\\d+)(?:\\/attempts\\/(\\d+))?$/);
    if (!match) throw new Error('unexpected API endpoint: ' + endpoint);
    const value = match[2] ? config.runs[match[1] + '/' + match[2]] : { run_attempt: config.latestAttempt };
    if (!value) throw new Error('unexpected attempt: ' + endpoint);
    process.stdout.write(JSON.stringify(value));
  }
} else if (args[0] === 'run' && args[1] === 'download') {
  if (args[args.indexOf('--name') + 1] !== 'nightly-profile-summary') throw new Error('wrong artifact');
  fs.writeFileSync(path.join(args[args.indexOf('--dir') + 1], 'nightly-profile-summary.json'), config.nightlyBytes);
} else throw new Error('unexpected gh call: ' + args.join(' '));
`);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`, { mode: 0o755 });
  return { calls, update: value => fs.writeFileSync(configFile, JSON.stringify(value)),
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } };
}
