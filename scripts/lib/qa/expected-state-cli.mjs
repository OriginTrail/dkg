#!/usr/bin/env node
// Wait for a list of expected reads on a running devnet (see expected-state.mjs).
//
//   node scripts/lib/qa/expected-state-cli.mjs <expectations.json>
//     [--devnet-dir .devnet] [--api-port-base 9201] [--timeout-s 300] [--interval-s 3] [--out results.json]
//
// Prints one line per expectation. Exit 0: all met. 1: a valid read showed
// another state at the deadline. 2: an unmet expectation was never validly
// read, or the arguments or the file are unusable.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  awaitExpectations, describeResult, expectationsExit, queryFor, validateExpectations,
} from './expected-state.mjs';

function parseArgs(argv) {
  const options = { devnetDir: '.devnet', apiPortBase: 9201, timeoutS: 300, intervalS: 3, out: null, file: null };
  const names = { '--devnet-dir': 'devnetDir', '--api-port-base': 'apiPortBase', '--timeout-s': 'timeoutS', '--interval-s': 'intervalS', '--out': 'out' };
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]];
    if (key) {
      if (i + 1 >= argv.length) throw new Error(`${argv[i]} needs a value`);
      options[key] = argv[++i];
    } else if (argv[i].startsWith('--')) throw new Error(`unknown option ${argv[i]}`);
    else if (options.file === null) options.file = argv[i];
    else throw new Error(`unexpected argument ${argv[i]}`);
  }
  if (options.file === null) throw new Error('an expectations file is required');
  for (const key of ['apiPortBase', 'timeoutS', 'intervalS']) {
    const value = Number(options[key]);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive number`);
    options[key] = value;
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const expectations = validateExpectations(JSON.parse(readFileSync(options.file, 'utf8')));
  const tokens = new Map();
  const tokenOf = node => {
    if (!tokens.has(node)) {
      const lines = readFileSync(join(options.devnetDir, `node${node}`, 'auth.token'), 'utf8').split('\n');
      tokens.set(node, lines.map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? '');
    }
    return tokens.get(node);
  };
  const read = async expectation => {
    const response = await fetch(`http://127.0.0.1:${options.apiPortBase + expectation.node - 1}/api/query`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokenOf(expectation.node)}`, 'content-type': 'application/json' },
      body: JSON.stringify(queryFor(expectation)),
      signal: AbortSignal.timeout(20_000),
    });
    return { transportExit: 0, httpStatus: response.status, body: await response.text() };
  };
  const results = await awaitExpectations({
    expectations, read, now: Date.now, sleep: delay,
    timeoutMs: options.timeoutS * 1000, intervalMs: options.intervalS * 1000,
  });
  for (const result of results) console.log(describeResult(result));
  if (options.out) {
    writeFileSync(options.out, `${JSON.stringify(results.map(({ expectation, met, afterMs, polls, last }) => ({
      label: expectation.label, node: expectation.node, contextGraphId: expectation.contextGraphId,
      view: expectation.view, subject: expectation.subject, expected: expectation.values,
      ...(expectation.tolerated?.length ? { tolerated: expectation.tolerated } : {}), met, afterMs, polls, last,
    })), null, 2)}\n`);
  }
  process.exitCode = expectationsExit(results);
} catch (error) {
  console.error(`expected-state: ${error.message}`);
  process.exitCode = 2;
}
