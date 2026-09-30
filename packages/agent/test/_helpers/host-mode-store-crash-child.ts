/**
 * Child process for `test/swm/host-mode-store-crash.e2e.test.ts`.
 *
 * Drives a real `SwmHostModeStore` on real files, then SIGKILLs ITSELF at a
 * deterministic point inside one durable write, so the parent can inspect what
 * a `kill -9` (or the process side of a power cut) leaves behind. The kill
 * point is injected by wrapping `fs.promises` (the object the store calls
 * through at call time), not by any hook in production code.
 *
 * Spec (JSON in CRASH_SPEC):
 *   op       prune | meta | append   which durable write the crash lands in
 *   crashAt  mid-write | before-rename | after-rename
 *   dataDir  store directory
 *   cgId     context graph id
 *   ackFile  where to record the seqnos acknowledged BEFORE the crash window
 *
 * Exit 3 means the crash point was never reached (the child survived).
 */
import { promises as fsp, writeFileSync } from 'node:fs';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';

interface CrashSpec {
  op: 'prune' | 'meta' | 'append';
  crashAt: 'mid-write' | 'before-rename' | 'after-rename';
  dataDir: string;
  cgId: string;
  ackFile: string;
}

const spec = JSON.parse(process.env.CRASH_SPEC ?? '{}') as CrashSpec;

const PAYLOAD_BYTES = 64;
const payload = (n: number) => new Uint8Array(PAYLOAD_BYTES).fill(n);

let nowMs = 1_000_000;
const limits = { perCgByteCap: 1024 * 1024, ttlMs: 50_000 };
const store = new SwmHostModeStore({
  dataDir: spec.dataDir,
  unregisteredLimits: limits,
  registeredLimits: limits,
  now: () => nowMs,
});

// The paths a given op's crash may land on.
const WRITE_TARGET: Record<CrashSpec['op'], RegExp> = {
  prune: /\.log(\.tmp-[^/\\]*)?$/,
  meta: /\.meta(\.tmp-[^/\\]*)?$/,
  append: /\.log$/,
};
const RENAME_TARGET: Record<CrashSpec['op'], RegExp> = {
  prune: /\.log$/,
  meta: /\.meta$/,
  append: /\.meta$/,
};

let armed = false;

function firstHalf(data: unknown): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data as Uint8Array);
  return bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
}

async function crashNow(where: string): Promise<never> {
  writeFileSync(`${spec.ackFile}.crash`, where);
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => { /* never resumes */ });
}

function armCrash(): void {
  const real = {
    writeFile: fsp.writeFile.bind(fsp),
    appendFile: fsp.appendFile.bind(fsp),
    open: fsp.open.bind(fsp),
    rename: fsp.rename.bind(fsp),
  };
  const isTarget = (p: unknown) => WRITE_TARGET[spec.op].test(String(p));

  if (spec.crashAt === 'mid-write') {
    // Path-based writes (what a plain writeFile / appendFile does)...
    fsp.writeFile = (async (p: never, data: never, ...rest: never[]) => {
      if (!armed || !isTarget(p)) return (real.writeFile as Function)(p, data, ...rest);
      await (real.writeFile as Function)(p, firstHalf(data));
      return crashNow(`writeFile:${String(p)}`);
    }) as never;
    fsp.appendFile = (async (p: never, data: never, ...rest: never[]) => {
      if (!armed || !isTarget(p)) return (real.appendFile as Function)(p, data, ...rest);
      await (real.appendFile as Function)(p, firstHalf(data));
      return crashNow(`appendFile:${String(p)}`);
    }) as never;
    // ...and handle-based writes (what the temp + fsync + rename path does).
    fsp.open = (async (p: never, ...rest: never[]) => {
      const handle = await (real.open as Function)(p, ...rest);
      if (armed && isTarget(p)) {
        const writeThenDie = (method: 'writeFile' | 'appendFile' | 'write') => {
          const original = handle[method].bind(handle);
          handle[method] = async (data: unknown, ...more: unknown[]) => {
            if (!armed) return original(data, ...more);
            await original(firstHalf(data));
            return crashNow(`${method}:${String(p)}`);
          };
        };
        writeThenDie('writeFile');
        writeThenDie('appendFile');
        writeThenDie('write');
      }
      return handle;
    }) as never;
  } else {
    fsp.rename = (async (from: never, to: never) => {
      if (!armed || !RENAME_TARGET[spec.op].test(String(to))) return (real.rename as Function)(from, to);
      if (spec.crashAt === 'before-rename') return crashNow(`before-rename:${String(to)}`);
      await (real.rename as Function)(from, to);
      return crashNow(`after-rename:${String(to)}`);
    }) as never;
  }
}

async function main(): Promise<void> {
  const acked: number[] = [];
  if (spec.op === 'prune') {
    // 4 entries that will be TTL-expired, then 5 that survive: the pruned log
    // is 5 frames, so a half-written rewrite ends mid-frame.
    for (let i = 1; i <= 4; i += 1) acked.push(await store.append(spec.cgId, payload(i)));
    nowMs = 1_100_000;
    for (let i = 5; i <= 9; i += 1) acked.push(await store.append(spec.cgId, payload(i)));
    nowMs = 1_120_000;
  } else {
    for (let i = 1; i <= 3; i += 1) acked.push(await store.append(spec.cgId, payload(i)));
  }
  writeFileSync(spec.ackFile, JSON.stringify(acked));

  armed = true;
  armCrash();
  if (spec.op === 'prune') await store.prune();
  else if (spec.op === 'meta') await store.markRegistered(spec.cgId);
  else await store.append(spec.cgId, payload(4));

  // The crash point was never reached: report it instead of exiting cleanly.
  writeFileSync(`${spec.ackFile}.survived`, '1');
  process.exit(3);
}

main().catch((err) => {
  writeFileSync(`${spec.ackFile}.error`, String(err?.stack ?? err));
  process.exit(4);
});
