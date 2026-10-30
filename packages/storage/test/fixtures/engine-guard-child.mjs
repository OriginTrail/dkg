// A child process of oxigraph-engine-guard.test.ts: what it exercises can stop a
// process, and an engine flag stays set for the rest of a process's life.
//
// It forces the optimizing compiler to inline a call into WebAssembly, then
// invalidates the optimized code during that call, so that the code deoptimizes
// when the call returns. The engine then rebuilds the call's result, which it can
// only do for a reference from
// https://github.com/v8/v8/commit/a7ea17f9df401a7db6e6c7f33783c3d7b05c0fb6 on.
//
// Run it with --allow-natives-syntax --no-maglev --no-lazy-feedback-allocation
// (the compiler only runs when it's told to, on what it has seen) and one JSON argument:
//   call: 'externref'  a WebAssembly function that returns a reference
//         'i32'        one that returns a number, which every engine handles
//         'quad-getter' Oxigraph's real Quad.object getter, which the store reads quads through
//   store: 'none'              this package is not loaded
//          'loaded'            this package is loaded, with no store open, as on another backend
//          'before-optimizing' an embedded store opens in this thread before the code is optimized
//          'after-optimizing'  it opens only after that
//          'store-thread'      a store worker thread opens one before that, as in a daemon
//   thread: true               all of it runs on a worker thread, as the store does
//   inliningOff: true          the inlining is turned off directly first, with no store involved
//
// It prints one JSON line. A process the engine stopped prints none.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const TURBOFANNED = 1 << 6;
// Written this way so that this file also parses without --allow-natives-syntax, as a linter reads it.
const prepareForOptimization = new Function('fn', '%PrepareFunctionForOptimization(fn)');
const optimizeOnNextCall = new Function('fn', '%OptimizeFunctionOnNextCall(fn)');
const optimizationStatus = new Function('fn', 'return %GetOptimizationStatus(fn)');

// (module (import "env" "cb" (func $cb)) (func (export "f") (result <kind>) call $cb <value>))
function wasmBytes(call) {
  const section = (id, content) => [id, content.length, ...content];
  const type = call === 'externref' ? [0x60, 0x00, 0x01, 0x6f] : [0x60, 0x00, 0x01, 0x7f];
  const body = call === 'externref' ? [0x00, 0x10, 0x00, 0xd0, 0x6f, 0x0b] : [0x00, 0x10, 0x00, 0x41, 0x07, 0x0b];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [0x02, 0x60, 0x00, 0x00, ...type]),
    ...section(2, [0x01, 0x03, 0x65, 0x6e, 0x76, 0x02, 0x63, 0x62, 0x00, 0x00]),
    ...section(3, [0x01, 0x01]),
    ...section(7, [0x01, 0x01, 0x66, 0x00, 0x01]),
    ...section(10, [0x01, body.length, ...body]),
  ]);
}

// Optimized code depends on this field staying constant, so changing it invalidates that code.
const held = { limit: 1 };
let invalidateDuringCall = false;
function duringCall() {
  if (!invalidateDuringCall) return;
  invalidateDuringCall = false;
  held.limit = 2;
}

function callIntoWasm(call) {
  const { f } = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes(call)), { env: { cb: duringCall } }).exports;
  return function hot() {
    const result = f();
    return result === null ? held.limit : result + held.limit;
  };
}

function callQuadGetter() {
  const oxigraph = createRequire(fileURLToPath(new URL('../../src/', import.meta.url)))('oxigraph');
  const store = new oxigraph.Store();
  store.load('<urn:s> <urn:p> "o" .', { format: 'application/n-quads' });
  const [quad] = store.match();
  // The getter's WebAssembly calls back into this to make the term it returns.
  const wrap = oxigraph.Literal.__wrap;
  oxigraph.Literal.__wrap = (pointer) => {
    duringCall();
    return wrap(pointer);
  };
  return function hot() {
    return quad.object === null ? -1 : held.limit;
  };
}

async function scenario({ call, store, inliningOff }) {
  if (inliningOff) v8.setFlagsFromString('--no-turbo-inline-js-wasm-calls');
  const storage = store === 'none' ? null : await import(new URL('../../dist/index.js', import.meta.url).href);
  let storeThread = null;
  if (store === 'store-thread') {
    storeThread = new storage.OxigraphWorkerStore();
    // Answered only once that thread has opened its store.
    await storeThread.query('ASK { ?s ?p ?o }');
  }
  if (store === 'before-optimizing') new storage.OxigraphStore();

  const hot = call === 'quad-getter' ? callQuadGetter() : callIntoWasm(call);
  prepareForOptimization(hot);
  hot();
  hot();
  optimizeOnNextCall(hot);
  hot();
  const optimized = Boolean(optimizationStatus(hot) & TURBOFANNED);

  if (store === 'after-optimizing') new storage.OxigraphStore();

  invalidateDuringCall = true;
  const value = hot();
  const deoptimized = !(optimizationStatus(hot) & TURBOFANNED);
  await storeThread?.close();
  return { optimized, deoptimized, value };
}

if (isMainThread) {
  const options = JSON.parse(process.argv[2]);
  // A daemon keeps its log by wrapping this: a line a store thread writes must reach the wrapper.
  const lines = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return write(chunk, ...rest);
  };
  const result = options.thread
    ? await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./engine-guard-child.mjs', import.meta.url), { workerData: options });
      worker.once('message', resolve);
      worker.once('error', reject);
    })
    : await scenario(options);
  // A worker thread's stderr arrives here a little later.
  const end = Date.now() + 2_000;
  while (options.store !== 'none' && options.store !== 'loaded' && !lines.some((line) => line.includes('[oxigraph]')) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  console.log(JSON.stringify({ ...result, logged: lines.join('').split('\n').filter((line) => line.startsWith('[oxigraph]')) }));
} else {
  parentPort.postMessage(await scenario(workerData));
}
