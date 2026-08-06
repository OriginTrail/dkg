import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { pipeOpenClawStream } from '../src/daemon/openclaw.js';

/**
 * Regression coverage for the SSE terminal-frame contract in the shared local
 * agent stream proxy.
 *
 * The bug this pins: the proxy used to run until the UPSTREAM socket reached
 * EOF. `final` is the terminal SEMANTIC event, and a bridge is entitled to hold
 * its connection open after emitting it — Prime Agent does. The downstream
 * browser response then stayed open, the composer kept spinning after the
 * answer had already rendered, and the agent's turn lock looked held.
 */

function makeRes() {
  const res = new EventEmitter() as any;
  res.writableEnded = false;
  res.chunks = [] as string[];
  res.write = (chunk: Uint8Array | string) => {
    res.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  res.end = () => { res.writableEnded = true; };
  return res;
}

/** Sentinel for "upstream really did reach EOF" in a frame list. */
const EOF = Symbol('eof');

function makeReader(frames: Array<string | typeof EOF>) {
  const state = { cancelled: 0, released: 0, reads: 0 };
  let index = 0;
  const reader = {
    read: async () => {
      state.reads += 1;
      if (index >= frames.length) {
        // The bridge has said everything it is going to say but keeps the
        // socket open — it never resolves `done`. This is precisely the case
        // the old EOF-driven loop hung on, so a test that reaches here and
        // still expects the pipe to settle will time out rather than pass.
        return new Promise<{ done: boolean; value?: Uint8Array }>(() => {});
      }
      const frame = frames[index++];
      if (frame === EOF) return { done: true, value: undefined };
      return { done: false, value: Buffer.from(frame) };
    },
    cancel: async () => { state.cancelled += 1; return undefined; },
    releaseLock: () => { state.released += 1; },
  };
  return { reader, state };
}

describe('local-agent SSE proxy: terminal frame handling', () => {
  it('closes downstream and cancels upstream on a final frame, without waiting for EOF', async () => {
    const req = new EventEmitter() as any;
    const res = makeRes();
    const { reader, state } = makeReader([
      'data: {"type":"delta","text":"He"}\n\n',
      'data: {"type":"final","text":"Hello!","correlationId":"c1"}\n\n',
    ]);

    // No timeout guard needed: if the terminal frame is missed, `read()` never
    // resolves again and this await hangs the test — which is the failure the
    // regression is about.
    await pipeOpenClawStream(req, res, reader);

    expect(res.writableEnded).toBe(true);
    expect(state.cancelled).toBe(1);
    expect(state.released).toBe(1);
    // Every byte still reached the browser before we closed.
    expect(res.chunks.join('')).toContain('"type":"final"');
    expect(res.chunks.join('')).toContain('"type":"delta"');
  });

  it('detects a final frame split across chunk boundaries', async () => {
    const req = new EventEmitter() as any;
    const res = makeRes();
    const { reader, state } = makeReader([
      'data: {"type":"fin',
      'al","text":"Hello!"}',
      '\n\n',
    ]);

    await pipeOpenClawStream(req, res, reader);

    expect(res.writableEnded).toBe(true);
    expect(state.cancelled).toBe(1);
  });

  it('keeps streaming while only deltas have arrived', async () => {
    const req = new EventEmitter() as any;
    const res = makeRes();
    const { reader, state } = makeReader([
      'data: {"type":"delta","text":"a"}\n\n',
      'data: {"type":"delta","text":"b"}\n\n',
      EOF,
    ]);

    await pipeOpenClawStream(req, res, reader);

    // Deltas are not terminal, so the pump ran to real EOF and left closing the
    // response to the route — which is where the trailing error frame is
    // written on failure paths.
    expect(res.writableEnded).toBe(false);
    expect(state.cancelled).toBe(0);
    expect(res.chunks).toHaveLength(2);
  });

  it('never treats a non-JSON data frame as terminal', async () => {
    const req = new EventEmitter() as any;
    const res = makeRes();
    // A heartbeat comment, and a plain-text frame that merely contains the word.
    const { reader, state } = makeReader([': keep-alive\n\n', 'data: final\n\n', EOF]);

    await pipeOpenClawStream(req, res, reader);

    expect(res.writableEnded).toBe(false);
    expect(state.cancelled).toBe(0);
  });

  it('does not double-end a response the caller already closed', async () => {
    const req = new EventEmitter() as any;
    const res = makeRes();
    let endCalls = 0;
    res.end = () => { endCalls += 1; res.writableEnded = true; };
    const { reader } = makeReader(['data: {"type":"final","text":"done"}\n\n']);

    await pipeOpenClawStream(req, res, reader);

    expect(endCalls).toBe(1);
  });
});
