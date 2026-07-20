import { existsSync, lstatSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WalControlStore } from './control/store.js';
import { WalLocalCommitter } from './local-commit.js';
import { PackedWalObjectStore } from './store/packed-store.js';

export const WAL_PROTOCOL_VERSION = 1;
export const WAL_ADAPTER_VERSION = 1;
export const WAL_RUNTIME_ROOT_DIRECTORY = 'wal-v1';

export type WalSyncMode = 'legacy' | 'parallel' | 'wal';

export interface WalRuntimePathConfig {
  objectStore?: string;
  rangeStaging?: string;
  quarantine?: string;
  shadowRdf?: string;
}

export interface WalRuntimeOperatorConfig {
  protocolVersion?: number;
  adapterVersion?: number;
  cutoverId?: string;
  paths?: WalRuntimePathConfig;
  localAuthoring?: WalLocalAuthoringOperatorConfig;
}

export interface WalLocalAuthoringOperatorConfig {
  /** JSON evidence bundle below the fixed WAL runtime root. */
  bundlePath: string;
  /** Explicit configured trust anchor; lowercase bytes32 hex without 0x. */
  curatorAuthoritySetId: string;
}

export interface WalSyncConfiguration {
  mode?: WalSyncMode;
  wal?: WalRuntimeOperatorConfig;
}

export interface ResolvedWalRuntimePaths {
  root: string;
  objectStore: string;
  rangeStaging: string;
  quarantine: string;
  shadowRdf: string;
  control: string;
}

export interface ResolvedWalRuntimeConfiguration {
  mode: WalSyncMode;
  protocolVersion: 1;
  adapterVersion: 1;
  cutoverId?: string;
  localAuthoring?: {
    bundlePath: string;
    curatorAuthoritySetId: string;
  };
  paths: ResolvedWalRuntimePaths;
}

export type WalRuntimeErrorCode =
  | 'WAL_INVALID_SYNC_CONFIGURATION'
  | 'WAL_INVALID_SYNC_MODE'
  | 'WAL_INVALID_RUNTIME_CONFIGURATION'
  | 'WAL_UNSUPPORTED_PROTOCOL_VERSION'
  | 'WAL_UNSUPPORTED_ADAPTER_VERSION'
  | 'WAL_INVALID_CUTOVER_ID'
  | 'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION'
  | 'WAL_INVALID_PATH'
  | 'WAL_PATH_OUTSIDE_ROOT'
  | 'WAL_PATH_OVERLAP'
  | 'WAL_PATH_SYMLINK'
  | 'WAL_LEGACY_RUNTIME_FORBIDDEN'
  | 'WAL_CUTOVER_ID_REQUIRED'
  | 'WAL_CUTOVER_VERIFIER_UNAVAILABLE'
  | 'WAL_CUTOVER_VERIFICATION_FAILED'
  | 'WAL_RUNTIME_BLOCKED'
  | 'WAL_RUNTIME_STOPPED'
  | 'WAL_RUNTIME_NOT_READY'
  | 'WAL_RUNTIME_START_FAILED';

export class WalRuntimeError extends Error {
  constructor(readonly code: WalRuntimeErrorCode, message: string) {
    super(message);
    this.name = 'WalRuntimeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseWalSyncMode(value: unknown): WalSyncMode {
  if (value === 'legacy' || value === 'parallel' || value === 'wal') return value;
  throw new WalRuntimeError(
    'WAL_INVALID_SYNC_MODE',
    'sync.mode must be one of legacy, parallel, or wal',
  );
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child.length > 0 && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || strictDescendant(left, right) || strictDescendant(right, left);
}

function configuredPath(root: string, field: string, value: unknown, fallback: string): string {
  if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
    throw new WalRuntimeError('WAL_INVALID_PATH', `sync.wal.paths.${field} must be a non-empty path`);
  }
  const input = typeof value === 'string' ? value.trim() : fallback;
  const candidate = resolve(root, input);
  if (!strictDescendant(root, candidate)) {
    throw new WalRuntimeError(
      'WAL_PATH_OUTSIDE_ROOT',
      `sync.wal.paths.${field} must stay below ${root}`,
    );
  }
  return candidate;
}

export function resolveWalRuntimeConfiguration(input: {
  dkgHome: string;
  sync?: unknown;
  modeOverride?: unknown;
}): ResolvedWalRuntimeConfiguration {
  if (input.sync !== undefined && !isRecord(input.sync)) {
    throw new WalRuntimeError('WAL_INVALID_SYNC_CONFIGURATION', 'sync must be an object');
  }
  const sync = (input.sync ?? {}) as Record<string, unknown>;
  const mode = parseWalSyncMode(input.modeOverride ?? sync.mode ?? 'legacy');
  if (sync.wal !== undefined && !isRecord(sync.wal)) {
    throw new WalRuntimeError('WAL_INVALID_RUNTIME_CONFIGURATION', 'sync.wal must be an object');
  }
  const wal = (sync.wal ?? {}) as Record<string, unknown>;
  if (wal.protocolVersion !== undefined && wal.protocolVersion !== WAL_PROTOCOL_VERSION) {
    throw new WalRuntimeError(
      'WAL_UNSUPPORTED_PROTOCOL_VERSION',
      `sync.wal.protocolVersion must equal ${WAL_PROTOCOL_VERSION}`,
    );
  }
  if (wal.adapterVersion !== undefined && wal.adapterVersion !== WAL_ADAPTER_VERSION) {
    throw new WalRuntimeError(
      'WAL_UNSUPPORTED_ADAPTER_VERSION',
      `sync.wal.adapterVersion must equal ${WAL_ADAPTER_VERSION}`,
    );
  }
  if (
    wal.cutoverId !== undefined &&
    (typeof wal.cutoverId !== 'string' || !/^[0-9a-f]{64}$/.test(wal.cutoverId))
  ) {
    throw new WalRuntimeError(
      'WAL_INVALID_CUTOVER_ID',
      'sync.wal.cutoverId must be a lowercase bytes32 hex value',
    );
  }
  if (wal.paths !== undefined && !isRecord(wal.paths)) {
    throw new WalRuntimeError('WAL_INVALID_RUNTIME_CONFIGURATION', 'sync.wal.paths must be an object');
  }
  const rawPaths = (wal.paths ?? {}) as Record<string, unknown>;
  const root = resolve(input.dkgHome, WAL_RUNTIME_ROOT_DIRECTORY);
  const paths: ResolvedWalRuntimePaths = {
    root,
    objectStore: configuredPath(root, 'objectStore', rawPaths.objectStore, 'objects'),
    rangeStaging: configuredPath(root, 'rangeStaging', rawPaths.rangeStaging, 'range-staging'),
    quarantine: configuredPath(root, 'quarantine', rawPaths.quarantine, 'quarantine'),
    shadowRdf: configuredPath(root, 'shadowRdf', rawPaths.shadowRdf, 'shadow-rdf'),
    control: resolve(root, 'control'),
  };
  if (wal.localAuthoring !== undefined && !isRecord(wal.localAuthoring)) {
    throw new WalRuntimeError(
      'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION',
      'sync.wal.localAuthoring must be an object',
    );
  }
  const rawLocalAuthoring = wal.localAuthoring as Record<string, unknown> | undefined;
  let localAuthoring: ResolvedWalRuntimeConfiguration['localAuthoring'];
  if (rawLocalAuthoring !== undefined) {
    if (
      typeof rawLocalAuthoring.bundlePath !== 'string'
      || rawLocalAuthoring.bundlePath.trim().length === 0
    ) {
      throw new WalRuntimeError(
        'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION',
        'sync.wal.localAuthoring.bundlePath must be a non-empty path',
      );
    }
    if (
      typeof rawLocalAuthoring.curatorAuthoritySetId !== 'string'
      || !/^[0-9a-f]{64}$/.test(rawLocalAuthoring.curatorAuthoritySetId)
    ) {
      throw new WalRuntimeError(
        'WAL_INVALID_LOCAL_AUTHORING_CONFIGURATION',
        'sync.wal.localAuthoring.curatorAuthoritySetId must be lowercase bytes32 hex',
      );
    }
    const bundlePath = resolve(root, rawLocalAuthoring.bundlePath.trim());
    if (!strictDescendant(root, bundlePath)) {
      throw new WalRuntimeError(
        'WAL_PATH_OUTSIDE_ROOT',
        `sync.wal.localAuthoring.bundlePath must stay below ${root}`,
      );
    }
    localAuthoring = {
      bundlePath,
      curatorAuthoritySetId: rawLocalAuthoring.curatorAuthoritySetId,
    };
  }
  const components = Object.entries(paths).filter(([name]) => name !== 'root');
  for (let left = 0; left < components.length; left += 1) {
    for (let right = left + 1; right < components.length; right += 1) {
      if (pathsOverlap(components[left][1], components[right][1])) {
        throw new WalRuntimeError(
          'WAL_PATH_OVERLAP',
          `WAL paths ${components[left][0]} and ${components[right][0]} overlap`,
        );
      }
    }
  }
  if (localAuthoring && components.some(([, component]) => pathsOverlap(component, localAuthoring.bundlePath))) {
    throw new WalRuntimeError(
      'WAL_PATH_OVERLAP',
      'WAL local-authoring bundle path overlaps a runtime component path',
    );
  }
  return {
    mode,
    protocolVersion: WAL_PROTOCOL_VERSION,
    adapterVersion: WAL_ADAPTER_VERSION,
    cutoverId: wal.cutoverId as string | undefined,
    localAuthoring,
    paths,
  };
}

export type WalRuntimeLifecycle = 'disabled' | 'created' | 'starting' | 'ready' | 'draining' | 'blocked' | 'stopped';

export interface WalRuntimeStatus {
  mode: WalSyncMode;
  lifecycle: WalRuntimeLifecycle;
  ready: boolean;
  synchronizationAuthority: 'legacy' | 'wal';
  shadowEnabled: boolean;
  runtimeRegistered: boolean;
  protocolsRegistered: boolean;
  workersActive: number;
  protocolVersion: number;
  adapterVersion: number;
  paths: ResolvedWalRuntimePaths | null;
  blockedReason: { code: WalRuntimeErrorCode; message: string } | null;
}

export type WalCutoverVerifier = (
  cutoverId: string,
  configuration: ResolvedWalRuntimeConfiguration,
) => Promise<boolean>;

export function disabledWalRuntimeStatus(): WalRuntimeStatus {
  return {
    mode: 'legacy',
    lifecycle: 'disabled',
    ready: true,
    synchronizationAuthority: 'legacy',
    shadowEnabled: false,
    runtimeRegistered: false,
    protocolsRegistered: false,
    workersActive: 0,
    protocolVersion: WAL_PROTOCOL_VERSION,
    adapterVersion: WAL_ADAPTER_VERSION,
    paths: null,
    blockedReason: null,
  };
}

function assertNoSymlinks(parent: string, target: string): void {
  const segments = relative(parent, target).split(/[\\/]/).filter(Boolean);
  let current = parent;
  for (const segment of segments) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new WalRuntimeError('WAL_PATH_SYMLINK', `WAL path must not traverse symbolic link ${current}`);
    }
  }
}

export class WalRuntime {
  private lifecycle: WalRuntimeLifecycle = 'created';
  private blockedReason: WalRuntimeStatus['blockedReason'] = null;
  private cutoverVerified = false;
  private unregisterProtocols: (() => void) | null = null;
  private objectStore: PackedWalObjectStore | null = null;
  private controlStore: WalControlStore | null = null;
  private localCommitter: WalLocalCommitter | null = null;

  constructor(
    readonly configuration: ResolvedWalRuntimeConfiguration,
    private readonly cutoverVerifier?: WalCutoverVerifier,
  ) {
    if (configuration.mode === 'legacy') {
      throw new WalRuntimeError('WAL_LEGACY_RUNTIME_FORBIDDEN', 'legacy mode must not register a WAL runtime');
    }
  }

  status(): WalRuntimeStatus {
    const runtimeWasReady =
      this.lifecycle === 'ready' || this.lifecycle === 'draining' || this.lifecycle === 'stopped';
    return {
      mode: this.configuration.mode,
      lifecycle: this.lifecycle,
      ready: this.lifecycle === 'ready',
      synchronizationAuthority:
        this.configuration.mode === 'wal' && this.cutoverVerified && runtimeWasReady ? 'wal' : 'legacy',
      shadowEnabled: this.configuration.mode === 'parallel',
      runtimeRegistered: true,
      protocolsRegistered: this.unregisterProtocols !== null,
      workersActive: 0,
      protocolVersion: this.configuration.protocolVersion,
      adapterVersion: this.configuration.adapterVersion,
      paths: this.configuration.paths,
      blockedReason: this.blockedReason,
    };
  }

  async start(): Promise<WalRuntimeStatus> {
    if (this.lifecycle === 'ready') return this.status();
    if (this.lifecycle === 'blocked') {
      throw new WalRuntimeError('WAL_RUNTIME_BLOCKED', 'blocked WAL runtime requires a process restart');
    }
    if (this.lifecycle === 'stopped') {
      throw new WalRuntimeError('WAL_RUNTIME_STOPPED', 'stopped WAL runtime cannot be restarted in-process');
    }
    this.lifecycle = 'starting';
    try {
      if (this.configuration.mode === 'wal') {
        if (!this.configuration.cutoverId) {
          throw new WalRuntimeError('WAL_CUTOVER_ID_REQUIRED', 'wal mode requires the exact signed CutoverId');
        }
        if (!this.cutoverVerifier) {
          throw new WalRuntimeError(
            'WAL_CUTOVER_VERIFIER_UNAVAILABLE',
            'wal mode is unavailable until signed cutover verification is installed',
          );
        }
        if (!(await this.cutoverVerifier(this.configuration.cutoverId, this.configuration))) {
          throw new WalRuntimeError('WAL_CUTOVER_VERIFICATION_FAILED', 'signed WAL cutover verification failed');
        }
        this.cutoverVerified = true;
      }
      assertNoSymlinks(resolve(this.configuration.paths.root, '..'), this.configuration.paths.root);
      for (const path of Object.values(this.configuration.paths)) {
        assertNoSymlinks(this.configuration.paths.root, path);
        await mkdir(path, { recursive: true });
      }
      this.objectStore = new PackedWalObjectStore({ root: this.configuration.paths.objectStore });
      this.controlStore = new WalControlStore({ root: this.configuration.paths.objectStore });
      this.localCommitter = new WalLocalCommitter({ control: this.controlStore });
      this.localCommitter.recoverPostCommitWork();
      this.lifecycle = 'ready';
      await this.persistLifecycle();
      return this.status();
    } catch (error) {
      this.closeLocalState();
      this.lifecycle = 'blocked';
      const runtimeError = error instanceof WalRuntimeError
        ? error
        : new WalRuntimeError(
          'WAL_RUNTIME_START_FAILED',
          `WAL runtime start failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      this.blockedReason = { code: runtimeError.code, message: runtimeError.message };
      throw runtimeError;
    }
  }

  async replay(): Promise<{ pending: number }> {
    if (this.lifecycle !== 'ready' && this.lifecycle !== 'draining') {
      throw new WalRuntimeError('WAL_RUNTIME_NOT_READY', 'WAL replay requires a ready or draining runtime');
    }
    this.localCommitter!.recoverPostCommitWork();
    return {
      pending: this.controlStore!.listLocalCommitWork(['PENDING', 'BLOCKED']).length,
    };
  }

  localWriter(): WalLocalCommitter {
    if (this.lifecycle !== 'ready' || this.localCommitter === null) {
      throw new WalRuntimeError('WAL_RUNTIME_NOT_READY', 'local WAL authoring requires a ready runtime');
    }
    return this.localCommitter;
  }

  localControlStore(): WalControlStore {
    if (this.lifecycle !== 'ready' || this.controlStore === null) {
      throw new WalRuntimeError('WAL_RUNTIME_NOT_READY', 'local WAL control state requires a ready runtime');
    }
    return this.controlStore;
  }

  /** Internal bootstrap/import boundary; never exposes partial range staging. */
  localObjectStore(): PackedWalObjectStore {
    if (this.lifecycle !== 'ready' || this.objectStore === null) {
      throw new WalRuntimeError('WAL_RUNTIME_NOT_READY', 'local WAL object storage requires a ready runtime');
    }
    return this.objectStore;
  }

  registerProtocols(unregister: () => void): () => void {
    if (this.lifecycle !== 'ready') {
      throw new WalRuntimeError('WAL_RUNTIME_NOT_READY', 'WAL protocol registration requires a ready runtime');
    }
    if (typeof unregister !== 'function') {
      throw new WalRuntimeError('WAL_INVALID_RUNTIME_CONFIGURATION', 'WAL protocol unregister callback is required');
    }
    if (this.unregisterProtocols !== null) {
      throw new WalRuntimeError('WAL_RUNTIME_BLOCKED', 'WAL protocols are already registered');
    }
    this.unregisterProtocols = unregister;
    return () => {
      if (this.unregisterProtocols !== unregister) return;
      unregister();
      this.unregisterProtocols = null;
    };
  }

  async drain(): Promise<WalRuntimeStatus> {
    if (this.lifecycle === 'ready') {
      this.lifecycle = 'draining';
      await this.persistLifecycle();
    }
    return this.status();
  }

  async stop(): Promise<WalRuntimeStatus> {
    if (this.lifecycle === 'stopped') return this.status();
    const hadDurableState = this.lifecycle === 'ready' || this.lifecycle === 'draining';
    const unregister = this.unregisterProtocols;
    if (unregister !== null) {
      unregister();
      this.unregisterProtocols = null;
    }
    this.lifecycle = 'stopped';
    if (hadDurableState) await this.persistLifecycle();
    this.closeLocalState();
    return this.status();
  }

  private closeLocalState(): void {
    this.localCommitter = null;
    this.controlStore?.close();
    this.controlStore = null;
    this.objectStore?.close();
    this.objectStore = null;
  }

  private async persistLifecycle(): Promise<void> {
    const marker = join(this.configuration.paths.control, 'runtime.json');
    const temporary = `${marker}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      mode: this.configuration.mode,
      protocolVersion: this.configuration.protocolVersion,
      adapterVersion: this.configuration.adapterVersion,
      lifecycle: this.lifecycle,
    })}\n`, { mode: 0o600 });
    await rename(temporary, marker);
  }
}

export function createWalRuntime(
  configuration: ResolvedWalRuntimeConfiguration,
  cutoverVerifier?: WalCutoverVerifier,
): WalRuntime | null {
  return configuration.mode === 'legacy' ? null : new WalRuntime(configuration, cutoverVerifier);
}
