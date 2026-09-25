/**
 * Which holders of a managed Oxigraph store's lock may be stopped. Pure: it
 * decides from explicit observations (the holder, its ancestors, the owner
 * record and whether the recorded processes still run) and returns a typed
 * decision; the reaper (`oxigraph-orphan.ts`) gathers them and signals.
 *
 * A holder is stopped only when
 *   - the recorded daemon or launcher has exited and the holder is the
 *     recorded Oxigraph (same PID and start time), whatever process adopted
 *     it (PID 1, a subreaper, a stopped watchdog), or, for a launch killed
 *     before it was ready, a descendant of the recorded launcher (direct, or
 *     through a systemd scope) that runs this node's Oxigraph for this store;
 *     or
 *   - it runs this node's Oxigraph for this store (the recorded binary, the
 *     current binary or the `oxigraph` on PATH, or a pinned `oxigraph-vX.Y.Z`
 *     in the managed binary cache), no live recorded owner exists, and its
 *     parent is gone: it was reparented to PID 1 or its parent has exited.
 *     This covers an orphan from an earlier release, which has no record.
 * While the recorded daemon and launcher both still run, every holder is left
 * alone. So is every holder when the record exists but cannot be read, or
 * when a probe cannot tell whether a recorded owner or the holder's parent
 * still runs: only a confirmed exit counts as gone.
 */
import { basename, dirname, resolve } from 'node:path';
import { isPinnedOxigraphFile, type OxigraphBinaryLocations } from './oxigraph-binary.js';
import type {
  IdentityState,
  OxigraphOwnerRecordRead,
  OxigraphOwnerRecordV1,
} from './oxigraph-owner-record.js';
import { oxigraphStoreArgs } from './oxigraph-store-launch.js';
import type { ProcessInstance } from './process-probe.js';

// Holders are judged against the binaries the binary module reports
// (`OxigraphBinaryLocations`): exact binaries, and pinned releases in the
// managed cache by that module's naming rule. Nothing else counts.

/**
 * Exactly one binary, for a caller without resolved binary locations: no
 * directory is taken for the managed cache unless the binary module says so.
 */
export function oxigraphBinaryCatalog(path: string): OxigraphBinaryLocations {
  return { exact: [path], cacheDir: null };
}

/** `catalog` plus one more exact binary (a recorded binary, say). */
export function withOxigraphBinary(catalog: OxigraphBinaryLocations, path: string): OxigraphBinaryLocations {
  return { ...catalog, exact: [...catalog.exact, path] };
}

/** Whether `executable` is one of the catalog's Oxigraph binaries. */
export function isCatalogedOxigraph(catalog: OxigraphBinaryLocations, executable: string): boolean {
  if (catalog.exact.includes(executable)) return true;
  return catalog.cacheDir !== null
    && resolve(dirname(executable)) === resolve(catalog.cacheDir)
    && isPinnedOxigraphFile(basename(executable));
}

// Interpreters a catalogued Oxigraph script may run under (`#!`): the
// interpreter is the executable, and the script is its first argument.
const SCRIPT_INTERPRETERS = new Set(['node', 'nodejs', 'sh', 'bash', 'dash']);

/**
 * Whether a process runs a known Oxigraph binary with this store's
 * arguments: the binary must be the executable (argv[0]), or the script
 * right after a known interpreter, followed by `serve --location <store>`.
 * A catalogued path that merely appears among another program's arguments
 * does not count. Exact argv (from `/proc`) is compared token by token.
 * Where only `ps` display text exists, argv boundaries are lost, so the text
 * is compared only when neither the store path nor a known binary path
 * contains whitespace; otherwise the answer is `ambiguous`.
 */
export function matchManagedOxigraphStore(
  holder: Pick<ProcessInstance, 'argv' | 'command'>,
  location: string,
  binaries: OxigraphBinaryLocations,
): 'match' | 'no-match' | 'ambiguous' {
  let tokens = holder.argv;
  if (tokens === null) {
    if ([location, ...binaries.exact, binaries.cacheDir ?? ''].some((value) => /\s/.test(value))) {
      return 'ambiguous';
    }
    tokens = holder.command.split(' ');
  }
  const executable = SCRIPT_INTERPRETERS.has(basename(tokens[0] ?? '')) ? 1 : 0;
  const storeArgs = oxigraphStoreArgs(location);
  const serves = tokens[executable] !== undefined
    && isCatalogedOxigraph(binaries, tokens[executable])
    && storeArgs.every((arg, offset) => tokens![executable + 1 + offset] === arg);
  return serves ? 'match' : 'no-match';
}

/**
 * Who owns the store now. `unknown` (a record that could not be read, or a
 * recorded owner whose state could not be read) leaves every holder running.
 */
export type Ownership =
  | { kind: 'unrecorded' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'owners-live'; record: OxigraphOwnerRecordV1 }
  | { kind: 'owner-gone'; record: OxigraphOwnerRecordV1; gone: { role: 'daemon' | 'launcher'; pid: number } };

/** Whether the recorded daemon and launcher still run; checked for a v1 record only. */
export interface RecordedOwnerStates {
  daemon: IdentityState;
  launcher: IdentityState;
}

/**
 * Ownership from the record, the states of its daemon and launcher, and the
 * current boot (null when it could not be read). One confirmed exit is enough
 * to call the owner gone; otherwise an owner whose state could not be read
 * makes the ownership unknown. A malformed record is ignored, as if there
 * were none; an unreadable one is not. A record from an earlier boot is
 * ignored too: its PIDs and start times may name unrelated processes now, so
 * only the command and parent rules apply. When the current boot cannot be
 * read, a record cannot be matched to it, and the ownership is unknown.
 */
export function deriveOwnership(
  read: OxigraphOwnerRecordRead,
  states: RecordedOwnerStates | null,
  currentBoot: string | null,
): Ownership {
  if (read.kind === 'absent') return { kind: 'unrecorded' };
  // Content that is not a v1 record says nothing about the owner (the
  // reaper logs it); the reclaim proceeds as if there were no record.
  if (read.kind === 'invalid') return { kind: 'unrecorded' };
  if (read.kind === 'unreadable') {
    return { kind: 'unknown', reason: `the owner record could not be read: ${read.reason}` };
  }
  const { record } = read;
  if (currentBoot === null) {
    return { kind: 'unknown', reason: 'could not read this host\'s boot identifier to match the owner record' };
  }
  if (record.boot !== currentBoot) return { kind: 'unrecorded' };
  if (!states) return { kind: 'unknown', reason: 'the recorded owners were not checked' };
  for (const role of ['daemon', 'launcher'] as const) {
    if (states[role].state === 'gone') {
      return { kind: 'owner-gone', record, gone: { role, pid: record[role].pid } };
    }
  }
  for (const role of ['daemon', 'launcher'] as const) {
    const state = states[role];
    if (state.state === 'unknown') {
      return {
        kind: 'unknown',
        reason: `could not tell whether the recorded ${role} pid ${record[role].pid} ` +
          `is still running: ${state.reason}`,
      };
    }
  }
  return { kind: 'owners-live', record };
}

export type StopReason =
  | { kind: 'owner-gone'; role: 'daemon' | 'launcher'; pid: number }
  | { kind: 'reparented-to-init' }
  | { kind: 'parent-exited'; ppid: number };

export type LeaveReason =
  | { kind: 'owners-live'; daemonPid: number; launcherPid: number }
  | { kind: 'ownership-unknown'; reason: string }
  | { kind: 'parent-unknown'; ppid: number; reason: string }
  | { kind: 'not-this-store' }
  | { kind: 'argv-ambiguous' }
  | { kind: 'parent-alive'; ppid: number; parentCommand: string; recorded: boolean };

export type HolderDecision =
  | { action: 'stop'; reason: StopReason }
  | { action: 'leave'; reason: LeaveReason };

export function describeStop(reason: StopReason): string {
  switch (reason.kind) {
    case 'owner-gone': return `its recorded ${reason.role} pid ${reason.pid} has exited`;
    case 'reparented-to-init': return 'it was reparented to PID 1';
    case 'parent-exited': return `its parent pid ${reason.ppid} has exited`;
  }
}

export function describeLeave(reason: LeaveReason): string {
  switch (reason.kind) {
    case 'owners-live':
      return `this store's recorded daemon pid ${reason.daemonPid} and launcher pid ` +
        `${reason.launcherPid} are still running`;
    case 'ownership-unknown':
      return `its owner could not be determined (${reason.reason})`;
    case 'parent-unknown':
      return `could not tell whether its parent pid ${reason.ppid} is still running (${reason.reason})`;
    case 'not-this-store':
      return `it is not this node's Oxigraph serving this store`;
    case 'argv-ambiguous':
      return 'this platform shows no exact argv, and the store or binary path contains ' +
        'whitespace, so its command line cannot be matched reliably';
    case 'parent-alive':
      return `${reason.recorded ? 'it is not the Oxigraph recorded for this store' : 'there is no owner record'}, ` +
        `and its parent pid ${reason.ppid} is still running: ${reason.parentCommand.slice(0, 200)}`;
  }
}

/**
 * Why a holder the reaper left running may still be this node's Oxigraph
 * holding the store: judged and left for another reason than not being it,
 * its signal refused, or it could not be re-checked or inspected.
 */
export type HolderBlock =
  | { kind: 'left'; reason: Exclude<LeaveReason, { kind: 'not-this-store' }> }
  | { kind: 'signal-refused' }
  | { kind: 'unconfirmed'; reason: string }
  | { kind: 'uninspectable'; reason: string };

/**
 * Why the store may still be held by this node's Oxigraph after a reclaim.
 * Nothing may be launched over it: the launch would fail on the lock, and
 * recording it would replace the owner record a later reclaim needs.
 */
export type StoreHold =
  | { kind: 'holders-unlisted' }
  | { kind: 'holders-left'; holders: ReadonlyArray<{ pid: number; block: HolderBlock }> }
  | { kind: 'not-confirmed-gone'; pids: readonly number[] };

/**
 * What a holder left for `reason` means for a launch: only one that is not
 * this node's Oxigraph for this store (a backup tool reading LOCK, say)
 * leaves the store free.
 */
export function leaveBlock(reason: LeaveReason): HolderBlock | null {
  return reason.kind === 'not-this-store' ? null : { kind: 'left', reason };
}

export function describeHolderBlock(block: HolderBlock): string {
  switch (block.kind) {
    case 'left': return describeLeave(block.reason);
    case 'signal-refused': return 'its signal was refused';
    case 'unconfirmed': return `it could not be re-checked before its signal (${block.reason})`;
    case 'uninspectable': return `it could not be inspected (${block.reason})`;
  }
}

export function describeStoreHold(hold: StoreHold): string {
  switch (hold.kind) {
    case 'holders-unlisted': return 'its lock holders could not be listed';
    case 'holders-left':
      return hold.holders.map(({ pid, block }) => `pid ${pid}: ${describeHolderBlock(block)}`).join('; ');
    case 'not-confirmed-gone': return `orphaned Oxigraph pid ${hold.pids.join(', ')} was not confirmed gone`;
  }
}

// Levels between a recorded launcher and Oxigraph. The launcher is the
// watchdog (`systemd-run --scope` execs it in place), and setpriv and its
// shell exec into Oxigraph in place, so Oxigraph is its child; the rest is
// headroom for a wrapper between them.
export const MAX_LAUNCHER_DEPTH = 4;

/** One lock holder as observed: the holder and its ancestors, nearest first. */
export interface HolderObservation {
  holder: ProcessInstance;
  /**
   * The holder's parent, its parent and so on, up to MAX_LAUNCHER_DEPTH,
   * stopping before PID 1.
   */
  ancestors: readonly ProcessInstance[];
  /**
   * Why the walk stopped: it reached PID 1 or MAX_LAUNCHER_DEPTH
   * (`complete`), the next ancestor has exited (`gone`), or the next
   * ancestor could not be read (`unknown`).
   */
  ancestryEnd: { state: 'complete' } | { state: 'gone' } | { state: 'unknown'; reason: string };
}

export function classifyHolder(
  { holder, ancestors, ancestryEnd }: HolderObservation,
  ctx: { location: string; ownership: Ownership; binaries: OxigraphBinaryLocations },
): HolderDecision {
  const { ownership } = ctx;
  if (ownership.kind === 'owners-live') {
    return {
      action: 'leave',
      reason: {
        kind: 'owners-live',
        daemonPid: ownership.record.daemon.pid,
        launcherPid: ownership.record.launcher.pid,
      },
    };
  }
  if (ownership.kind === 'unknown') {
    return { action: 'leave', reason: { kind: 'ownership-unknown', reason: ownership.reason } };
  }
  const match = matchManagedOxigraphStore(holder, ctx.location, ctx.binaries);
  if (match === 'ambiguous') return { action: 'leave', reason: { kind: 'argv-ambiguous' } };
  if (match === 'no-match') return { action: 'leave', reason: { kind: 'not-this-store' } };
  // The recorded Oxigraph, whatever adopted it. Its PID and start time are
  // not proof on their own: a start time repeats within its resolution (a
  // second for `ps`), so the command must be this node's Oxigraph for this
  // store as well.
  const recordedOxigraph = ownership.kind === 'owner-gone' ? ownership.record.oxigraph : undefined;
  if (ownership.kind === 'owner-gone' && recordedOxigraph !== undefined
    && recordedOxigraph.pid === holder.pid && recordedOxigraph.start === holder.start) {
    return { action: 'stop', reason: { kind: 'owner-gone', ...ownership.gone } };
  }
  // A launch killed before it was ready: its watchdog is alive but cannot
  // act (frozen, wedged), and the daemon that recorded it is gone.
  if (ownership.kind === 'owner-gone') {
    const { launcher } = ownership.record;
    const recordedLauncher = ancestors.find((ancestor) => ancestor.pid === launcher.pid);
    if (recordedLauncher?.start === launcher.start) {
      return { action: 'stop', reason: { kind: 'owner-gone', ...ownership.gone } };
    }
  }
  if (holder.ppid === 1) return { action: 'stop', reason: { kind: 'reparented-to-init' } };
  const parent = ancestors[0];
  if (parent === undefined) {
    // Only a confirmed exit of the parent frees the holder; a parent that
    // could not be read may still own it.
    if (ancestryEnd.state === 'gone') {
      return { action: 'stop', reason: { kind: 'parent-exited', ppid: holder.ppid } };
    }
    return {
      action: 'leave',
      reason: {
        kind: 'parent-unknown',
        ppid: holder.ppid,
        reason: ancestryEnd.state === 'unknown' ? ancestryEnd.reason : 'it was not observed',
      },
    };
  }
  return {
    action: 'leave',
    reason: {
      kind: 'parent-alive',
      ppid: holder.ppid,
      parentCommand: parent.command,
      recorded: ownership.kind === 'owner-gone',
    },
  };
}
