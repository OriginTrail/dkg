// Unit tests for the tiny prompter. Focuses on the paste-detection
// primitives used by `pnpm task start --smart`'s description reader —
// i.e. the `tryReadLine(timeoutMs)` helper and its interaction with
// the blocking `ask()` path.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createPrompter } from './prompter.mjs';

function makePrompter() {
  const input = new PassThrough();
  const output = new PassThrough();
  // Drain output so writes don't back-pressure the PassThrough.
  output.on('data', () => {});
  const p = createPrompter({ input, output });
  return { p, input, output };
}

function feed(input, line) { input.write(`${line}\n`); }

test('tryReadLine: buffered line resolves synchronously (same tick)', async () => {
  const { p, input } = makePrompter();
  feed(input, 'first');
  // Give the readline transform a tick to push the line event.
  await new Promise(r => setImmediate(r));
  const got = await p.tryReadLine(500);
  assert.equal(got, 'first');
  p.close();
});

test('tryReadLine: returns null after timeout when no input', async () => {
  const { p } = makePrompter();
  const t0 = Date.now();
  const got = await p.tryReadLine(60);
  const elapsed = Date.now() - t0;
  assert.equal(got, null);
  // Should settle promptly — allow generous slack for slow CI.
  assert.ok(elapsed >= 55, `expected >=55ms, got ${elapsed}`);
  assert.ok(elapsed <= 400, `expected <=400ms, got ${elapsed}`);
  p.close();
});

test('tryReadLine: resolves when line arrives inside the window', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => feed(input, 'late-but-not-too-late'), 20);
  const got = await p.tryReadLine(200);
  assert.equal(got, 'late-but-not-too-late');
  p.close();
});

test('tryReadLine: does NOT steal from later waiters after timeout', async () => {
  const { p, input } = makePrompter();

  // First call times out because nothing arrives.
  const first = await p.tryReadLine(40);
  assert.equal(first, null);

  // Now a real line arrives — it should route to the next reader,
  // not some ghost of the timed-out waiter.
  feed(input, 'hello');
  const got = await p.tryReadLine(200);
  assert.equal(got, 'hello');
  p.close();
});

test('tryReadLine: resolves null once the stream has been closed', async () => {
  const { p, input } = makePrompter();
  input.end();
  // Let the readline 'close' event propagate.
  await new Promise(r => setImmediate(r));
  const got = await p.tryReadLine(100);
  assert.equal(got, null);
  p.close();
});

test('ask + tryReadLine compose: first line blocks, then we poll the tail', async () => {
  const { p, input } = makePrompter();

  // Mimic the smart-mode description reader: block for the first line,
  // then collect any immediately-following lines (paste-detection).
  setTimeout(() => {
    feed(input, 'line A');
    feed(input, 'line B');
    feed(input, 'line C');
  }, 5);

  const first = await p.ask('> ');
  const more = [];
  for (;;) {
    const next = await p.tryReadLine(40);
    if (next === null) break;
    more.push(next);
  }
  assert.equal(first, 'line A');
  assert.deepEqual(more, ['line B', 'line C']);
  p.close();
});

test('ask returns blank when stream closes with no input', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => input.end(), 10);
  const got = await p.ask('> ');
  assert.equal(got, '');
  p.close();
});

// --- askPasteableDescription: single-Enter submission + paste detection ---

test('askPasteableDescription: single line + one Enter submits immediately', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => feed(input, 'Refactor peer sync for workspace auth'), 5);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 40 });
  assert.equal(got, 'Refactor peer sync for workspace auth');
  p.close();
});

test('askPasteableDescription: multi-line paste is captured in full', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => {
    feed(input, 'line one');
    feed(input, 'line two');
    feed(input, 'line three');
  }, 5);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 60 });
  assert.equal(got, 'line one\nline two\nline three');
  p.close();
});

test('askPasteableDescription: blank line in middle of paste is preserved', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => {
    feed(input, 'paragraph 1');
    feed(input, '');
    feed(input, 'paragraph 2');
  }, 5);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 60 });
  assert.equal(got, 'paragraph 1\n\nparagraph 2');
  p.close();
});

test('askPasteableDescription: trailing blank lines are trimmed', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => {
    feed(input, 'content');
    feed(input, '');
    feed(input, '');
  }, 5);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 50 });
  assert.equal(got, 'content');
  p.close();
});

test('askPasteableDescription: leading blanks ignored up to maxBlankBeforeContent', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => {
    feed(input, '');
    feed(input, '');
    feed(input, 'finally');
  }, 5);
  const got = await p.askPasteableDescription('> ', {
    pasteQuietMs: 50,
    maxBlankBeforeContent: 5,
  });
  assert.equal(got, 'finally');
  p.close();
});

test('askPasteableDescription: bails empty-string after maxBlankBeforeContent', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => {
    feed(input, '');
    feed(input, '');
    feed(input, '');
  }, 5);
  const got = await p.askPasteableDescription('> ', {
    pasteQuietMs: 50,
    maxBlankBeforeContent: 3,
  });
  assert.equal(got, '');
  p.close();
});

test('askPasteableDescription: late-arriving line INSIDE quiet window is appended', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => feed(input, 'first'), 5);
  setTimeout(() => feed(input, 'second (just inside window)'), 40);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 100 });
  assert.equal(got, 'first\nsecond (just inside window)');
  p.close();
});

test('askPasteableDescription: line arriving AFTER quiet window is NOT appended', async () => {
  const { p, input } = makePrompter();
  setTimeout(() => feed(input, 'only this'), 5);
  // Give enough time for the first read + the quiet window to elapse
  // before sending the second line.
  setTimeout(() => feed(input, 'too late, separate turn'), 200);
  const got = await p.askPasteableDescription('> ', { pasteQuietMs: 40 });
  assert.equal(got, 'only this');
  p.close();
});

test('askPasteableDescription: respects maxLines cap on a runaway paste', async () => {
  const { p, input } = makePrompter();
  // Keep feeding lines forever (every few ms) — cap stops the reader.
  let i = 0;
  const iv = setInterval(() => feed(input, `L${i++}`), 5);
  try {
    const got = await p.askPasteableDescription('> ', {
      pasteQuietMs: 40,
      maxLines: 5,
    });
    const lines = got.split('\n');
    assert.equal(lines.length, 5);
    assert.ok(lines.every(l => /^L\d+$/.test(l)), `unexpected lines: ${got}`);
  } finally {
    clearInterval(iv);
    p.close();
  }
});
