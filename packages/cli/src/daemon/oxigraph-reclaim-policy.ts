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
 *   - it runs this node's Oxigraph for this store (the recorded or current
 *     binary, or another `oxigraph*` executable in a known binary directory),
 *     no live recorded owner exists, and its parent is gone: it was
 *     reparented to PID 1 or its parent has exited. This covers an orphan
 *     from an earlier release, which has no record.
 * While the recorded daemon and launcher both still run, every holder is left
 * alone. So is every holder when the record exists but cannot be read, or
 * when a probe cannot tell whether a recorded owner or the holder's parent
 * still runs: only a confirmed exit counts as gone.
 */
import { isCatalogedOxigraph, type OxigraphBinaryCatalog } from './oxigraph-binary.js';
import type {
  IdentityState,
  OxigraphOwnerRecordRead,
  OxigraphOwnerRecordV1,
} from './oxigraph-owner-record.js';
import { oxigraphStoreArgs } from './oxigraph-store-launch.js';
import type { ProcessInstance } from './process-probe.js';

/**
 * Whether a process runs a known Oxigraph binary with this store's
 * arguments. Exact argv (from `/proc`) is compared token by token; a binary
 * started through an interpreter (`#!`) has the interpreter first. Where only
 * `ps` display text exists, argv boundaries are lost, so the text is compared
 * only when neither the store path nor a known binary path contains
 * whitespace; otherwise the answer is `ambiguous`.
 */
export function matchManagedOxigraphStore(
  holder: Pick<ProcessInstance, 'argv' | 'command'>,
  location: string,
  binaries: OxigraphBinaryCatalog,
): 'match' | 'no-match' | 'ambiguous' {
  let tokens = holder.argv;
  if (tokens === null) {
    if ([location, ...binaries.paths, ...binaries.dirs].some((value) => /\s/.test(value))) {
      return 'ambiguous';
    }
    tokens = holder.command.split(' ');
  }
  const storeArgs = oxigraphStoreArgs(location);
  for (let at = 0; at + storeArgs.length < tokens.length; at++) {
    if (isCatalogedOxigraph(binaries, tokens[at]) && storeArgs.every((arg, offset) => tokens![at + 1 + offset] === arg)) {
      return 'match';
    }
  }
  return 'no-match';
}

/**
 * Who owns the store now. `unknown` (a record that could not be read, or a
 * recorded owner whose state could not be read) leaves every holder running.
 */
export type Ownership =
  | { kind: 'unrecorded' }
  | { kind: 'invalid-record' }
  | { kind: 'unknown'; reason: string }
  | { kind: 'owners-live'; record: OxigraphOwnerRecordV1 }
  | { kind: 'owner-gone'; record: OxigraphOwnerRecordV1; gone: { role: 'daemon' | 'launcher'; pid: number } };

/** Whether the recorded daemon and launcher still run; checked for a v1 record only. */
export interface RecordedOwnerStates {
  daemon: IdentityState;
  launcher: IdentityState;
}

/**
 * Ownership from the record and the states of its daemon and launcher. One
 * confirmed exit is enough to call the owner gone; otherwise an owner whose
 * state could not be read makes the ownership unknown. A malformed record is
 * ignored, as if there were none; an unreadable one is not.
 */
export function deriveOwnership(
  read: OxigraphOwnerRecordRead,
  states: RecordedOwnerStates | null,
): Ownership {
  if (read.kind === 'absent') return { kind: 'unrecorded' };
  if (read.kind === 'invalid') return { kind: 'invalid-record' };
  if (read.kind === 'unreadable') {
    return { kind: 'unknown', reason: `the owner record could not be read: ${read.reason}` };
  }
  const { record } = read;
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

// Levels between a launcher and Oxigraph: the watchdog, or systemd-run then
// the watchdog; setpriv and its shell exec into Oxigraph in place.
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
  ctx: { location: string; ownership: Ownership; binaries: OxigraphBinaryCatalog },
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
  const recordedOxigraph = ownership.kind === 'owner-gone' ? ownership.record.oxigraph : undefined;
  if (ownership.kind === 'owner-gone' && recordedOxigraph !== undefined
    && recordedOxigraph.pid === holder.pid && recordedOxigraph.start === holder.start) {
    return { action: 'stop', reason: { kind: 'owner-gone', ...ownership.gone } };
  }
  const match = matchManagedOxigraphStore(holder, ctx.location, ctx.binaries);
  if (match === 'ambiguous') return { action: 'leave', reason: { kind: 'argv-ambiguous' } };
  if (match === 'no-match') return { action: 'leave', reason: { kind: 'not-this-store' } };
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
