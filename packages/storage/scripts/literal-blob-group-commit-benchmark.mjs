// Compare blob layouts using the same worker/index/changelog workload as #3405.
// Arguments: checkout-root label round. BENCH_BLOB_PERSISTENCE=sqlite-wal selects
// the candidate. BENCH_ENTROPY=random / BENCH_READ_MODE=hydrate expand controls.
// BENCH_WRITER_INTERVAL_MS paces each writer; unpaced throughput is the default.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import {loadavg,freemem,totalmem} from 'node:os';
const [root, label, round = '0'] = process.argv.slice(2);
const api = await import(pathToFileURL(join(root, 'packages/storage/dist/index.js')).href);
const N = Number(process.env.BENCH_N ?? 160);
const concurrencyValues = (process.env.BENCH_CONCURRENCY ?? '1,8').split(',').map(Number);
const kinds = (process.env.BENCH_KINDS ?? 'small,replay,fresh,mixed').split(',');
const seedGraph = 'urn:bench:seed';
const blobGraph = 'urn:bench:cg/_shared_memory';
const big = process.env.BENCH_ENTROPY === 'random' ? randomBytes(60 * 1024).toString('base64') : 'x'.repeat(80 * 1024);
const replayTerm = JSON.stringify(big + ':replay');
const quantile = (a, q) => a.length ? [...a].sort((x, y) => x-y)[Math.min(a.length-1, Math.floor(a.length*q))] : null;
const stats = a => ({ n:a.length, p50:quantile(a,.5),p95:quantile(a,.95),p99:quantile(a,.99),max:a.length?a.reduce((max,value)=>Math.max(max,value),-Infinity):null });
const source = 'pr3405-perf-review';
const readMode = process.env.BENCH_READ_MODE ?? 'small';
const readSparql = readMode === 'hydrate'
  ? `SELECT ?value WHERE { GRAPH <${blobGraph}> { <urn:warm:blob> <urn:p> ?value } }`
  : `SELECT ?s WHERE { GRAPH <${seedGraph}> { ?s ?p ?o } } LIMIT 1`;
for (const concurrency of concurrencyValues) for (const kind of kinds) {
  const dir = await realpath(await mkdtemp(join(tmpdir(),'dkg-pr3405-bench-')));
  const store = await api.createTripleStore({ backend:'oxigraph-worker', options:{path:join(dir,'store.nq')}, graphSetIndex:true, changelog:true,
    largeLiteralStorage:{directory:join(dir,'blobs'),thresholdBytes:65_536,persistence:process.env.BENCH_BLOB_PERSISTENCE} });
  let running = false;
  const reads = [], writes = [], smallWrites = [], largeWrites = [], readFailures = [];
  const loopDelay = monitorEventLoopDelay({resolution:10});
  try {
    await store.insert(Array.from({length:1000},(_,i)=>({subject:`urn:seed:${i}`,predicate:'urn:p',object:'"seed"',graph:seedGraph})),{source});
    const coldStart = performance.now();
    await store.insert([{subject:'urn:warm:blob',predicate:'urn:p',object:replayTerm,graph:blobGraph}],{source});
    const coldBlobMs = performance.now()-coldStart;
    const make = (i, warm=false) => {
      const isLarge = kind !== 'small' && (kind !== 'mixed' || i%4===0);
      return { isLarge, quad:{subject:`urn:${warm?'warm':'write'}:${i}`,predicate:'urn:p',
        object:isLarge?(kind==='replay'?replayTerm:JSON.stringify(big+':'+round+':'+i+':'+warm)):'"small"',
        graph:isLarge?blobGraph:'urn:bench:small'} };
    };
    for(let i=0;i<12;i++) await store.insert([make(i,true).quad],{source});
    await store.flush();
    const before = await store.countQuads();
    const beforeSmall = await store.countQuads('urn:bench:small');
    const beforeLarge = await store.countQuads(blobGraph);
    const reader = async () => {
      while(running) {
        const t = performance.now();
        try {
          const result = await store.query(readSparql,{source:'pr3405-perf-read'});
          assert.equal(result.type,'bindings'); assert.equal(result.bindings.length,1); if(readMode==='hydrate')assert.equal(result.bindings[0].value,replayTerm);
          reads.push(performance.now()-t);
        } catch(e) { readFailures.push(String(e)); }
        await new Promise(setImmediate);
      }
    };
    let next=0;
    running=true; loopDelay.enable();
    const readers=[reader(),reader()];
    const started=performance.now();
    await Promise.all(Array.from({length:concurrency},async()=>{
      for(;;) {
        if(process.env.BENCH_WRITER_INTERVAL_MS)await new Promise(resolve=>setTimeout(resolve,Number(process.env.BENCH_WRITER_INTERVAL_MS)));
        const i=next++; if(i>=N) return;
        const {isLarge,quad}=make(i);
        const t=performance.now();
        await store.insert([quad],{source});
        const elapsed=performance.now()-t;
        writes.push(elapsed); (isLarge?largeWrites:smallWrites).push(elapsed);
      }
    }));
    const elapsedMs=performance.now()-started;
    running=false; await Promise.all(readers); loopDelay.disable();
    assert.equal(readFailures.length,0,readFailures.join('; '));
    assert.equal(writes.length,N);
    assert.ok(await store.countQuads() >= before+N);
    const expectedLarge = kind === 'small' ? 0 : kind === 'mixed' ? Math.ceil(N/4) : N;
    assert.equal(await store.countQuads('urn:bench:small'), beforeSmall+N-expectedLarge);
    assert.equal(await store.countQuads(blobGraph), beforeLarge+expectedLarge);
    console.log(JSON.stringify({label,round,kind,concurrency,N,readMode,entropy:process.env.BENCH_ENTROPY??'repeated',writerIntervalMs:Number(process.env.BENCH_WRITER_INTERVAL_MS??0),coldBlobMs,elapsedMs,writesPerSecond:N*1000/elapsedMs,
      writeMs:stats(writes),smallWriteMs:stats(smallWrites),largeWriteMs:stats(largeWrites),readMs:stats(reads),
      host:{loadavg:loadavg(),freeMemory:freemem(),totalMemory:totalmem()},eventLoopMs:{p99:loopDelay.percentile(99)/1e6,max:loopDelay.max/1e6},node:process.version,platform:process.platform}));
  } finally {
    running=false; loopDelay.disable(); await store.close(); await rm(dir,{recursive:true,force:true});
  }
}