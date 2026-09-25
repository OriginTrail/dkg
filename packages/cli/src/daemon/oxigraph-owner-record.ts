/**
 * The owner record of a managed Oxigraph store: `dkg-oxigraph-owner.json` in
 * the store directory. Right after each spawn the daemon records itself, the
 * spawned launcher and the binary; once Oxigraph is verified ready it adds
 * Oxigraph. Each process is a PID plus start time, so a recycled PID never
 * matches. The orphan reclaim reads it to tell an ownerless lock holder from
 * one a live daemon still owns.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomicWith } from './fs-utils.js';
import { processInspector, type ProcessInspector } from './process-probe.js';

export const OXIGRAPH_OWNER_RECORD = 'dkg-oxigraph-owner.json';
export const OXIGRAPH_OWNER_RECORD_SCHEMA = 'dkg-oxigraph-owner/v1';

export interface ProcessIdentity {
  pid: number;
  /** Token from the platform's process start-time probe. */
  start: string;
}

export interface OxigraphOwnerRecordV1 {
  schema: typeof OXIGRAPH_OWNER_RECORD_SCHEMA;
  daemon: ProcessIdentity;
  /** The spawned child: the parent watchdog, or Oxigraph itself. */
  launcher: ProcessIdentity;
  /** Added once the launch is verified ready. */
  oxigraph?: ProcessIdentity;
  binaryPath: string;
}

/**
 * What the store directory says about its owner: no record, content that is
 * not a v1 record, a record that exists but could not be read, or a record.
 */
export type OxigraphOwnerRecordRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'v1'; record: OxigraphOwnerRecordV1 };

/**
 * Whether a recorded process instance still runs. A PID that now names
 * another process (another start time) is `gone`; a failed read is
 * `unknown`, never `gone`.
 */
export type IdentityState =
  | { state: 'running' }
  | { state: 'gone' }
  | { state: 'unknown'; reason: string };

const inspectProcess = processInspector(process.platform);

function ownerRecordPath(location: string): string {
  return join(resolve(location), OXIGRAPH_OWNER_RECORD);
}

function isIdentity(value: unknown): value is ProcessIdentity {
  const identity = value as ProcessIdentity | null;
  return typeof identity?.pid === 'number' && Number.isInteger(identity.pid) && identity.pid > 0
    && typeof identity.start === 'string' && identity.start.length > 0;
}

function decodeOwnerRecord(value: unknown): OxigraphOwnerRecordV1 | null {
  const record = value as Partial<OxigraphOwnerRecordV1> | null;
  return record?.schema === OXIGRAPH_OWNER_RECORD_SCHEMA
    && isIdentity(record.daemon) && isIdentity(record.launcher)
    && (record.oxigraph === undefined || isIdentity(record.oxigraph))
    && typeof record.binaryPath === 'string'
    ? record as OxigraphOwnerRecordV1
    : null;
}

export async function readOxigraphOwnerRecord(location: string): Promise<OxigraphOwnerRecordRead> {
  let text: string;
  try {
    text = await readFile(ownerRecordPath(location), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'unreadable', reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const record = decodeOwnerRecord(JSON.parse(text));
    return record ? { kind: 'v1', record } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/** Whether `identity` still names a running process (same PID and start time). */
export async function checkIdentity(
  identity: ProcessIdentity,
  inspect: ProcessInspector = inspectProcess,
): Promise<IdentityState> {
  const lookup = await inspect(identity.pid);
  if (lookup.state === 'unknown') return lookup;
  return lookup.state === 'running' && lookup.process.start === identity.start
    ? { state: 'running' }
    : { state: 'gone' };
}

/** One recorded launch. Its identities were read once, at spawn. */
export interface OxigraphLaunchRecord {
  /** Extend this launch's record with `oxigraphPid`, its verified listener. */
  markReady(oxigraphPid: number): Promise<void>;
}

/**
 * Record a spawned launch as the owner of a store: this daemon, the launcher
 * and the binary, each identified once (PID and start time). `markReady`
 * rewrites the same record with the verified Oxigraph added. The store
 * directory is created first, since a fresh store's directory may not exist
 * until Oxigraph opens it. Best-effort: a failed write is logged and
 * resolves, because without a record the reclaim falls back to the PID 1
 * rule; when the launch itself could not be identified, `markReady` writes
 * nothing.
 */
export async function recordOxigraphLaunch(input: {
  location: string;
  binaryPath: string;
  launcherPid: number;
  log: (message: string) => void;
  inspect?: ProcessInspector;
}): Promise<OxigraphLaunchRecord> {
  if (process.platform === 'win32') return { markReady: async () => {} };
  const inspect = input.inspect ?? inspectProcess;
  const identify = async (pid: number): Promise<ProcessIdentity> => {
    const lookup = await inspect(pid);
    if (lookup.state === 'running') return { pid, start: lookup.process.start };
    throw new Error(lookup.state === 'gone'
      ? `pid ${pid} has exited`
      : `could not read pid ${pid}: ${lookup.reason}`);
  };
  const write = async (record: OxigraphOwnerRecordV1): Promise<void> => {
    try {
      await mkdir(resolve(input.location), { recursive: true });
      await writeFileAtomicWith(
        { writeFile, rename, unlink },
        ownerRecordPath(input.location),
        `${JSON.stringify(record)}\n`,
      );
    } catch (error) {
      logRecordFailure(input.log, error);
    }
  };
  let launch: OxigraphOwnerRecordV1 | null = null;
  try {
    const [daemon, launcher] = await Promise.all([identify(process.pid), identify(input.launcherPid)]);
    launch = { schema: OXIGRAPH_OWNER_RECORD_SCHEMA, daemon, launcher, binaryPath: input.binaryPath };
  } catch (error) {
    logRecordFailure(input.log, error);
  }
  if (launch) await write(launch);
  return {
    markReady: async (oxigraphPid) => {
      if (!launch) return;
      let oxigraph: ProcessIdentity;
      try {
        oxigraph = await identify(oxigraphPid);
      } catch (error) {
        logRecordFailure(input.log, error);
        return;
      }
      await write({ ...launch, oxigraph });
    },
  };
}

function logRecordFailure(log: (message: string) => void, error: unknown): void {
  log(`[oxigraph] could not record the store owner: ${error instanceof Error ? error.message : String(error)}`);
}
