/**
 * End-to-end crash safety of the SWM host-mode store on real files.
 *
 * A child process (real `SwmHostModeStore`, real fsync/rename, real files)
 * SIGKILLs itself at a deterministic point inside one durable write. The
 * parent then reopens the directory with a fresh store, exactly as a restarted
 * daemon would, and asserts what a hosting core cares about:
 *   - the log has no torn tail and every acknowledged frame is still served,
 *     and every retained envelope is the child's exact payload, byte for byte
 *     (on the raw file, through the store, and page by page);
 *   - the seqno cursor never goes backwards and is never reused;
 *   - a catch-up client paging with strict-greater-than seqnos reaches the end;
 *   - leftover temp files are inert and swept.
 *
 * Kill points are injected by wrapping `fs.promises` in the child (see
 * `test/_helpers/host-mode-store-crash-child.ts`); nothing in production code
 * is hooked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SwmHostModeStore } from '../../src/swm/host-mode-store.js';
import { PAYLOAD_BYTES, RECOVERY_APPEND_FILL, payloadFor } from '../_helpers/host-mode-store-crash-fixture.js';

// Each case boots a tsx child process (about a second) and runs a real fsync-heavy store.
vi.setConfig({ testTimeout: 60_000 });

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHILD = path.join(AGENT_ROOT, 'test/_helpers/host-mode-store-crash-child.ts');
const HEADER_BYTES = 20;
const LIMITS = { perCgByteCap: 1024 * 1024, ttlMs: 50_000 };

type Op = 'prune' | 'meta' | 'append';
type CrashAt = 'mid-write' | 'before-rename' | 'after-rename';

const cgKey = (contextGraphId: string) => createHash('sha256').update(contextGraphId).digest('base64url');

/** Independent walk of the on-disk frames (the store cannot vouch for itself), keeping each payload. */
function parseFrames(buf: Buffer): { seqnos: number[]; payloads: Buffer[]; validLength: number } {
  const seqnos: number[] = [];
  const payloads: Buffer[] = [];
  let offset = 0;
  while (offset + HEADER_BYTES <= buf.length) {
    const len = buf.readUInt32BE(offset + 16);
    const end = offset + HEADER_BYTES + len;
    if (end > buf.length) break;
    seqnos.push(Number(buf.readBigUInt64BE(offset + 8)));
    payloads.push(Buffer.from(buf.subarray(offset + HEADER_BYTES, end)));
    offset = end;
  }
  return { seqnos, payloads, validLength: offset };
}

/**
 * Every frame's ciphertext must be exactly what the child wrote for that seqno
 * (`recoveryFrame` is the one frame the parent appends itself after recovery).
 * Frame lengths, seqnos and paging can all stay valid while the bytes are
 * zeroed or shifted, so this compares the bytes.
 */
function expectPayloadsIntact(
  frames: ReadonlyArray<{ seqno: number; bytes: Uint8Array }>,
  where: string,
  recoveryFrame?: number,
): void {
  for (const { seqno, bytes } of frames) {
    const expected = seqno === recoveryFrame
      ? new Uint8Array(PAYLOAD_BYTES).fill(RECOVERY_APPEND_FILL)
      : payloadFor(seqno);
    expect(Array.from(bytes), `${where}: seqno ${seqno} ciphertext differs from what was written`).toEqual(Array.from(expected));
  }
}

const rawFrames = (log: Buffer) => {
  const parsed = parseFrames(log);
  return parsed.seqnos.map((seqno, i) => ({ seqno, bytes: parsed.payloads[i]! }));
};

async function runCrashChild(spec: {
  op: Op;
  crashAt: CrashAt;
  dataDir: string;
  cgId: string;
  ackFile: string;
}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD], {
      cwd: AGENT_ROOT,
      env: { ...process.env, CRASH_SPEC: JSON.stringify(spec) },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`crash child timed out; stderr=${stderr}`));
    }, 60_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stderr });
    });
  });
}

describe('SwmHostModeStore survives kill -9 inside a durable write (real child process)', () => {
  let root: string;
  let dataDir: string;
  let ackFile: string;
  const cgId = 'curator/crash-e2e';

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dkg-host-store-crash-'));
    dataDir = path.join(root, 'swm-host');
    ackFile = path.join(root, 'acked.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function crash(op: Op, crashAt: CrashAt): Promise<{ acked: number[] }> {
    const result = await runCrashChild({ op, crashAt, dataDir, cgId, ackFile });
    // The crash point must have been reached and the child must really have died.
    const survived = await stat(`${ackFile}.survived`).then(() => true, () => false);
    expect(survived, `crash point ${op}/${crashAt} was never reached; stderr=${result.stderr}`).toBe(false);
    expect(result.code).not.toBe(3);
    expect(result.code).not.toBe(4);
    if (process.platform !== 'win32') expect(result.signal).toBe('SIGKILL');
    return { acked: JSON.parse(await readFile(ackFile, 'utf8')) as number[] };
  }

  const files = async () => (await readdir(dataDir)).sort();
  const logPath = () => path.join(dataDir, `${cgKey(cgId)}.log`);
  const metaPath = () => path.join(dataDir, `${cgKey(cgId)}.meta`);

  /** Reopen like a restarted daemon and check the invariants every crash point must preserve. */
  async function reopenAndVerify(acked: number[], expectedSeqnos: number[], expectedCursorAtLeast: number) {
    const restarted = new SwmHostModeStore({ dataDir, unregisteredLimits: LIMITS, registeredLimits: LIMITS });
    const report = await restarted.reconcileOrphanLogsNow();
    // Startup neither loses the graph's data nor treats its files as orphans/corrupt.
    expect(report.orphanLogsRemoved).toBe(0);
    expect(report.corruptMetasRemoved).toBeUndefined();
    expect((await files()).filter((n) => n.includes('.tmp-'))).toEqual([]);

    // Every frame acknowledged before the crash window that was not pruned away is served,
    // and each one still carries the exact ciphertext the child wrote.
    const servedEntries = await restarted.iterate(cgId, 0);
    expect(servedEntries.map((e) => e.seqno)).toEqual(expectedSeqnos);
    expectPayloadsIntact(servedEntries.map((e) => ({ seqno: e.seqno, bytes: e.envelopeBytes })), 'after restart (store read)');

    // The cursor never goes backwards, even where the log lost its tail...
    const cursor = await restarted.getLastSeqno(cgId);
    expect(cursor).toBeGreaterThanOrEqual(expectedCursorAtLeast);
    expect(cursor).toBeGreaterThanOrEqual(Math.max(...acked));

    // ...and the next append takes a fresh seqno, lands intact, and leaves no torn tail.
    const next = await restarted.append(cgId, new Uint8Array(PAYLOAD_BYTES).fill(0xee));
    expect(next).toBeGreaterThan(cursor);
    expect(next).toBeGreaterThan(Math.max(...acked));
    const log = await readFile(logPath());
    const parsed = parseFrames(log);
    expect(parsed.validLength).toBe(log.length);
    expect(new Set(parsed.seqnos).size).toBe(parsed.seqnos.length);
    expect(parsed.seqnos).toEqual([...parsed.seqnos].sort((a, b) => a - b));
    expect(parsed.seqnos.at(-1)).toBe(next);
    // The file itself, parsed independently of the store: the retained frames are the child's exact
    // bytes and the last one is the frame just appended.
    expectPayloadsIntact(rawFrames(log), 'after restart + append (raw log)', next);

    // A catch-up client paging with strict-greater-than seqnos reaches the end with every frame once,
    // and every page carries the exact ciphertext (headers and paging can be valid over corrupt bytes).
    const paged: number[] = [];
    const pagedFrames: Array<{ seqno: number; bytes: Uint8Array }> = [];
    let since = 0;
    for (;;) {
      const page = await restarted.iterate(cgId, since, 2);
      if (page.length === 0) break;
      paged.push(...page.map((e) => e.seqno));
      pagedFrames.push(...page.map((e) => ({ seqno: e.seqno, bytes: e.envelopeBytes })));
      since = page[page.length - 1].seqno;
    }
    expect(paged).toEqual(parsed.seqnos);
    expectPayloadsIntact(pagedFrames, 'after restart + append (paged catch-up read)', next);

    // The very last frame is the one just appended, byte for byte.
    const last = (await restarted.iterate(cgId, next - 1))[0];
    expect(Array.from(last.envelopeBytes)).toEqual(Array.from({ length: PAYLOAD_BYTES }, () => RECOVERY_APPEND_FILL));
    return { restarted, next };
  }

  describe('prune rewrite (whole-log replace)', () => {
    // 9 frames written (seqnos 1..9), the first 4 are TTL-expired: the pruned log is 5 frames.
    const all = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const pruned = [5, 6, 7, 8, 9];

    it.each<CrashAt>(['mid-write', 'before-rename'])(
      'killed %s: the previous log is intact, no truncated log, temp swept on restart',
      async (crashAt) => {
        const { acked } = await crash('prune', crashAt);
        expect(acked).toEqual(all);
        // What the kill left on disk: the full old log (every frame's exact bytes) plus an inert temp sibling.
        const log = await readFile(logPath());
        expect(parseFrames(log)).toMatchObject({ seqnos: all, validLength: log.length });
        expectPayloadsIntact(rawFrames(log), `prune killed ${crashAt}: the previous log`);
        const leftovers = (await files()).filter((n) => n.includes('.tmp-'));
        expect(leftovers).toHaveLength(1);
        expect(leftovers[0]).toMatch(/\.log\.tmp-/);
        // Where the kill really landed: the temp holds half the pruned log (mid-write) or all of it (before the rename).
        const prunedLog = log.subarray(all.indexOf(pruned[0]!) * (HEADER_BYTES + PAYLOAD_BYTES));
        const temp = await readFile(path.join(dataDir, leftovers[0]!));
        if (crashAt === 'mid-write') {
          expect(temp.length, 'mid-write: the temp is torn, not empty and not complete').toBeGreaterThan(0);
          expect(temp.length).toBeLessThan(prunedLog.length);
          expect(prunedLog.subarray(0, temp.length).equals(temp), 'mid-write: the temp is a prefix of the pruned log').toBe(true);
        } else {
          expect(temp.equals(prunedLog), 'before-rename: the temp is the complete pruned log').toBe(true);
        }

        await reopenAndVerify(acked, all, 9);
      },
    );

    it('killed after the rename: the pruned log is complete and well-formed', async () => {
      const { acked } = await crash('prune', 'after-rename');
      const log = await readFile(logPath());
      expect(parseFrames(log)).toMatchObject({ seqnos: pruned, validLength: log.length });
      // The rewrite kept each surviving frame's ciphertext, not just its header.
      expectPayloadsIntact(rawFrames(log), 'prune killed after the rename: the pruned log');
      expect((await files()).filter((n) => n.includes('.tmp-'))).toEqual([]);

      await reopenAndVerify(acked, pruned, 9);
    });
  });

  describe('metadata write (persistMeta)', () => {
    it.each<CrashAt>(['mid-write', 'before-rename'])(
      'killed %s: the previous meta survives, the graph is not reaped as corrupt, the cursor holds',
      async (crashAt) => {
        const { acked } = await crash('meta', crashAt);
        expect(acked).toEqual([1, 2, 3]);
        // The old meta still parses: registered flag unchanged, cursor intact.
        expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({ seqno: 3, registered: false });
        const leftovers = (await files()).filter((n) => n.includes('.meta.tmp-'));
        expect(leftovers).toHaveLength(1);
        // Where the kill really landed: the temp is half a meta (mid-write) or the complete new one (before the rename).
        const tempText = await readFile(path.join(dataDir, leftovers[0]!), 'utf8');
        if (crashAt === 'mid-write') {
          expect(tempText.length, 'mid-write: the temp is not empty').toBeGreaterThan(0);
          expect(() => JSON.parse(tempText), 'mid-write: the temp is torn JSON').toThrow();
        } else {
          expect(JSON.parse(tempText), 'before-rename: the temp is the complete new meta').toMatchObject({ seqno: 3, registered: true });
        }

        const { restarted } = await reopenAndVerify(acked, [1, 2, 3], 3);
        expect(await restarted.isRegistered(cgId)).toBe(false);
      },
    );

    it('killed after the rename: the new meta is in place', async () => {
      const { acked } = await crash('meta', 'after-rename');
      expect(JSON.parse(await readFile(metaPath(), 'utf8'))).toMatchObject({ seqno: 3, registered: true });

      const { restarted } = await reopenAndVerify(acked, [1, 2, 3], 3);
      expect(await restarted.isRegistered(cgId)).toBe(true);
    });
  });

  describe('append (frame + cursor)', () => {
    it('killed mid-frame: the torn tail is repaired, later appends stay visible, no seqno is reused', async () => {
      const { acked } = await crash('append', 'mid-write');
      expect(acked).toEqual([1, 2, 3]);
      // The crash itself leaves a torn tail: header + half a payload of the 4th frame.
      const log = await readFile(logPath());
      const parsed = parseFrames(log);
      expect(parsed.seqnos).toEqual([1, 2, 3]);
      expect(log.length).toBeGreaterThan(parsed.validLength);

      const { next } = await reopenAndVerify(acked, [1, 2, 3], 3);
      // The killed append was never acknowledged, so its seqno is legitimately taken again.
      expect(next).toBe(4);
    });

    it('killed after the frame fsync but before the cursor rename: the cursor is recovered from the log', async () => {
      const { acked } = await crash('append', 'before-rename');
      // The frame is durable, the meta still says 3.
      expect(parseFrames(await readFile(logPath())).seqnos).toEqual([1, 2, 3, 4]);
      expect(JSON.parse(await readFile(metaPath(), 'utf8')).seqno).toBe(3);

      const { next } = await reopenAndVerify(acked, [1, 2, 3, 4], 4);
      // seqno 4 is in the log, so it must not be handed out again.
      expect(next).toBe(5);
    });

    it('killed after the cursor rename: both files agree', async () => {
      const { acked } = await crash('append', 'after-rename');
      expect(JSON.parse(await readFile(metaPath(), 'utf8')).seqno).toBe(4);

      const { next } = await reopenAndVerify(acked, [1, 2, 3, 4], 4);
      expect(next).toBe(5);
    });
  });
});
