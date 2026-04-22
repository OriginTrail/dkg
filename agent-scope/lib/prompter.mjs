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

  // Non-blocking: resolves with the next line if one arrives within
  // `timeoutMs`, otherwise null. Used for paste-detection where we want
  // to treat typed-and-Enter input as single-line but still capture
  // pasted multi-line content (terminal pastes deliver each line as a
  // separate `line` event within a few milliseconds).
  const tryReadLine = (timeoutMs) => new Promise(resolve => {
    if (buffered.length) return resolve(buffered.shift());
    if (closed) return resolve(null);
    let settled = false;
    const waiter = (line) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(line);
    };
    waiters.push(waiter);
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = waiters.indexOf(waiter);
      if (idx >= 0) waiters.splice(idx, 1);
      resolve(null);
    }, timeoutMs);
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

  // Read a task description with single-Enter submission and paste
  // detection. Flow:
  //   1. Block for the first non-empty line. Blank lines before any
  //      content are ignored, up to `maxBlankBeforeContent`.
  //   2. After the first line, poll `tryReadLine(pasteQuietMs)` — if
  //      another line arrives inside that window it's part of a multi-
  //      line paste (terminal pastes deliver each line as a separate
  //      `line` event within a few ms). Keep appending; each new line
  //      resets the window.
  //   3. As soon as the quiet window expires with no new line, stop.
  //
  // This means typing one line + Enter submits immediately (no more
  // "press Enter twice"), while a multi-paragraph paste still gets
  // captured in full. Trailing blank lines (common at the end of a
  // paste) are trimmed. Internal blank lines (paragraph breaks) are
  // preserved.
  async function askPasteableDescription(prompt = '> ', {
    pasteQuietMs = 80,
    maxLines = 2000,
    maxBlankBeforeContent = 3,
  } = {}) {
    const lines = [];
    let emptyBeforeContent = 0;

    while (lines.length === 0) {
      const line = await ask(prompt);
      if (line && line.trim().length) { lines.push(line); break; }
      if (++emptyBeforeContent >= maxBlankBeforeContent) return '';
    }

    while (lines.length < maxLines) {
      const next = await tryReadLine(pasteQuietMs);
      if (next === null) break;
      if (next === '') { lines.push(''); continue; }
      lines.push(next);
    }

    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return lines.join('\n');
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

  return {
    ask, askYesNo, askChoice, askMultiNumber, askLines,
    askPasteableDescription, tryReadLine, close,
  };
}
