import type { DkgLocalLlmDomainProfile } from '@origintrail-official/dkg-local-llm';
import type { DkgLocalLlmRuntimeSession, DkgLocalLlmRuntimeSessionOptions } from '../local-llm-runtime-factory.js';

export type LocalLlmErrorCode =
  | 'LOCAL_LLM_OFFLINE' | 'LOCAL_LLM_NOT_READY' | 'LOCAL_LLM_BUSY'
  | 'LOCAL_LLM_PROJECT_MISMATCH' | 'LOCAL_LLM_INVALID_REQUEST' | 'LOCAL_LLM_RUNTIME_ERROR';

export class DaemonLocalLlmError extends Error {
  constructor(readonly code: LocalLlmErrorCode, readonly status: number, message: string) {
    super(message);
    this.name = 'DaemonLocalLlmError';
  }
}

export type LocalLlmSessionFactory = (options: DkgLocalLlmRuntimeSessionOptions) => Promise<DkgLocalLlmRuntimeSession>;

/** Owns the model/MCP lifetime independently of UI or Program orchestration. */
export function createLocalLlmSessionOwner(options: {
  dkgHome: string;
  createSession: LocalLlmSessionFactory;
  settings: {
    llamaUrl: string; model: string; logDir: string;
    adapterPaths?: string[]; domainProfile?: DkgLocalLlmDomainProfile;
  };
  strictProjectTools: readonly string[];
  verifyConfiguration?: () => Array<{ path: string; sha256: string }>;
  cwd?: string;
  stderr?: (line: string) => void;
}) {
  const { settings } = options;
  let session: DkgLocalLlmRuntimeSession | undefined;
  let lockedProjectId: string | undefined;
  let hasProjectLock = false;
  let closed = false;
  let initFailure: string | undefined;
  let active: { settlement: Promise<void>; controller?: AbortController } | undefined;
  let closing: Promise<void> | undefined;

  const assertProject = (projectId: string | undefined) => {
    if (hasProjectLock && projectId !== lockedProjectId) {
      throw new DaemonLocalLlmError('LOCAL_LLM_PROJECT_MISMATCH', 409, 'Clear the session before changing Context Graph.');
    }
  };
  const lockProject = (projectId: string | undefined) => {
    assertProject(projectId);
    hasProjectLock = true;
    lockedProjectId = projectId;
  };
  const closeSession = async (clearHistory: boolean) => {
    const current = session;
    session = undefined;
    if (!current) return;
    if (clearHistory) await current.runtime.clearSession().catch(() => undefined);
    await current.close();
  };
  const ensureSession = async (projectId: string | undefined, signal: AbortSignal) => {
    const adapterHashes = options.verifyConfiguration?.();
    if (session) return session;
    try {
      const created = await options.createSession({
        dkgHome: options.dkgHome, llamaUrl: settings.llamaUrl, model: settings.model,
        projectId, signal, initializationTimeoutMs: 15_000,
        strictProjectScope: true,
        strictProjectScopeTools: settings.domainProfile?.readTools ?? options.strictProjectTools,
        strictProjectScopeUnscopedTools: ['dkg_status'],
        adapterPaths: settings.adapterPaths, adapterHashes, domainProfile: settings.domainProfile,
        profile: 'auto', allowWrite: false, logDir: settings.logDir,
        maxToolCalls: 4, maxToolsPerTurn: 8, maxToolJsonBytes: 18_000,
        maxEvidenceChars: 12_000, maxSessionTurns: 6, maxSessionChars: 8_000,
        requestTimeoutMs: 120_000, temperature: 0.15, topP: 0.9, maxTokens: 1_024,
        cwd: options.cwd, stderr: options.stderr,
      });
      try {
        signal.throwIfAborted();
        options.verifyConfiguration?.();
      } catch (error) {
        await created.close();
        throw error;
      }
      session = created;
      lockProject(projectId);
      initFailure = undefined;
      return created;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof Error && error.message.startsWith('LOCAL_LLM_PROGRAM_CONFIGURATION_CHANGED')) throw error;
      initFailure = error instanceof Error ? error.message : String(error);
      throw new DaemonLocalLlmError('LOCAL_LLM_RUNTIME_ERROR', 500,
        `Failed to initialize the local DKG LLM runtime: ${initFailure}`);
    }
  };

  const abortTurn = (reason: unknown) => { active?.controller?.abort(reason); };
  return {
    state: () => ({ busy: !!active, initialized: !!session, closed, initFailure,
      hasProjectLock, lockedProjectId, traceFile: session?.trace.filePath }),
    assertProject,
    lockProject,
    abortTurn,
    async drain() { await active?.settlement; },
    async run(message: string, projectId: string | undefined, callerSignal?: AbortSignal, captureEvidence = false) {
      if (closed || active) throw new DaemonLocalLlmError('LOCAL_LLM_BUSY', 409, 'The model session is busy or shutting down.');
      assertProject(projectId);
      const controller = new AbortController();
      const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      let settle!: () => void;
      const operation = { controller, settlement: new Promise<void>(resolve => { settle = resolve; }) };
      active = operation;
      try {
        const current = await ensureSession(projectId, signal);
        signal.throwIfAborted();
        const result = await current.runtime.run(message, { signal, captureEvidence });
        signal.throwIfAborted();
        return { ...result, model: settings.model, contextGraphId: projectId, readOnly: true as const };
      } finally {
        active = undefined;
        settle();
      }
    },
    async clear() {
      if (closed) throw new DaemonLocalLlmError('LOCAL_LLM_RUNTIME_ERROR', 503, 'The local LLM service is shutting down.');
      if (active) throw new DaemonLocalLlmError('LOCAL_LLM_BUSY', 409, 'Wait for the active local LLM turn before clearing the session.');
      let settle!: () => void;
      active = { settlement: new Promise<void>(resolve => { settle = resolve; }) };
      try {
        await closeSession(true);
        lockedProjectId = undefined;
        hasProjectLock = false;
        initFailure = undefined;
      } finally {
        active = undefined;
        settle();
      }
    },
    close() {
      if (!closing) {
        closed = true;
        abortTurn(new Error('The local LLM service is shutting down.'));
        const pending = active?.settlement;
        closing = (async () => { await pending; await closeSession(false); })();
      }
      return closing;
    },
  };
}
