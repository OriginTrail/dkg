import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { LOCAL_LLM_PROGRAM_TOOL, localLlmConfigurationSha256, registerLocalLlmProgramProvider,
  type LocalLlmProgramCapability } from '../semantic-runtime-local-llm-adapter.js';
import { lstatSync, readFileSync } from 'node:fs';
import {
  probeLocalModelEndpoint,
  parseDomainProfile,
  type DkgLocalLlmDomainProfile,
  type LocalModelEndpointAvailability,
  type LocalModelEndpointProbeStrategy,
} from '@origintrail-official/dkg-local-llm';
import {
  createDkgLocalLlmRuntimeSession,
  type DkgLocalLlmRuntimeSession,
  type DkgLocalLlmRuntimeSessionOptions,
} from '../local-llm-runtime-factory.js';

export const DKG_LOCAL_LLM_UI_SESSION_ID = 'local-llm:dkg-ui';

// Security allowlist for the daemon-owned, single-Context-Graph UI session.
// Each entry is backed by a tool implementation that scopes every read to its
// project argument. Do not infer this property from JSON Schema: some tools
// accept projectId while intentionally fanning out to other graphs.
const DKG_LOCAL_LLM_STRICT_PROJECT_TOOLS = [
  'dkg_sub_graph_list',
  'dkg_query',
  'dkg_get_entity',
  'dkg_get_entity_sources',
  'dkg_list_activity',
  'dkg_get_agent',
  'dkg_knowledge_asset_query',
  'dkg_knowledge_asset_history',
  'dkg_knowledge_asset_import_artifact_resolve',
  'dkg_knowledge_asset_import_artifact_read_markdown',
  'dkg_query_catalog_list',
  'dkg_query_catalog_run',
] as const;

export type LocalLlmErrorCode =
  | 'LOCAL_LLM_OFFLINE'
  | 'LOCAL_LLM_NOT_READY'
  | 'LOCAL_LLM_BUSY'
  | 'LOCAL_LLM_PROJECT_MISMATCH'
  | 'LOCAL_LLM_INVALID_REQUEST'
  | 'LOCAL_LLM_RUNTIME_ERROR';

export class DaemonLocalLlmError extends Error {
  constructor(
    readonly code: LocalLlmErrorCode,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonLocalLlmError';
  }
}

export interface DaemonLocalLlmHealth {
  ok: boolean;
  /** True when the operator supplied at least one local-LLM environment override. */
  configured: boolean;
  ready: boolean;
  reachable: boolean;
  offline: boolean;
  busy: boolean;
  initialized: boolean;
  readOnly: true;
  sessionId: string;
  contextGraphId?: string;
  traceFile?: string;
  error?: string;
  initFailure?: string;
  executionMode?: 'program' | 'direct';
  programCapability?: LocalLlmProgramCapability;
}

export interface LocalLlmProgramExecution {
  invocationId: string; executionIri: string; executionLayer: string;
  persisted: true; programIri: string; contextGraphId: string; assetName: string;
}

export interface DaemonLocalLlmChatResult {
  execution?: LocalLlmProgramExecution;
  text: string;
  sessionId: string;
  contextGraphId?: string;
  profile: string;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  traceFile?: string;
  readOnly: true;
}

export interface DaemonLocalLlmService {
  health(): Promise<DaemonLocalLlmHealth>;
  chat(input: {
    message: string;
    contextGraphId?: string;
    signal?: AbortSignal;
  }): Promise<DaemonLocalLlmChatResult>;
  clear(): Promise<{ ok: true; sessionId: string; readOnly: true }>;
  close(): Promise<void>;
}

type SessionFactory = (
  options: DkgLocalLlmRuntimeSessionOptions,
) => Promise<DkgLocalLlmRuntimeSession>;

export interface LocalLlmProgramExecutor {
  chat(input: { message: string; contextGraphId?: string; signal?: AbortSignal }):
    Promise<Omit<DaemonLocalLlmChatResult, 'sessionId' | 'readOnly'>>;
}

export interface DaemonLocalLlmServiceOptions {
  createProgramExecutor?: (options: { dkgHome: string; capability: LocalLlmProgramCapability }) => Promise<LocalLlmProgramExecutor>;
  dkgHome: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  fetch?: typeof fetch;
  createSession?: SessionFactory;
  probeStrategy?: LocalModelEndpointProbeStrategy;
  probeTimeoutMs?: number;
  stderr?: (line: string) => void;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProbeStrategy(value: string | undefined): {
  strategy: LocalModelEndpointProbeStrategy;
  error?: string;
} {
  const configured = trimmed(value)?.toLowerCase();
  if (!configured || configured === 'auto') return { strategy: { kind: 'auto' } };
  if (configured === 'ollama') return { strategy: { kind: 'ollama' } };
  if (['llama.cpp', 'llama-cpp', 'llamacpp'].includes(configured)) {
    return { strategy: { kind: 'llama.cpp' } };
  }
  return {
    strategy: { kind: 'auto' },
    error: `DKG_LLM_BACKEND must be one of: auto, ollama, llama.cpp (received '${value?.trim()}')`,
  };
}

export function resolveDaemonLocalLlmSettings(
  dkgHome: string,
  env: NodeJS.ProcessEnv = process.env,
): {
  configured: boolean;
  llamaUrl: string;
  model: string;
  probeStrategy: LocalModelEndpointProbeStrategy;
  probeConfigurationError?: string;
  defaultProjectId?: string;
  logDir: string;
  adapterPaths?: string[];
  domainProfile?: DkgLocalLlmDomainProfile;
} {
  const probe = resolveProbeStrategy(env.DKG_LLM_BACKEND);
  let domainProfile: DkgLocalLlmDomainProfile | undefined;
  let adapterPaths: string[] | undefined;
  let domainError: string | undefined;
  try {
    const adapters = trimmed(env.DKG_LLM_ADAPTERS);
    if (adapters) {
      adapterPaths = adapters.split(',').map(value => value.trim()).filter(Boolean);
      if (adapterPaths.length > 16 || adapterPaths.some(value => !path.isAbsolute(value))) {
        throw new Error('DKG_LLM_ADAPTERS requires at most 16 absolute adapter paths.');
      }
    }
    const profilePath = trimmed(env.DKG_LLM_DOMAIN_PROFILE);
    if (profilePath) {
      if (!path.isAbsolute(profilePath)) throw new Error('DKG_LLM_DOMAIN_PROFILE requires an absolute path.');
      const info = lstatSync(profilePath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 || (info.mode & 0o022)) {
        throw new Error('The daemon domain profile must be a bounded operator-owned file.');
      }
      domainProfile = parseDomainProfile(JSON.parse(readFileSync(profilePath, 'utf8')));
      if (domainProfile.writeTools?.length) throw new Error('Daemon domain profiles cannot enable write tools.');
    }
    if (adapterPaths?.length && !domainProfile) {
      throw new Error('DKG_LLM_ADAPTERS requires a reviewed DKG_LLM_DOMAIN_PROFILE.');
    }
  } catch (error) {
    domainError = errorMessage(error);
  }
  const configured = [
    env.DKG_LLM_URL,
    env.LLAMA_URL,
    env.DKG_LLM_MODEL,
    env.LLAMA_MODEL,
    env.DKG_LLM_BACKEND,
    env.DKG_LLM_ADAPTERS,
    env.DKG_LLM_DOMAIN_PROFILE,
  ].some((value) => trimmed(value) !== undefined);
  return {
    configured,
    llamaUrl: trimmed(env.DKG_LLM_URL)
      ?? trimmed(env.LLAMA_URL)
      ?? 'http://127.0.0.1:8080/v1/chat/completions',
    model: trimmed(env.DKG_LLM_MODEL) ?? trimmed(env.LLAMA_MODEL) ?? 'local-model',
    probeStrategy: probe.strategy,
    ...(probe.error || domainError ? { probeConfigurationError: probe.error ?? domainError } : {}),
    ...(adapterPaths ? { adapterPaths } : {}),
    ...(domainProfile ? { domainProfile } : {}),
    defaultProjectId: trimmed(env.DKG_PROJECT),
    logDir: path.join(dkgHome, 'logs', 'local-llm'),
  };
}

export function createDaemonLocalLlmService(
  options: DaemonLocalLlmServiceOptions,
): DaemonLocalLlmService {
  const settings = resolveDaemonLocalLlmSettings(options.dkgHome, options.env);
  const fetcher = options.fetch ?? globalThis.fetch;
  const createSession = options.createSession ?? createDkgLocalLlmRuntimeSession;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2_000;
  const env = options.env ?? process.env;
  const programPath = trimmed(env.DKG_LLM_PROGRAM_EXECUTOR);
  const programOwner = trimmed(env.DKG_LLM_PROGRAM_AGENT)?.toLowerCase();
  const capability: LocalLlmProgramCapability | undefined = programOwner && settings.defaultProjectId
    ? { toolIri: LOCAL_LLM_PROGRAM_TOOL, contextGraphId: settings.defaultProjectId,
      ownerAgentAddress: programOwner, configurationSha256: localLlmConfigurationSha256(settings, programOwner) }
    : undefined;
  let programExecutor: Promise<LocalLlmProgramExecutor> | undefined;
  let modelBusy = false;
  let modelSettlement: Promise<void> | undefined;
  let session: DkgLocalLlmRuntimeSession | undefined;
  let lockedProjectId: string | undefined;
  let hasProjectLock = false;
  let closed = false;
  let activeOperation: {
    kind: 'chat' | 'clear';
    settlement: Promise<void>;
    controller?: AbortController;
    signal?: AbortSignal;
  } | undefined;
  let closePromise: Promise<void> | undefined;
  let initFailure: string | undefined;

  const probe = (): Promise<LocalModelEndpointAvailability> => {
    if (settings.probeConfigurationError) {
      return Promise.resolve(Object.freeze({
        status: 'offline',
        reachable: false,
        error: `Local LLM endpoint configuration is invalid: ${settings.probeConfigurationError}`,
      }));
    }
    return probeLocalModelEndpoint({
      chatCompletionsUrl: settings.llamaUrl,
      model: settings.model,
      strategy: options.probeStrategy ?? settings.probeStrategy,
      fetch: fetcher,
      timeoutMs: probeTimeoutMs,
    });
  };

  const unavailableError = (
    availability: Exclude<LocalModelEndpointAvailability, { status: 'ready' }>,
  ): DaemonLocalLlmError => new DaemonLocalLlmError(
    availability.status === 'not-ready' ? 'LOCAL_LLM_NOT_READY' : 'LOCAL_LLM_OFFLINE',
    503,
    availability.error,
  );

  const closeSession = async (clearHistory: boolean): Promise<void> => {
    const current = session;
    session = undefined;
    if (!current) return;
    if (clearHistory) await current.runtime.clearSession().catch(() => undefined);
    await current.close();
  };

  const ensureSession = async (requestedProjectId: string | undefined, signal?: AbortSignal) => {
    if (!session) {
      try {
        const created = await createSession({
          dkgHome: options.dkgHome,
          llamaUrl: settings.llamaUrl,
          model: settings.model,
          projectId: requestedProjectId,
          signal,
          initializationTimeoutMs: 15_000,
          strictProjectScope: true,
          // This operator-reviewed list replaces the generic read surface.
          // Implementations must enforce projectId; a schema alone is not
          // proof. Runtime annotation and write guards remain in force.
          strictProjectScopeTools: settings.domainProfile?.readTools ?? DKG_LOCAL_LLM_STRICT_PROJECT_TOOLS,
          strictProjectScopeUnscopedTools: ['dkg_status'],
          adapterPaths: settings.adapterPaths,
          domainProfile: settings.domainProfile,
          profile: 'auto',
          allowWrite: false,
          logDir: settings.logDir,
          maxToolCalls: 4,
          maxToolsPerTurn: 8,
          maxToolJsonBytes: 18_000,
          maxEvidenceChars: 12_000,
          maxSessionTurns: 6,
          maxSessionChars: 8_000,
          requestTimeoutMs: 120_000,
          temperature: 0.15,
          topP: 0.9,
          maxTokens: 1_024,
          cwd: options.cwd,
          stderr: options.stderr,
        });
        if (signal?.aborted) {
          await created.close();
          signal?.throwIfAborted();
        }
        if (closed) {
          await created.close();
          throw new DaemonLocalLlmError(
            'LOCAL_LLM_RUNTIME_ERROR',
            503,
            'The local LLM service is shutting down.',
          );
        }
        session = created;
        lockedProjectId = requestedProjectId;
        hasProjectLock = true;
        initFailure = undefined;
      } catch (error) {
        if (error instanceof DaemonLocalLlmError) throw error;
        if (signal?.aborted) signal?.throwIfAborted();
        initFailure = errorMessage(error);
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_RUNTIME_ERROR',
          500,
          `Failed to initialize the local DKG LLM runtime: ${initFailure}`,
        );
      }
    }
    return session!;
  };

  const runModel = async (message: string, requestedProjectId: string | undefined,
    signal?: AbortSignal, captureEvidence = false) => {
    if (closed || modelBusy || activeOperation?.kind === 'clear') {
      throw new DaemonLocalLlmError('LOCAL_LLM_BUSY', 409, 'The model session is busy or shutting down.');
    }
    if (hasProjectLock && requestedProjectId !== lockedProjectId) {
      throw new DaemonLocalLlmError('LOCAL_LLM_PROJECT_MISMATCH', 409, 'Clear the session before changing Context Graph.');
    }
    modelBusy = true;
    let settle!: () => void;
    modelSettlement = new Promise<void>(resolve => { settle = resolve; });
    try {
      const current = await ensureSession(requestedProjectId, signal);
      const result = await current.runtime.run(message, { signal, captureEvidence });
      return { ...result, model: settings.model, contextGraphId: requestedProjectId, readOnly: true as const };
    } finally {
      modelBusy = false;
      settle();
    }
  };

  const unregisterProvider = capability ? registerLocalLlmProgramProvider({
    capability,
    run: prompt => runModel(prompt, capability.contextGraphId, activeOperation?.signal, true),
  }) : undefined;

  const getProgramExecutor = () => (programExecutor ??= (async () => {
    if (!capability || !programPath || !path.isAbsolute(programPath)) throw new Error('LOCAL_LLM_PROGRAM_NOT_CONFIGURED');
    if (options.createProgramExecutor) return options.createProgramExecutor({ dkgHome: options.dkgHome, capability });
    const info = lstatSync(programPath);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022)) throw new Error('LOCAL_LLM_PROGRAM_MODULE_UNSAFE');
    const module = await import(pathToFileURL(programPath).href);
    return module.createProgramChatExecutor({ dkgHome: options.dkgHome, capability });
  })());

  return {
    async health() {
      const availability = await probe();
      const reachable = availability.status !== 'offline';
      let programError: string | undefined;
      if (programPath) {
        try { await getProgramExecutor(); } catch (error) { programError = errorMessage(error); }
      }
      const ready = availability.status === 'ready' && !initFailure && !programError && !closed;
      return {
        ok: ready,
        configured: settings.configured,
        ready,
        reachable,
        offline: !reachable,
        busy: Boolean(activeOperation) || modelBusy,
        executionMode: programPath ? 'program' : 'direct',
        ...(capability ? { programCapability: capability } : {}),
        initialized: Boolean(session),
        readOnly: true,
        sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
        ...(hasProjectLock && lockedProjectId ? { contextGraphId: lockedProjectId } : {}),
        ...(session?.trace.filePath ? { traceFile: session.trace.filePath } : {}),
        ...(availability.status !== 'ready' || initFailure || programError
          ? { error: availability.status === 'ready' ? initFailure ?? programError : availability.error }
          : {}),
        ...(initFailure ? { initFailure } : {}),
      };
    },

    async chat(input) {
      input.signal?.throwIfAborted();
      const message = input.message.trim();
      if (!message) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_INVALID_REQUEST',
          400,
          'A non-empty "message" is required.',
        );
      }
      if (closed) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_RUNTIME_ERROR',
          503,
          'The local LLM service is shutting down.',
        );
      }
      if (activeOperation || modelBusy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'The local LLM session already has a turn in progress.',
        );
      }

      const requestedProjectId = trimmed(input.contextGraphId) ?? settings.defaultProjectId;
      if (hasProjectLock && requestedProjectId !== lockedProjectId) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_PROJECT_MISMATCH',
          409,
          `This session is bound to Context Graph ${lockedProjectId ?? '<none>'}. Clear the session before using ${requestedProjectId ?? '<none>'}.`,
        );
      }

      const turnController = new AbortController();
      const signal = input.signal
        ? AbortSignal.any([input.signal, turnController.signal])
        : turnController.signal;
      let settleTurn!: () => void;
      const turnSettlement = new Promise<void>((resolve) => { settleTurn = resolve; });
      const operation = {
        kind: 'chat' as const,
        settlement: turnSettlement,
        controller: turnController,
        signal,
      };
      activeOperation = operation;
      try {
        const availability = await probe();
        signal.throwIfAborted();
        if (availability.status !== 'ready') throw unavailableError(availability);

        try {
          if (programPath) {
            const result = await (await getProgramExecutor()).chat({ message, contextGraphId: requestedProjectId, signal });
            signal.throwIfAborted();
            lockedProjectId = requestedProjectId;
            hasProjectLock = true;
            return { ...result, sessionId: DKG_LOCAL_LLM_UI_SESSION_ID, readOnly: true };
          }
          const result = await runModel(message, requestedProjectId, signal);
          signal.throwIfAborted();
          return {
            text: result.answer,
            sessionId: DKG_LOCAL_LLM_UI_SESSION_ID,
            ...(lockedProjectId ? { contextGraphId: lockedProjectId } : {}),
            profile: result.profile,
            toolCalls: result.toolCalls,
            traceFile: result.traceFile ?? session?.trace.filePath,
            readOnly: true,
          };
        } catch (error) {
          if (error instanceof DaemonLocalLlmError) throw error;
          if (signal.aborted) signal.throwIfAborted();
          const availabilityAfterFailure = await probe();
          if (availabilityAfterFailure.status !== 'ready') {
            throw unavailableError(availabilityAfterFailure);
          }
          throw new DaemonLocalLlmError(
            'LOCAL_LLM_RUNTIME_ERROR',
            502,
            errorMessage(error),
          );
        }
      } finally {
        settleTurn();
        if (activeOperation === operation) activeOperation = undefined;
      }
    },

    async clear() {
      if (closed) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_RUNTIME_ERROR',
          503,
          'The local LLM service is shutting down.',
        );
      }
      if (activeOperation || modelBusy) {
        throw new DaemonLocalLlmError(
          'LOCAL_LLM_BUSY',
          409,
          'Wait for the active local LLM turn before clearing the session.',
        );
      }
      let settleClear!: () => void;
      const clearSettlement = new Promise<void>((resolve) => { settleClear = resolve; });
      const operation = { kind: 'clear' as const, settlement: clearSettlement };
      activeOperation = operation;
      try {
        await closeSession(true);
        lockedProjectId = undefined;
        hasProjectLock = false;
        initFailure = undefined;
        return { ok: true, sessionId: DKG_LOCAL_LLM_UI_SESSION_ID, readOnly: true };
      } finally {
        settleClear();
        if (activeOperation === operation) activeOperation = undefined;
      }
    },

    async close() {
      if (!closePromise) {
        closed = true;
        const pendingOperation = activeOperation;
        pendingOperation?.controller?.abort(new Error('The local LLM service is shutting down.'));
        closePromise = (async () => {
          await pendingOperation?.settlement;
          await modelSettlement;
          unregisterProvider?.();
          await closeSession(false);
        })();
      }
      await closePromise;
    },
  };
}
