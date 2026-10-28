// SPDX-License-Identifier: Apache-2.0
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AsyncLiftClaimControl } from '@origintrail-official/dkg-publisher';

type Desired = 'paused' | 'running';
export interface PublisherDesiredState {
  readonly version: 1;
  readonly desiredState: Desired;
  readonly generation: number;
  readonly updatedAt: string;
}
export interface PublisherLiveStatus extends PublisherDesiredState {
  readonly effectiveState: Desired | 'unavailable';
  readonly acknowledgedGeneration: number;
  readonly wallets: readonly Readonly<{ walletId: string; paused: boolean; generation: number }>[];
  readonly fault: 'persistence_or_control_failed' | null;
}
export interface PublisherLiveControl {
  status(): PublisherLiveStatus;
  pause(): Promise<PublisherLiveStatus>;
  resume(): Promise<PublisherLiveStatus>;
  close(): Promise<void>;
}

export function publisherDesiredStatePath(dataDir: string): string {
  return join(dataDir, 'publisher-control.json');
}

function decodeState(raw: string): PublisherDesiredState {
  const state = JSON.parse(raw) as PublisherDesiredState;
  if (!state || typeof state !== 'object' || state.version !== 1
    || !['paused', 'running'].includes(state.desiredState)
    || !Number.isSafeInteger(state.generation) || state.generation < 0
    || typeof state.updatedAt !== 'string' || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new Error('Invalid persisted publisher control state');
  }
  return Object.freeze({ version: 1, desiredState: state.desiredState,
    generation: state.generation, updatedAt: state.updatedAt });
}

/** Fsync bytes before rename, then the directory before acknowledging durable intent. */
async function saveState(dataDir: string, state: PublisherDesiredState): Promise<void> {
  const destination = publisherDesiredStatePath(dataDir);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(state)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, destination);
    if (process.platform !== 'win32') {
      const directory = await open(dataDir, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Created only for the exact runtime, before runner.start() may recover or claim any work. */
export async function createPublisherLiveControl(
  claims: AsyncLiftClaimControl, walletIds: readonly string[], dataDir: string, startPaused = false,
): Promise<PublisherLiveControl> {
  const controlledWalletIds = [...walletIds];
  // A failed read or write cannot accidentally start the runner unpaused.
  await claims.hold();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  let state: PublisherDesiredState;
  let existing = true;
  try { state = decodeState(await readFile(publisherDesiredStatePath(dataDir), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existing = false;
    state = { version: 1, desiredState: startPaused ? 'paused' : 'running', generation: 0,
      updatedAt: new Date().toISOString() };
  }
  if (startPaused && state.desiredState !== 'paused') {
    state = { ...state, desiredState: 'paused', generation: nextGeneration(state.generation), updatedAt: new Date().toISOString() };
    existing = false;
  }
  if (!existing) await saveState(dataDir, state);
  if (state.desiredState === 'running') await claims.release();
  let fault: PublisherLiveStatus['fault'] = null;
  let tail: Promise<unknown> = Promise.resolve();
  const status = (): PublisherLiveStatus => {
    const effective = claims.state;
    return Object.freeze({ ...state, effectiveState: fault || effective === 'closed' ? 'unavailable' : effective === 'held' ? 'paused' : 'running',
      acknowledgedGeneration: state.generation,
      wallets: Object.freeze(controlledWalletIds.map(walletId => Object.freeze({ walletId,
        paused: effective !== 'running', generation: state.generation }))), fault });
  };
  const change = (desiredState: Desired): Promise<PublisherLiveStatus> => {
    const changing = tail.then(async () => {
      const initialClaimState = claims.state;
      if (initialClaimState === 'closed' || fault) throw new Error('Publisher live control is unavailable');
      if (state.desiredState === desiredState) return status();
      const next: PublisherDesiredState = { ...state, desiredState,
        generation: nextGeneration(state.generation), updatedAt: new Date().toISOString() };
      try {
        // Pause first so persistence latency cannot admit additional claims; resume opens last.
        if (desiredState === 'paused') await claims.hold();
        await saveState(dataDir, next);
        if (claims.state === 'closed') throw new Error('Publisher live control closed during persistence');
        if (desiredState === 'running') await claims.release();
        state = next;
        return status();
      } catch (error) {
        fault = 'persistence_or_control_failed';
        // A failed operation is never acknowledged. Keep publisher admission closed until restart.
        await claims.close().catch(() => {});
        throw new Error('Publisher control could not commit; restart to reload durable intent', { cause: error });
      }
    });
    tail = changing.catch(() => {});
    return changing;
  };
  return Object.freeze({ status, pause: () => change('paused'), resume: () => change('running'),
    close: async () => {
      const fenced = claims.close();
      await Promise.all([tail, fenced]);
    } });
}

function nextGeneration(current: number): number {
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('Publisher control generation exhausted');
  return current + 1;
}
