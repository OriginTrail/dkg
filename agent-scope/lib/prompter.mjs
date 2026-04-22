// Tiny interactive-prompter built on readline. Zero external deps so it
// works from a freshly-cloned repo. The CLI uses it for `pnpm task start`;
// it's also exported in case anyone wants to drop another wizard on top.
//
// Design rules:
//   - Every prompt has a default that's used on blank input.
//   - Nothing here mutates global state (process.stdin etc.) — the input/
//     output streams are injectable so tests can feed canned stdin.
//   - `close()` is safe to call multiple times.

import { createInterface } from 'node:readline';

export function createPrompter({
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const rl = createInterface({ input, output, terminal: false });
  const buffered = [];
  const waiters = [];
  let closed = false;

  rl.on('line', line => {
    if (waiters.length) waiters.shift()(line);
    else buffered.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()('');
  });

  const readLine = () => new Promise(r => {
    if (buffered.length) return r(buffered.shift());
    if (closed) return r('');
    waiters.push(r);
  });

  const write = (s) => { try { output.write(s); } catch { /* ignore */ } };

  async function ask(prompt, { default: dflt = '' } = {}) {
    write(prompt);
    const line = await readLine();
    const v = (line ?? '').trim();
    return v.length ? v : dflt;
  }

  async function askYesNo(prompt, { default: dflt = true } = {}) {
    const tag = dflt ? '[Y/n]' : '[y/N]';
    const ans = (await ask(`${prompt} ${tag} `)).toLowerCase();
    if (!ans) return dflt;
    if (/^y(es)?$/.test(ans)) return true;
    if (/^n(o)?$/.test(ans))  return false;
    return dflt;
  }

  async function askChoice(prompt, options, { default: dflt } = {}) {
    // options: [{ key, label }]
    const byKey = new Map(options.map(o => [o.key.toLowerCase(), o]));
    const display = options
      .map(o => (o.key === dflt ? o.key.toUpperCase() : o.key))
      .join('/');
    for (const o of options) write(`  [${o.key}] ${o.label}\n`);
    const ans = (await ask(`Choice [${display}]: `)).toLowerCase();
    if (!ans && dflt) return dflt;
    if (byKey.has(ans)) return byKey.get(ans).key;
    return dflt || options[0].key;
  }

  // Reads a list of integers (1-based) entered space- or comma-separated.
  // Returns a de-duped sorted array of indices within [1, count].
  async function askMultiNumber(prompt, count, { default: dflt = [] } = {}) {
    const defaultStr = dflt.length ? dflt.join(' ') : '';
    const raw = await ask(prompt, { default: defaultStr });
    if (!raw) return [];
    if (/^none$/i.test(raw) || /^-$/.test(raw)) return [];
    const nums = raw
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(s => parseInt(s, 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= count);
    return [...new Set(nums)].sort((a, b) => a - b);
  }

  // Read free-text lines until a blank line. Useful for "extra globs".
  async function askLines(headline, { hint } = {}) {
    if (headline) write(headline + '\n');
    if (hint) write(`  (${hint})\n`);
    const lines = [];
    for (;;) {
      write('  > ');
      const line = await readLine();
      if (line === null || line === undefined) break;
      const v = line.trim();
      if (!v) break;
      lines.push(v);
    }
    return lines;
  }

  function close() { try { rl.close(); } catch { /* ignore */ } }

  return { ask, askYesNo, askChoice, askMultiNumber, askLines, close };
}
