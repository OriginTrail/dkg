#!/usr/bin/env node
// Repository harness: uses the built CLI client after the soak's runtime build.
import { appendFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { constants } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { shareWithClientRule, followShareJob, recoveryWaitSec } from './devnet-soak-rs-share.mjs';

/** Preserve the CLI's structured httpError response; never infer retryability from prose. */
export async function clientAnswer(work) {
  try { return { status: 200, body: await work() }; }
  catch (error) {
    return typeof error?.httpStatus === 'number'
      ? { status: error.httpStatus, body: error.responseBody }
      : { error: error instanceof Error ? error.message : String(error) };
  }
}

async function connectClient(repoRoot, home, auth) {
  const { ApiClient } = await import(pathToFileURL(join(repoRoot, 'packages/cli/dist/api-client.js')).href);
  return ApiClient.connect({ connection: { home, token: auth, port: 'home' } });
}

function publishCli(cli, home, name, contextGraphId, auth, env) {
  const connectionEnv = { ...env, DKG_HOME: home, DKG_AUTH_TOKEN: auth };
  delete connectionEnv.DKG_API_PORT;
  return new Promise(resolveResult => {
    let out = '', settled = false;
    const child = spawn(process.execPath, [cli, 'ka', 'publish', name, '--context-graph-id', contextGraphId], {
      env: connectionEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    });
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { out += data; });
    const finish = result => { if (!settled) { settled = true; resolveResult(result); } };
    child.once('error', error => finish({ rc: 1, out: error.message }));
    child.once('close', (code, signal) => finish({ rc: code ?? (signal && constants.signals[signal] ? 128 + constants.signals[signal] : 1), out: out.trimEnd() + (signal ? `\nCLI stopped: ${signal}` : '') }));
  });
}

/** Stop admitting at endTs (or SIGTERM), then finish and log the active attempt.
 * The parent waits for this promise before reading publish.jsonl or stopping observers. */
export async function runPublisher(options, { now = Date.now, sleep = delay, signal } = {}) {
  const { repoRoot, devnetDir, outDir, cli, intervalSec, endTs, auth, round, env = process.env } = options;
  const file = join(outDir, 'publish.jsonl'); writeFileSync(file, '');
  const budgetMs = recoveryWaitSec(env) * 1000;
  let i = 0;
  while (!signal?.aborted && now() < endTs * 1000) {
    const started = now(), cg = ['devnet-test', 'devnet-isolation'][i % 2], node = i % 4 + 1;
    const home = join(devnetDir, `node${node}`), unique = `${Math.floor(started / 1000)}-${i}-${process.pid}`;
    const subject = `urn:soak:r${round}:i${i}:${unique}`, name = `soak-${round}-${i}-${unique}`;
    const quads = [['predicate', `value-${i}`], ['round', String(round)], ['emittedAt', new Date(started).toISOString().replace('.000Z', 'Z')]]
      .map(([predicate, value]) => ({ subject, predicate: `urn:soak:${predicate}`, object: JSON.stringify(value), graph: '' }));
    const progress = {}, transcript = [];
    const log = line => { transcript.push(line); };
    let rc = 1;
    try {
      const client = await connectClient(repoRoot, home, auth);
      const shared = await shareWithClientRule({ contextGraphId: cg, name, quads, progress, log, sleep,
        create: (...args) => clientAnswer(() => client.createKnowledgeAsset(...args)),
        share: (...args) => clientAnswer(() => client.knowledgeAssetShare(...args)),
        follow: job => followShareJob(job, { budgetMs, log,
          readJob: (reference, options) => client.knowledgeAssetShareJob(reference, options) }),
      });
      if (shared) {
        const result = await publishCli(cli, home, name, cg, auth, env); rc = result.rc; log(result.out);
      }
    } catch (error) { log(`[soak] attempt: ${error instanceof Error ? error.message : String(error)}`); }
    const row = { ts: new Date(now()).toISOString(), cg, node, i, subject, status: rc === 0 ? 'ok' : 'fail', rc,
      share_retries: progress.shareRetries ?? 0, share_recovery: progress.recovery ?? null,
      elapsed_s: Math.floor((now() - started) / 1000), out: transcript.join('\n') };
    appendFileSync(file, JSON.stringify(row) + '\n');
    i += 1;
    if (signal?.aborted || now() >= endTs * 1000) break;
    try { await sleep(intervalSec * 1000, undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [repoRoot, devnetDir, outDir, cli, intervalSec, endTs, auth, round] = process.argv.slice(2);
  const stop = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => stop.abort());
  runPublisher({ repoRoot, devnetDir, outDir, cli, intervalSec: Number(intervalSec), endTs: Number(endTs), auth, round }, { signal: stop.signal })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
