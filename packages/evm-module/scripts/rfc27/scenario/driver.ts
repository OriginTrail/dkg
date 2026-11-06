// The scenario's command line, bundled to one file. See README.md in this directory.
//
//   driver.cjs public   --out <file>[,<file>]
//   driver.cjs setup    [--send] --out <file>[,<file>]     the funder's key and endpoint from the environment
//   driver.cjs tick     --beacon <name> [--public <file>]  what a beacon's timer runs
//   driver.cjs status   [--epoch <e>] --public <file>      read-only: the chain against the plan
//   driver.cjs fork-run --rpc <url> --epochs <n> [--stride <n>] [--log <file>]

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ethers } from 'ethers';

import { errorMessage } from '../contracts';
import { Redactor } from '../report';

import { RetryingProvider, chainNow, checkChain, resolveContracts } from './chain';
import type { Fields, Log } from './chain';
import { FIRST_EPOCH, PUBLIC_RPC, SELLERS, sellerNamed } from './config';
import type { SellerName } from './config';
import { forkRun } from './fork-run';
import { seedFromHex } from './keys';
import { publicFile, readPublicFile, writePublicFile } from './public';
import { runSetup } from './setup';
import { runTick } from './tick';
import type { TickState } from './tick';
import { checkEpoch, readEpoch } from './verify';

const DIR = path.join(os.homedir(), '.rfc27-scenario');
const STOP_FILE = path.join(DIR, 'stop');
const LOG_DIR = path.join(DIR, 'logs');
const STATE_FILE = path.join(DIR, 'state.json');
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 3;
/** A tick that takes this long stops itself, so that it never holds the lock for the next. */
const TICK_LIMIT_MS = 270_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const paths = (v: string | undefined): string[] => (v ?? '').split(',').filter(Boolean);

function readSeed(): Uint8Array {
  return seedFromHex(fs.readFileSync(path.join(DIR, 'seed'), 'utf8'));
}

const json = (o: unknown): string => JSON.stringify(o, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

/** A log of JSON lines in a file of bounded size: past the limit it rotates, and keeps a few. */
class FileLog implements Log {
  private readonly file: string;

  constructor(
    name: string,
    private readonly also: (s: string) => void = () => undefined,
  ) {
    fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    this.file = path.join(LOG_DIR, name);
    this.rotate();
  }

  private rotate(): void {
    try {
      if (fs.statSync(this.file).size < LOG_MAX_BYTES) return;
    } catch {
      return;
    }
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      if (fs.existsSync(`${this.file}.${i}`)) fs.renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    fs.renameSync(this.file, `${this.file}.1`);
  }

  event(kind: string, fields: Fields = {}): void {
    const line = json({ at: new Date().toISOString(), kind, ...fields });
    fs.appendFileSync(this.file, `${line}\n`);
    this.also(line);
  }
}

/** What a tick keeps between runs: a small file, written whole. */
class FileState implements TickState {
  private data: { retry: number | null; held: number[] } = { retry: null, held: [] };

  constructor() {
    try {
      this.data = { ...this.data, ...(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<FileState['data']>) };
    } catch {
      // none yet, or lost: one extra landing at most
    }
  }

  private save(): void {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  }

  retryLanding = (e: number): boolean => this.data.retry === e;
  setRetryLanding = (e: number, on: boolean): void => {
    const next = on ? e : null;
    if (this.data.retry !== next) {
      this.data.retry = next;
      this.save();
    }
  };
  heldDone = (e: number): boolean => this.data.held.includes(e);
  markHeldDone = (e: number): void => {
    this.data.held.push(e);
    this.save();
  };
}

/** A beacon's tick. It never fails the timer: whatever goes wrong is logged, and the next tick goes on. */
async function tick(): Promise<void> {
  const beacon = arg('beacon') as SellerName | undefined;
  if (!beacon || !SELLERS.some((s) => s.name === beacon)) throw new Error('--beacon <name> is required');
  if (fs.existsSync(STOP_FILE)) return;
  const log = new FileLog('tick.jsonl', flag('stdout') ? (s) => console.log(s) : undefined);
  const startedAt = Date.now();
  const limit = setTimeout(() => {
    log.event('tick-over-time', { limitMs: TICK_LIMIT_MS });
    process.exit(0);
  }, TICK_LIMIT_MS);
  limit.unref();
  try {
    if (!os.hostname().endsWith(beacon)) throw new Error(`this host is ${os.hostname()}, not ${beacon}`);
    const provider = new RetryingProvider(arg('rpc') ?? PUBLIC_RPC);
    const seed = readSeed();
    const seller = new ethers.Wallet(fs.readFileSync(path.join(DIR, 'seller.key'), 'utf8').trim(), provider);
    if (seller.address !== sellerNamed(beacon).address) throw new Error(`this beacon's seller key is ${seller.address}, not the seller of ${beacon}`);
    const pub = readPublicFile(arg('public') ?? path.join(DIR, 'public.json'));
    const c = await resolveContracts(provider);
    await checkChain(provider, c);
    await runTick({
      provider,
      c,
      seed,
      pub,
      beacon,
      seller,
      signerOf: (w) => w.connect(provider),
      log,
      state: new FileState(),
      sender: { provider, log, waitMs: 90_000 },
    });
    log.event('tick-done', { beacon, ms: Date.now() - startedAt });
  } catch (e: unknown) {
    log.event('tick-error', { beacon, error: errorMessage(e).slice(0, 500) });
  }
}

/** The funder's setup. The key and the endpoint come from the environment, and never reach the output. */
async function setup(): Promise<void> {
  const key = process.env.EVM_PRIVATE_KEY_BASE_SEPOLIA_V10;
  const url = process.env.RPC_BASE_SEPOLIA_V10;
  if (!key || !url) throw new Error('the funder key and the endpoint must be in the environment');
  const redact = new Redactor();
  redact.add(key);
  redact.add(url);
  const print = (s: string) => console.log(redact.redact(s));
  const log: Log = { event: (kind, fields = {}) => print(json({ kind, ...fields })) };
  const provider = new RetryingProvider(url);
  const c = await resolveContracts(provider);
  await checkChain(provider, c);
  // The funder's key sends plain transfers only: nothing here calls the Hub with it, read or write.
  const funder = new ethers.Wallet(key, provider);
  const seed = readSeed();
  try {
    const r = await runSetup({
      provider,
      c,
      seed,
      funder,
      signerOf: (w) => w.connect(provider),
      log,
      sender: { provider, log },
      sendTransactions: flag('send'),
      journalFile: path.join(DIR, 'setup-journal.json'),
      publicOut: paths(arg('out')),
    });
    print(json({ kind: 'setup-result', complete: r.complete, accountIds: r.accountIds, spentEth: ethers.formatEther(r.spentEth), spentTrac: ethers.formatEther(r.spentTrac) }));
  } catch (e: unknown) {
    print(`setup stopped: ${errorMessage(e)}`);
    process.exitCode = 1;
  }
}

async function status(): Promise<void> {
  const seed = readSeed();
  const pub = readPublicFile(arg('public') ?? path.join(DIR, 'public.json'));
  const provider = new RetryingProvider(arg('rpc') ?? PUBLIC_RPC);
  const c = await resolveContracts(provider);
  const current = Number(await c.chronos.getCurrentEpoch());
  const now = await chainNow(provider);
  const from = Number(arg('epoch') ?? Math.max(FIRST_EPOCH, current - 1));
  const to = arg('epoch') ? from : current;
  for (let e = from; e <= to; e++) {
    if (e < FIRST_EPOCH) continue;
    const n = await readEpoch(c, e);
    console.log(json({ ...n, nodes: undefined }));
    for (const node of n.nodes) console.log(`  ${json(node)}`);
    const checks = await checkEpoch(c, seed, pub, e, e < current, now);
    const failed = checks.filter((x) => !x.ok);
    console.log(`  checks ${checks.length}, failed ${failed.length}`);
    for (const f of failed) console.log(`  FAIL ${f.what}${f.detail ? `: ${f.detail}` : ''}`);
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'tick') return tick();
  if (cmd === 'public') {
    const out = paths(arg('out'));
    if (out.length === 0) throw new Error('--out <file>[,<file>] is required');
    writePublicFile(publicFile(readSeed()), out);
    return undefined;
  }
  if (cmd === 'setup') return setup();
  if (cmd === 'status') return status();
  if (cmd === 'fork-run') {
    const ok = await forkRun({
      url: arg('rpc') ?? 'http://127.0.0.1:8545',
      seed: readSeed(),
      epochs: Number(arg('epochs') ?? 5),
      logFile: arg('log') ?? path.join(os.tmpdir(), `rfc27-scenario-fork-${Date.now()}.jsonl`),
      stride: Number(arg('stride') ?? 1),
    });
    process.exitCode = ok ? 0 : 1;
    return undefined;
  }
  throw new Error(`unknown command ${cmd}`);
}

main()
  .catch((e: unknown) => {
    console.error(errorMessage(e));
    if (process.argv[2] !== 'tick') process.exitCode = 1;
  })
  .finally(() => {
    if (process.argv[2] === 'tick') process.exit(0);
  });
