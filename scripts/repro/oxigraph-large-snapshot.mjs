#!/usr/bin/env node
// Real default-worker regression for #3291. Requires built storage packages.
// Default fixture: 558 MB, > V8's 536,870,888-character string ceiling. This
// deliberately uses few long values; it is not a many-million-quad benchmark.
// Owns only a temporary directory and its two child processes. No network.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const count = 9_000;
const value = 'x'.repeat(62_000);
const sentinel = { subject: 'urn:after-load', predicate: 'urn:p', object: '"durable"', graph: 'urn:g' };
const modulePath = resolve(process.argv[2] ?? fileURLToPath(new URL('../../packages/storage/dist/index.js', import.meta.url)));

if (process.argv[3] === '--child') {
  const { OxigraphWorkerStore } = await import(pathToFileURL(modulePath).href);
  const store = new OxigraphWorkerStore(process.argv[4], { operationTimeoutMs: 180_000 });
  try {
    const reopen = process.argv[5] === 'reopen';
    assert.equal(await store.countQuads(), count + (reopen ? 1 : 0));
    if (!reopen) {
      await store.insert([sentinel]);
      await store.flush();
      process.send({ stage: 'flushed', rss: process.memoryUsage().rss });
      // Parent kills this process without close(), so the worker cannot save it.
      await new Promise(() => {});
    } else {
      assert.deepEqual(await store.query('ASK { GRAPH <urn:g> { <urn:after-load> <urn:p> "durable" } }'), { type: 'boolean', value: true });
      await store.close();
      process.send({ stage: 'reopened', rss: process.memoryUsage().rss });
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
} else {
  const started = performance.now();
  const dir = await mkdtemp(join(tmpdir(), 'dkg-3291-native-'));
  const path = join(dir, 'store.nq');
  const children = new Set();
  try {
    const fh = await open(path, 'w');
    try {
      for (let n = 0; n < count; n++) {
        await fh.writeFile(`<urn:s:${n}> <urn:p> "${value}${n}" <urn:g> .\n`);
      }
      await fh.sync();
    } finally { await fh.close(); }
    const initialBytes = (await stat(path)).size;
    assert.ok(initialBytes > 536_870_888, 'fixture must exceed the actual V8 string ceiling');
    console.log(JSON.stringify({ phase: 'seeded', bytes: initialBytes, quads: count }));
    const run = (phase) => new Promise((resolveRun, reject) => {
      const child = fork(fileURLToPath(import.meta.url), [modulePath, '--child', path, phase], {
        execArgv: ['--max-old-space-size=2048'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      children.add(child);
      let evidence;
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 240_000);
      child.on('message', (message) => {
        evidence = message;
        console.log(JSON.stringify({ phase, ...message }));
        if (phase === 'first' && message.stage === 'flushed') child.kill('SIGKILL');
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        const expected = phase === 'first'
          ? signal === 'SIGKILL' && evidence?.stage === 'flushed'
          : code === 0 && evidence?.stage === 'reopened';
        if (timedOut || !expected) reject(new Error(`${phase}: code=${code} signal=${signal} timedOut=${timedOut}`));
        else resolveRun(evidence);
      });
    });
    await run('first');
    // Check every persisted value without materializing the file or trusting counts.
    const seen = new Set();
    let sawSentinel = false;
    for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
      if (line === '<urn:after-load> <urn:p> "durable" <urn:g> .') { sawSentinel = true; continue; }
      const id = Number(/^<urn:s:(\d+)>/.exec(line)?.[1]);
      assert.ok(Number.isInteger(id) && id >= 0 && id < count && !seen.has(id));
      assert.equal(line, `<urn:s:${id}> <urn:p> "${value}${id}" <urn:g> .`);
      seen.add(id);
    }
    assert.equal(seen.size, count);
    assert.equal(sawSentinel, true);
    await run('reopen');
    console.log(JSON.stringify({ passed: true, bytes: (await stat(path)).size, exactValuesVerified: seen.size + 1, killedAfterFlush: true, seconds: (performance.now() - started) / 1000 }));
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
}
