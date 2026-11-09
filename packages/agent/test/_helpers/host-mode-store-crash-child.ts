/**
 * Child process for `test/swm/host-mode-store-crash.e2e.test.ts`.
 *
 * Drives a real `SwmHostModeStore` on real files, then SIGKILLs ITSELF at a
 * deterministic point inside one durable write, so the parent can inspect what
 * a `kill -9` (or the process side of a power cut) leaves behind. The kill
 * point is injected in THIS process only, by wrapping the `fs.promises` calls
 * the store makes at call time; nothing in production code is hooked and the
 * parent is untouched.
 *
 * Spec (JSON in CRASH_SPEC):
 *   op       prune | meta | append   which durable write the crash lands in
 *   crashAt  mid-write | before-rename | after-rename
 *   dataDir  store directory
 *   cgId     context graph id
 *   ackFile  where to record the seqnos acknowledged BEFORE the crash window
 *
 * The fs calls a crash window intercepts (the only ones the store makes on the
 * handles it writes through):
 *   op       mid-write (torn write, half the payload lands)      rename (before / after)
 *   prune    handle.writeFile on the `.log.tmp-*` rewrite         `.log.tmp-*` -> `.log`
 *   meta     handle.writeFile on the `.meta.tmp-*` write          `.meta.tmp-*` -> `.meta`
 *   append   handle.appendFile on the `.log` (the frame)          `.meta.tmp-*` -> `.meta` (the cursor)
 *
 * Exit 3 means the crash point was never reached (the child survived).
 */
import { promises as fsp, writeFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import { payloadFor } from './host-mode-store-crash-fixture.js';

interface CrashSpec {
  op: 'prune' | 'meta' | 'append';
  crashAt: 'mid-write' | 'before-rename' | 'after-rename';
  dataDir: string;
  cgId: string;
  ackFile: string;
}

const spec = JSON.parse(process.env.CRASH_SPEC ?? '{}') as CrashSpec;

let nowMs = 1_000_000;
const limits = { perCgByteCap: 1024 * 1024, ttlMs: 50_000 };
const store = new SwmHostModeStore({
  dataDir: spec.dataDir,
  unregisteredLimits: limits,
  registeredLimits: limits,
  now: () => nowMs,
});

/** The file whose handle's write is torn for a mid-write crash of each op. */
const TORN_WRITE_PATH: Record<CrashSpec['op'], RegExp> = {
  prune: /\.log\.tmp-[^/\\]*$/,
  meta: /\.meta\.tmp-[^/\\]*$/,
  append: /\.log$/,
};
/** The rename destination a before-/after-rename crash of each op lands on. */
const RENAME_DESTINATION: Record<CrashSpec['op'], RegExp> = {
  prune: /\.log$/,
  meta: /\.meta$/,
  append: /\.meta$/,
};

function firstHalf(data: string | Uint8Array): Buffer {
  const bytes = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  return bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
}

async function crashNow(where: string): Promise<never> {
  writeFileSync(`${spec.ackFile}.crash`, where);
  process.kill(process.pid, 'SIGKILL');
  return new Promise<never>(() => { /* never resumes */ });
}

/** `handle.writeFile` writes half its payload, then the process dies (the temp-file writes of prune and meta). */
function tearWriteFile(handle: FileHandle, where: string): void {
  const writeFile = handle.writeFile.bind(handle);
  handle.writeFile = async (data, options) => {
    await writeFile(firstHalf(data), options);
    return crashNow(`writeFile:${where}`);
  };
}

/** `handle.appendFile` appends half its payload, then the process dies (the frame of an append). */
function tearAppendFile(handle: FileHandle, where: string): void {
  const appendFile = handle.appendFile.bind(handle);
  handle.appendFile = async (data, options) => {
    await appendFile(firstHalf(data), options);
    return crashNow(`appendFile:${where}`);
  };
}

/** mid-write: the handle the store opens for this op's write tears its write. */
function armTornWrite(): void {
  const realOpen = fsp.open.bind(fsp);
  const target = TORN_WRITE_PATH[spec.op];
  // The store's `fs.promises` object is shared with this module; typing it as
  // just the member being replaced makes the assignment type-check without a cast.
  const patched: { open: typeof fsp.open } = fsp;
  patched.open = async (path, flags, mode) => {
    const handle = await realOpen(path, flags, mode);
    if (target.test(String(path))) {
      if (spec.op === 'append') tearAppendFile(handle, String(path));
      else tearWriteFile(handle, String(path));
    }
    return handle;
  };
}

/** before-rename / after-rename: die at (or just after) the rename that publishes this op's file. */
function armRenameCrash(): void {
  const realRename = fsp.rename.bind(fsp);
  const destination = RENAME_DESTINATION[spec.op];
  const patched: { rename: typeof fsp.rename } = fsp;
  patched.rename = async (from, to) => {
    if (!destination.test(String(to))) return realRename(from, to);
    if (spec.crashAt === 'after-rename') await realRename(from, to);
    return crashNow(`${spec.crashAt}:${String(to)}`);
  };
}

async function main(): Promise<void> {
  const acked: number[] = [];
  if (spec.op === 'prune') {
    // 4 entries that will be TTL-expired, then 5 that survive: the pruned log
    // is 5 frames, so a half-written rewrite ends mid-frame.
    for (let i = 1; i <= 4; i += 1) acked.push(await store.append(spec.cgId, payloadFor(i)));
    nowMs = 1_100_000;
    for (let i = 5; i <= 9; i += 1) acked.push(await store.append(spec.cgId, payloadFor(i)));
    nowMs = 1_120_000;
  } else {
    for (let i = 1; i <= 3; i += 1) acked.push(await store.append(spec.cgId, payloadFor(i)));
  }
  writeFileSync(spec.ackFile, JSON.stringify(acked));

  // Armed only now, so the setup writes above run untouched.
  if (spec.crashAt === 'mid-write') armTornWrite();
  else armRenameCrash();
  if (spec.op === 'prune') await store.prune();
  else if (spec.op === 'meta') await store.markRegistered(spec.cgId);
  else await store.append(spec.cgId, payloadFor(4));

  // The crash point was never reached: report it instead of exiting cleanly.
  writeFileSync(`${spec.ackFile}.survived`, '1');
  process.exit(3);
}

main().catch((err) => {
  writeFileSync(`${spec.ackFile}.error`, String(err?.stack ?? err));
  process.exit(4);
});
